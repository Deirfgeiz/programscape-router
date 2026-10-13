/**
 * The zone step of `programscape-router keys set brightdata`: every Bright Data call names a zone in the founder's
 * account as well as the key, one for search (a SERP API zone) and one for page reads (a Web Unlocker API zone).
 *
 * Dave, October 12, 2026: "Find, then offer to create". After the key is saved, the router lists the account's zones
 * and takes the search (`type: "serp"`) and page-read (`type: "unblocker"`) ones, asking which when there are several
 * of a kind. When one is missing, it asks before creating it, and creates nothing unless the answer is yes. Zone names
 * are not secrets. They go in zones.json in the config folder, never config.json, which 1.1.0 and earlier would refuse
 * to start with (see zonesPath). BRIGHTDATA_SERP_ZONE and BRIGHTDATA_UNLOCKER_ZONE, and config
 * `providers.brightdata.zones`, win over it.
 *
 * Live (October 12): a key without Admin permission lists `[]`, not an error, so an empty list leads to asking for the
 * names, never to "you have no zones". Creating a zone needs an Admin or Ops key, and its answer holds the zone's proxy
 * password: nothing of it is read or shown (see createZone).
 *
 * Without a terminal (`--stdin`) nothing is asked and nothing is created: `--search-zone` and `--scrape-zone` name the
 * zones, and a capability without one is filled from the zone list only when the list has exactly one of its kind.
 */
import { ConfigError, type RouterConfig, loadConfig, saveZones, zoneName, zonesFor } from "./config.js";
import { type PromptInput, type PromptOutput, readVisible } from "./prompt.js";
import { type BrightDataZone, ZONE_NAMES, ZONE_TYPES, brightdata, createZone, listZones } from "./providers/brightdata.js";
import { type CallContext, type FetchLike, ProviderCallError } from "./providers/http.js";
import { CAPABILITIES, type Capability } from "./types.js";

export interface ZoneIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface ZoneSetupOptions {
  key: string;
  env: Record<string, string | undefined>;
  /** Where the config lookup starts, to say when config.json's own zones win over the ones saved. */
  cwd: string;
  fetch: FetchLike;
  /** Zones named on the command line (`--search-zone`, `--scrape-zone`), already checked. */
  given: Partial<Record<Capability, string>>;
  /** The terminal to ask on, or undefined without one (`--stdin`): then nothing is asked or created. */
  terminal?: { input: PromptInput; output: PromptOutput };
}

const WORDS: Readonly<Record<Capability, string>> = { search: "search", scrape: "page reads" };
const PRODUCT: Readonly<Record<Capability, string>> = { search: "SERP API", scrape: "Web Unlocker API" };
const FLAGS: Readonly<Record<Capability, string>> = { search: "--search-zone", scrape: "--scrape-zone" };
const NAME_HINT = "Each zone's name is at the top of its page in Bright Data, under Web Access API.";
const ZONE_TIMEOUT_MS = 15_000;

/** Reads `--search-zone <name>` and `--scrape-zone <name>` out of `args`, removing them. A bad name is an error. */
export function takeZoneFlags(args: string[]): { given: Partial<Record<Capability, string>>; error?: string } {
  const given: Partial<Record<Capability, string>> = {};
  for (const capability of CAPABILITIES) {
    const index = args.indexOf(FLAGS[capability]);
    if (index === -1) continue;
    const value = args[index + 1];
    args.splice(index, 2);
    const parsed = zoneName.safeParse(value ?? "");
    if (!parsed.success) return { given, error: `${FLAGS[capability]} needs a zone name, such as ${ZONE_NAMES[capability]} (letters, digits, _ and -).` };
    given[capability] = parsed.data;
  }
  return { given };
}

/** Asks for one line, at most three times, until `accept` returns a value; undefined when the founder gives up. */
async function ask<T>(question: string, terminal: NonNullable<ZoneSetupOptions["terminal"]>, accept: (answer: string) => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await readVisible(question, terminal.input, terminal.output)).trim();
    const value = accept(answer);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Asks for a zone's name; blank skips it. */
