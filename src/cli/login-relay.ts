/**
 * `fastagent login` split across a process boundary: the flow runs on a deployed box, and the owner's terminal renders
 * it. The wire is {@link LoginIO} itself, one JSON object per line: the box sends what the flow asks and says
 * (`select`, `prompt`, `abort`, `note`, `open`) and ends with ONE `result` line; the terminal answers each question by
 * its id. The box holds the PKCE verifier and writes the credential; the terminal only shows and answers.
 *
 * The `result` line is the only success signal. A host's shell can drop the session and still exit 0 (Railway was
 * seen doing so), so an ended stream without that line is a failure, whatever the exit code says.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { IoOption, LoginIO, LoginMethod } from "../harnesses/pi/login.ts";

/** How a login on the box ended, as the box reports it. */
export type RelayResult =
  /** Logged in now: `method` is how, `path` where the box saved it. */
  | { ok: true; provider: string; method: LoginMethod; path: string }
  /**
   * `--if-missing`: the box already authenticates the provider and was left alone. `source` is what does it, as the
   * box's startup report names it (`OAuth`, `stored credential`, or an environment variable such as `OPENAI_API_KEY`).
   */
  | { ok: true; provider: string; kept: string }
  | { ok: false; reason: "cancelled" | "missing" | "failed"; message: string };

type BoxMessage =
  | { type: "select"; id: number; message: string; options: IoOption[] }
  | { type: "prompt"; id: number; message: string; hidden: boolean }
  | { type: "abort"; id: number }
  | { type: "note"; message: string }
  | { type: "open"; url: string }
  | ({ type: "result" } & RelayResult);

/** The terminal's answer to one question; `null` means the person backed out. */
interface Answer {
  id: number;
  value: string | null;
}

const send = (out: Writable, message: BoxMessage | Answer): void => void out.write(`${JSON.stringify(message)}\n`);

/**
 * The box half: a {@link LoginIO} over `input`/`output`. Once `input` ends (the session dropped), every pending and
 * later question reads as backed out, so the flow ends in `LoginCancelled` instead of waiting forever.
 */
export function stdioLoginIO(input: Readable, output: Writable): { io: LoginIO; result(result: RelayResult): void } {
  const pending = new Map<number, (value: string | undefined) => void>();
  let closed = false;
  let nextId = 1;
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    const answer = JSON.parse(line) as Answer;
    pending.get(answer.id)?.(answer.value ?? undefined);
    pending.delete(answer.id);
  });
  lines.on("close", () => {
    closed = true;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  });
  const ask = (message: (id: number) => BoxMessage, signal?: AbortSignal): Promise<string | undefined> => {
    if (closed) return Promise.resolve(undefined);
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send(output, message(id));
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          send(output, { type: "abort", id });
          resolve(undefined);
        },
        { once: true },
      );
    });
  };
  return {
    io: {
      select: (message, options) => ask((id) => ({ type: "select", id, message, options })),
      prompt: (message, opts) =>
        ask((id) => ({ type: "prompt", id, message, hidden: opts?.hidden === true }), opts?.signal),
      note: (message) => send(output, { type: "note", message }),
      openUrl: (url) => send(output, { type: "open", url }),
    },
    result: (result) => {
      send(output, { type: "result", ...result });
      lines.close(); // nothing more is read; lets the process exit once stdout drains
    },
  };
}

/**
 * The terminal half: drive `io` from what the box sends on `from`, answering on `to`. Resolves with the box's
 * `result` line when `from` ends, or `undefined` when it ended without one. A line that is not the wire (a host
 * CLI's banner, a shell's error) goes to `passthrough`, so nothing the box printed is lost.
 */
export function relayLogin(
  from: Readable,
  to: Writable,
  io: LoginIO,
  passthrough: (line: string) => void,
): Promise<RelayResult | undefined> {
  // The box may exit before reading an answer; its result (or its absence) is what gets reported, not the EPIPE.
  to.on("error", () => {});
  const answer = (id: number, value: string | undefined): void => send(to, { id, value: value ?? null });
  const prompts = new Map<number, AbortController>();
  let result: RelayResult | undefined;
  const lines = createInterface({ input: from });
  lines.on("line", (line) => {
    const message = parse(line);
    if (message === undefined) return passthrough(line);
    switch (message.type) {
      case "select":
        void io.select(message.message, message.options).then((value) => answer(message.id, value));
        return;
      case "prompt": {
        const controller = new AbortController();
        prompts.set(message.id, controller);
        void io.prompt(message.message, { hidden: message.hidden, signal: controller.signal }).then((value) => {
          prompts.delete(message.id);
          if (!controller.signal.aborted) answer(message.id, value);
        });
        return;
      }
      case "abort":
        prompts.get(message.id)?.abort();
        return;
      case "note":
        return io.note(message.message);
      case "open":
        return io.openUrl(message.url);
      case "result": {
        const { type: _, ...rest } = message;
        result = rest;
        return;
      }
    }
  });
  return new Promise((resolve) =>
    lines.on("close", () => {
      for (const controller of prompts.values()) controller.abort();
      resolve(result);
    }),
  );
}

const WIRE_TYPES = new Set(["select", "prompt", "abort", "note", "open", "result"]);

function parse(line: string): BoxMessage | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return typeof value.type === "string" && WIRE_TYPES.has(value.type) ? (value as BoxMessage) : undefined;
  } catch {
    return undefined; // not ours: a host CLI printed a line that happens to start with "{"
  }
}
