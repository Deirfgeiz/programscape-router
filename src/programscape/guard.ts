/**
 * The only door to Programscape. Every request the sync makes (sign-in metadata, client registration, tokens,
 * revocation, and the MCP endpoint) goes through this fetch, which:
 * - refuses any URL that is not on https://programscape.com, so the Programscape token goes nowhere else, even if
 *   published metadata named another host;
 * - never follows a redirect, as the provider calls never do;
 * - gives up after a timeout.
 */
import type { FetchLike } from "../providers/index.js";

export const PROGRAMSCAPE_ORIGIN = "https://programscape.com";
export const PROGRAMSCAPE_MCP_URL = `${PROGRAMSCAPE_ORIGIN}/api/mcp`;
export const PROGRAMSCAPE_SCOPE = "plans";

/** A failure talking to Programscape during connect, sync or disconnect. Never carries the token. */
export class ProgramscapeError extends Error {
  /** "rejected": Programscape refused the credentials (a refresh or a call with the token). */
  readonly kind: "rejected" | "refused" | "unreachable" | "invalid";
  readonly status: number | undefined;

  constructor(kind: ProgramscapeError["kind"], message: string, status?: number) {
    super(message);
    this.name = "ProgramscapeError";
    this.kind = kind;
    this.status = status;
  }
}

export function isProgramscapeUrl(input: string | URL): boolean {
  try {
    const url = new URL(String(input));
    return url.origin === PROGRAMSCAPE_ORIGIN && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function programscapeFetch(base: FetchLike, timeoutMs: number): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isProgramscapeUrl(url)) {
      throw new ProgramscapeError("refused", "Refused a request to a host other than programscape.com.");
    }
    // One controller carries both the caller's signal and the timeout; its timer keeps it referenced until it fires.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`No answer within ${timeoutMs} ms`, "TimeoutError")), timeoutMs);
    timer.unref?.();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    const signal = controller.signal;
    const request: RequestInit =
      input instanceof Request
        ? { method: input.method, headers: input.headers, body: await input.text().catch(() => undefined), ...init }
        : { ...init };
    request.signal = signal;
    // Never follow a redirect: fetch would carry the Authorization header to wherever the Location names.
    request.redirect = "manual";
    let response: Response;
    try {
      response = await base(url, request);
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ProgramscapeError("unreachable", `Programscape did not answer within ${timeoutMs} ms.`);
      }
      throw new ProgramscapeError("unreachable", "Could not reach programscape.com.");
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProgramscapeError("refused", "Programscape answered with a redirect, which is not followed.", response.status || undefined);
    }
    return response;
  };
}
