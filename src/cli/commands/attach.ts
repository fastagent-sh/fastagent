/**
 * `fastagent attach <session> [dir]`: watch a session's live events from a running serve
 * (`config.sessionControl: true` → dev/start write `<stateRoot>/control.json`) and intervene from
 * stdin — the pair-programming loop of the session control plane, over the SAME wire protocol a Web
 * panel or desktop app uses (`connectSessionControl`).
 *
 * Typed lines dispatch as `steer` while a run is active; `/abort` aborts it. Reconnect-on-drop is
 * the standard client loop: backfill via `entries({ since })`, re-check `state()`, resubscribe.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../../env.ts";
import { resolveStateRoot } from "../../engines/pi/config.ts";
import { log, setLogLevel } from "../../log.ts";
import { connectSessionControl } from "../../session-remote.ts";
import type { SessionControl, SessionEvent } from "../../session.ts";
import { failStartup } from "../fail.ts";

export interface AttachOptions {
  /** Override the control endpoint (skip control.json discovery) — for a remote serve. */
  url?: string;
  token?: string;
}

/** Read the serving process's local discovery file. */
function discover(dir: string): { url: string; token: string } {
  const path = join(resolveStateRoot(dir), "control.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { url: string; token: string };
  } catch (error) {
    throw new Error(
      `cannot read ${path} (${(error as Error).message}) — is a serve with "sessionControl: true" running here? ` +
        `Or pass --url/--token for a remote one.`,
    );
  }
}

/** One-line rendering per event — a tail, not a TUI. */
function render(event: SessionEvent): string | undefined {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case "run_started":
      return `── run ${event.runId} started ──`;
    case "run_settled":
      return `── run settled: ${String(d.status)}${d.error ? ` (${(d.error as { message: string }).message})` : ""} ──`;
    case "message_delta":
      return undefined; // streamed raw below, not line-rendered
    case "message_started":
    case "message_finished":
      return undefined;
    case "tool_started":
      return `[tool ${String(d.name)} started]`;
    case "tool_finished":
      return `[tool ${(d.isError as boolean) ? "FAILED" : "done"}]`;
    case "queue_changed":
      return `[queue: steering ${String(d.steering)}, follow-up ${String(d.followUp)}]`;
    case "state_changed":
      return `[state: ${JSON.stringify(d)}]`;
    case "compaction_started":
      return "[compaction started]";
    case "compaction_finished":
      return `[compaction ${d.error ? `FAILED: ${String(d.error)}` : "done"}]`;
    default:
      return `[${event.type}]`;
  }
}

async function watch(control: SessionControl, session: string): Promise<void> {
  for await (const event of control.events(session)) {
    if (event.type === "message_delta") {
      const d = event.data as { channel: string; delta: string };
      if (d.channel === "text") process.stdout.write(d.delta);
      continue;
    }
    if (event.type === "message_finished") {
      process.stdout.write("\n");
      continue;
    }
    const line = render(event);
    if (line !== undefined) console.log(line);
  }
}

export async function runAttach(sessionArg: string, dirArg: string | undefined, opts: AttachOptions): Promise<void> {
  setLogLevel("info");
  const dir = resolve(dirArg ?? ".");
  loadDotEnv(dir);
  const endpoint = opts.url && opts.token ? { url: opts.url, token: opts.token } : discover(dir);
  const control = await connectSessionControl(endpoint).catch(failStartup);

  const state = await control.state(sessionArg);
  log.info(`[fastagent] attached to ${sessionArg} @ ${endpoint.url} — ${state.status}`);
  log.info(`[fastagent] type to steer the active run; /abort to stop it; Ctrl+C to detach`);

  // stdin → control plane. Acceptance is not outcome: a rejection prints the code and moves on.
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const command =
      trimmed === "/abort" ? ({ type: "abort" } as const) : ({ type: "steer", prompt: { text: trimmed } } as const);
    void control.dispatch(sessionArg, command).then(
      (result) => {
        if (result.ok) console.log(`[${command.type} accepted]`);
        else console.log(`[${command.type} rejected: ${result.error.code} — ${result.error.message}]`);
      },
      (error) => console.log(`[${command.type} failed: ${String(error)}]`),
    );
  });

  // The standard remote-client loop: the events iterator ends on drop/restart/gap → backfill from
  // the durable cursor, re-check state, resubscribe. Ctrl+C is the only exit.
  let cursor = (await control.entries(sessionArg)).leafEntryId;
  for (;;) {
    await watch(control, sessionArg).catch((error) => log.warn(`[fastagent] event stream error: ${String(error)}`));
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const backfill = await control.entries(sessionArg, cursor !== undefined ? { since: cursor } : undefined);
      if (backfill.entries.length > 0) {
        cursor = backfill.leafEntryId ?? cursor;
        console.log(
          `[reconnected — ${backfill.entries.length} entr${backfill.entries.length === 1 ? "y" : "ies"} while away]`,
        );
      }
    } catch (error) {
      log.warn(`[fastagent] reconnect failed (serve down?): ${String(error)}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