async function askName(capability: Capability, terminal: NonNullable<ZoneSetupOptions["terminal"]>): Promise<string | undefined> {
  const blank = Symbol("blank");
  const answer = await ask<string | typeof blank>(
    `Name of your ${PRODUCT[capability]} zone for ${WORDS[capability]} (blank to skip): `,
    terminal,
    (text) => (text === "" ? blank : zoneName.safeParse(text).success ? text : undefined),
  );
  return typeof answer === "string" ? answer : undefined;
}

/** Picks one of several zones of a kind by number. */
async function choose(capability: Capability, zones: BrightDataZone[], terminal: NonNullable<ZoneSetupOptions["terminal"]>): Promise<string | undefined> {
  const list = zones.map((zone, index) => `  ${index + 1}. ${zone.name}`).join("\n");
  terminal.output.write(`Your account has ${zones.length} ${PRODUCT[capability]} zones. Which one should ${WORDS[capability]} use?\n${list}\n`);
  return ask(`Number (1-${zones.length}): `, terminal, (text) => {
    const index = Number(text);
    return Number.isInteger(index) && index >= 1 && index <= zones.length ? zones[index - 1]?.name : undefined;
  });
}

/**
 * Finds, offers to create, or asks for each zone Bright Data needs, then saves them in config. Returns the exit code:
 * 0 when every zone is set up (or overridden by its environment variable), 1 otherwise. Prints only zone names,
 * statuses and our own words: never the key, and nothing from a zone-creation answer.
 */
