/**
 * `fastagent login` without a terminal, for a script or a coding agent. Each question a provider's sign-in asks is
 * answered by the next line of stdin, in the order asked, a choice by its id; a question stdin has no line for refuses
 * ({@link LoginNeedsAnswer}) naming what it asks. A browser sign-in waits for the provider's own callback, and takes the
 * code or address it ends on from stdin when one comes. What a person would read, and the address a browser should
 * open, are handed to `say`.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { LoginIO } from "../harnesses/models/login.ts";

/** A question of the sign-in that stdin did not answer. */
export class LoginNeedsAnswer extends Error {}

/** What the sign-in tells whoever runs it: a line to read, or an address to open. */
export type LoginNotice = { type: "note"; message: string } | { type: "open"; url: string };

export function scriptedLoginIO(input: Readable, say: (notice: LoginNotice) => void): LoginIO {
  const next = lineReader(input);
  return {
    async select(message, options) {
      const choices = options.map((option) => option.value).join(", ");
      const line = (await next())?.trim();
      if (line === undefined) {
        throw new LoginNeedsAnswer(`the sign-in asks "${message}": answer on stdin with one of ${choices}`);
      }
      const chosen = options.find(
        (option) => option.value === line || option.label.toLowerCase() === line.toLowerCase(),
      );
      if (chosen === undefined) throw new LoginNeedsAnswer(`"${line}" answers no choice of "${message}": ${choices}`);
      return chosen.value;
    },
    async prompt(message, opts = {}) {
      const line = await next(opts.signal, opts.manual === true);
      if (line === undefined && !opts.signal?.aborted) {
        throw new LoginNeedsAnswer(`the sign-in asks "${message}": pass the answer on stdin, one line per question`);
      }
      return line;
    },
    note: (message) => say({ type: "note", message }),
    openUrl: (url) => say({ type: "open", url }),
  };
}

/**
 * The lines of `input`, read only once one is asked for. `next(signal, wait)` resolves with the next line, or undefined
 * once `signal` aborts; at the end of `input` it resolves undefined, unless `wait`, which leaves it to `signal`.
 */
function lineReader(input: Readable): (signal?: AbortSignal, wait?: boolean) => Promise<string | undefined> {
  const queued: string[] = [];
  /** Each pending read, and whether the end of `input` leaves it waiting on its signal. */
  const waiting = new Map<(line: string | undefined) => void, boolean>();
  let ended = false;
  let reading = false;
  const start = () => {
    if (reading) return;
    reading = true;
    const lines = createInterface({ input });
    lines.on("line", (line) => {
      const [first] = waiting.keys();
      if (first === undefined) queued.push(line);
      else {
        waiting.delete(first);
        first(line);
      }
    });
    lines.on("close", () => {
      ended = true;
      for (const [settle, wait] of waiting) {
        if (wait) continue;
        waiting.delete(settle);
        settle(undefined);
      }
    });
  };
  return (signal, wait = false) => {
    start();
    if (queued.length > 0) return Promise.resolve(queued.shift());
    if (signal?.aborted) return Promise.resolve(undefined);
    if (ended && !wait) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const settle = (line: string | undefined) => {
        signal?.removeEventListener("abort", aborted);
        resolve(line);
      };
      const aborted = () => {
        waiting.delete(settle);
        resolve(undefined);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      // At the end of `input`, a waiting prompt is settled by its signal alone.
      if (!ended) waiting.set(settle, wait);
    });
  };
}
