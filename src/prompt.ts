/**
 * A hidden prompt: reads one line from a terminal in raw mode, so nothing typed or pasted is echoed.
 * Raw mode works the same in macOS and Linux terminals and in Windows consoles (PowerShell, Windows Terminal, cmd).
 */

/** The parts of a TTY input stream the prompt needs (process.stdin satisfies it). */
export interface PromptInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface PromptOutput {
  write(text: string): unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelledError";
  }
}

/** Whether `input` is a terminal the hidden prompt can use. */
export function canPrompt(input: PromptInput): boolean {
  return input.isTTY === true && typeof input.setRawMode === "function";
}

/**
 * Shows `question` on `output` and reads one line from `input` without echoing it. Enter (or Ctrl-D) ends the line,
 * Backspace deletes, Ctrl-C cancels (rejects with PromptCancelledError). Terminal escape sequences, such as arrow
 * keys, are dropped. Only a newline is printed after the answer, never the answer.
 */
export function readHidden(question: string, input: PromptInput, output: PromptOutput): Promise<string> {
  return readLine(question, input, output, false);
}

/**
 * Like readHidden, but shows what is typed: for answers that aren't secrets (a yes or no, a number from a list, a zone
 * name). Rejects with PromptCancelledError on Ctrl-C.
 */
export function readVisible(question: string, input: PromptInput, output: PromptOutput): Promise<string> {
  return readLine(question, input, output, true);
}

function readLine(question: string, input: PromptInput, output: PromptOutput, echo: boolean): Promise<string> {
  if (!canPrompt(input)) return Promise.reject(new Error("Not a terminal."));
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let value = "";
    let escape = false;

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (escape) {
          // Drop a CSI sequence (ESC [ ... final byte) or a two-character escape.
          if (char !== "[" && !/[0-9;?]/.test(char)) escape = false;
          continue;
        }
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new PromptCancelledError());
        if (char === "\u001b") {
          escape = true;
          continue;
        }
        if (char === "\u007f" || char === "\b") {
          if (echo && value.length > 0) output.write("\b \b");
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (char < " ") continue;
        if (echo) output.write(char);
        value += char;
      }
    };

    output.write(question);
    input.setEncoding("utf8");
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}

/** Reads everything piped to `input` and returns its first line, for `keys set --stdin`. */
export async function readFirstLine(input: AsyncIterable<string | Buffer>): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    if (/[\r\n]/.test(text)) break;
  }
  // A byte-order mark can lead text piped from some Windows shells.
  return (text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "");
}