export async function setUpBrightDataZones(io: ZoneIo, options: ZoneSetupOptions): Promise<number> {
  const ctx: CallContext = { key: options.key, fetch: options.fetch, timeoutMs: ZONE_TIMEOUT_MS };
  const envVars = brightdata.zoneEnvVars ?? {};
  const chosen: Partial<Record<Capability, string>> = { ...options.given };
  const fromEnv = CAPABILITIES.filter((capability) => !chosen[capability] && (options.env[envVars[capability] ?? ""]?.trim() ?? "") !== "");
  const wanted = () => CAPABILITIES.filter((capability) => !chosen[capability] && !fromEnv.includes(capability));
  const terminal = options.terminal;

  if (wanted().length > 0) {
    let zones: BrightDataZone[] | undefined;
    try {
      zones = await listZones(ctx);
    } catch (error) {
      const failure = error instanceof ProviderCallError ? error : undefined;
      if (failure?.outcome === "unauthorized") {
        io.stderr(`Bright Data refused this key when listing its zones${failure.status ? ` (HTTP ${failure.status})` : ""}. Check the key, then run \`programscape-router keys set brightdata\` again.\n`);
        return 1;
      }
      io.stderr(`Couldn't list your Bright Data zones (${failure?.outcome ?? "unexpected error"}).\n`);
    }

    if (zones !== undefined && zones.length > 0) {
      for (const capability of wanted()) {
        const ofKind = zones.filter((zone) => zone.type === ZONE_TYPES[capability]);
        if (ofKind.length === 1) chosen[capability] = ofKind[0]?.name;
        else if (ofKind.length > 1 && terminal) chosen[capability] = await choose(capability, ofKind, terminal);
        else if (ofKind.length > 1) io.stderr(`Your account has several ${PRODUCT[capability]} zones; name one with ${FLAGS[capability]}.\n`);
      }
      // Missing from a list that has zones: offer to create, and create only on yes.
      const missing = wanted().filter((capability) => !zones.some((zone) => zone.type === ZONE_TYPES[capability]));
      if (missing.length > 0 && terminal) {
        const names = missing.map((capability) => `${ZONE_NAMES[capability]} (${WORDS[capability]})`).join(" / ");
        const yes = await ask(
          `Create ${names} in your Bright Data account? Free-tier credits cover them; nothing is bought. [y/N] `,
          terminal,
          (text) => (/^(y|yes)$/i.test(text) ? true : /^(n|no|)$/i.test(text) ? false : undefined),
        );
        if (yes === true) {
          for (const capability of missing) {
            try {
              await createZone(ctx, ZONE_NAMES[capability], capability);
              chosen[capability] = ZONE_NAMES[capability];
              io.stdout(`Created ${ZONE_NAMES[capability]} for ${WORDS[capability]} in your Bright Data account.\n`);
            } catch (error) {
              const status = error instanceof ProviderCallError ? error.status : undefined;
              io.stderr(
                status === 401 || status === 403
                  ? `Bright Data didn't let this key create ${ZONE_NAMES[capability]} (HTTP ${status}): creating zones needs an Admin key. You can create the zone in Bright Data's dashboard instead, under Web Access API, then enter its name here.\n`
                  : `Bright Data didn't create ${ZONE_NAMES[capability]}${status ? ` (HTTP ${status})` : ""}. You can create it in Bright Data's dashboard instead, under Web Access API, then enter its name here.\n`,
              );
            }
          }
        } else {
          io.stdout("Nothing was created.\n");
        }
      }
    } else if (zones !== undefined) {
      // Live, a key without Admin permission sees an empty list, so this says nothing about the account.
      io.stdout(`Bright Data listed no zones for this key (a key without Admin permission sees none). ${terminal ? NAME_HINT : ""}\n`.replace(" \n", "\n"));
    }

    if (terminal && wanted().length > 0) {
      // The empty-list line above already gave the hint.
      if (zones === undefined || zones.length > 0) terminal.output.write(`${NAME_HINT}\n`);
      for (const capability of wanted()) {
        const name = await askName(capability, terminal);
        if (name) chosen[capability] = name;
      }
    }
  }

  const toSave = Object.fromEntries(CAPABILITIES.flatMap((capability) => (chosen[capability] ? [[capability, chosen[capability]]] : []))) as Partial<
    Record<Capability, string>
  >;
  if (Object.keys(toSave).length > 0) {
    try {
      const path = saveZones(options.env, "brightdata", toSave);
      const named = CAPABILITIES.filter((capability) => toSave[capability]).map((capability) => `${WORDS[capability]} ${toSave[capability]}`);
      io.stdout(`Saved the Bright Data zones in ${path}: ${named.join(", ")}.\n`);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      const names = CAPABILITIES.filter((capability) => toSave[capability]).map((capability) => `${envVars[capability]}=${toSave[capability]}`);
      io.stderr(`${error.message}\nSet them in your environment instead: ${names.join(" ")}\n`);
      return 1;
    }
  }
  let config: RouterConfig = {};
  try {
    config = loadConfig(options.env as NodeJS.ProcessEnv, options.cwd).config;
  } catch {
    // A config that can't be read is the router's to report; it doesn't change what was saved.
  }
  const configZones = config.providers?.brightdata?.zones ?? {};
  for (const capability of CAPABILITIES) {
    const zone = configZones[capability];
    if (zone && !fromEnv.includes(capability) && zone !== toSave[capability]) {
      io.stdout(`Your config file's providers.brightdata.zones names ${zone} for ${WORDS[capability]}, and it wins over zones.json.\n`);
    }
  }
  for (const capability of fromEnv) {
    io.stdout(`${envVars[capability]} is set in this environment, so ${WORDS[capability]} use that zone (it wins over config).\n`);
  }
  // What the router will use now: this run's zones, and any saved before or named in config or the environment.
  const effective = zonesFor(brightdata, config, options.env);
  const notSetUp = CAPABILITIES.filter((capability) => !effective[capability]);
  for (const capability of notSetUp) {
    io.stderr(
      `No ${PRODUCT[capability]} zone is set up, so Bright Data won't be used for ${WORDS[capability]}. ` +
        (terminal ? "Run `programscape-router keys set brightdata` again" : `Run \`programscape-router keys set brightdata\` in a terminal, or pass ${FLAGS[capability]} <name>`) +
        ` (or set ${envVars[capability]}).\n`,
    );
  }
  return notSetUp.length === 0 ? 0 : 1;
}
