/**
 * `fastagent attach <session> [dir]`: watch a session's live events from a running serve
 * (`config.sessionControl: true` → dev/start write `<stateRoot>/control.json`) and intervene from
 * stdin — the pair-programming loop of the session control plane, over the SAME wire protocol a Web
 * panel or desktop app uses (`connectSessionControl`).
 *
 * Typed lines dispatch as `steer` while a run is active; `/abort` aborts it. Reconnect-on-drop is
 * the standard client loop, one round per connection: resubscribe → backfill via `entries({ since })`
 * → re-check `state()` (rendered — status changes that happened while away are live-only events and
 * would otherwise be invisible) → drain live.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../../env.ts";
import { resolveStateRoot } from "../../engines/pi/config.ts";
import { log, setLogLevel } from "../../log.ts";
import { ControlRequestError, connectSessionControl } from "../../session-remote.ts";
import type { SessionControl, SessionEntry, SessionEvent } from "../../session.ts";
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

async function drainEvents(iterator: AsyncIterator<SessionEvent>, io: AttachIo): Promise<void> {
  for (;;) {
    const result = await iterator.next();
    if (result.done) return;
    const event = result.value;
    if (event.type === "message_delta") {
      const d = event.data as { channel: string; delta: string };
      if (d.channel === "text") io.write(d.delta);
      continue;
    }
    if (event.type === "message_finished") {
      io.write("\n");
      continue;
    }
    // A remote (or version-skewed) serve may send data shapes this renderer does not expect — a
    // rendering surprise degrades to the generic line, never breaks the watch loop.
    let line: string | undefined;
    try {
      line = render(event);
    } catch {
      line = `[${event.type}]`;
    }
    if (line !== undefined) io.println(line);
  }
}

export async function runAttach(sessionArg: string, dirArg: string | undefined, opts: AttachOptions): Promise<void> {
  setLogLevel("info");
  const dir = resolve(dirArg ?? ".");
  loadDotEnv(dir);
  // --url and --token travel together: a lone --url silently falling back to the LOCAL control.json
  // would attach (and steer!) a same-named local session while the user believes they are remote.
  if ((opts.url === undefined) !== (opts.token === undefined)) {
    failStartup(new Error("--url and --token must be given together (one without the other is ambiguous)"));
  }
  let endpoint: { url: string; token: string };
  try {
    endpoint = opts.url && opts.token ? { url: opts.url, token: opts.token } : discover(dir);
  } catch (error) {
    failStartup(error as Error); // a user-fixable startup problem: one line, not a stack trace
  }
  const discovered = !(opts.url && opts.token);
  const control = await connectSessionControl(endpoint).catch((error: Error) =>
    failStartup(
      discovered
        ? new Error(
            `${error.message} — <stateRoot>/control.json may be stale (the serve that wrote it is gone); ` +
              `restart the serve or delete the file`,
          )
        : error,
    ),
  );

  const state = await control
    .state(sessionArg)
    .catch((error: unknown) =>
      exitWith(
        isAuthError(error)
          ? new Error(`the control endpoint rejected the token (${String(error)}) — re-run attach`)
          : (error as Error),
      ),
    );
  log.info(`[fastagent] attached to ${sessionArg} @ ${endpoint.url} — ${state.status}`);
  if (state.leafEntryId === undefined && state.status === "idle") {
    // A typo'd id and a fresh session render identically otherwise (sessions are lazily created by
    // invoke) — give the human a corrective signal.
    log.warn(`[fastagent] no durable record for "${sessionArg}" yet — a new session, or a typo?`);
  }
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

  // Every round has ONE shape: subscribe → backfill (render the durable record since the cursor)
  // → drain live until the stream drops. Subscribing first + the server's eager registration
  // (subscribed before response headers) covers the cursor→subscription window in the normal case;
  // the 300ms wait is a HEURISTIC — on a very slow link an event can still land between the
  // backfill and the subscription taking effect, surfacing only at the next drop-triggered replay.
  // Live events carry no entry ids, so the cursor advances only on backfill; a replay may overlap
  // what was already seen live — labeled, not silently dropped or miscounted. Ctrl+C is the only
  // exit; a 401 means the serve restarted and minted a new token — unrecoverable here, so exit
  // with the re-attach hint instead of retrying forever.
  const stale = (error: unknown): never =>
    exitWith(
      new Error(
        `the control endpoint rejected the token (${String(error)}) — the serve likely restarted with a new one; re-run attach`,
      ),
    );
  // `state` already carries the cursor — fetching the FULL record just to read leafEntryId would
  // download the whole history of a long session for nothing.
  let cursor = state.leafEntryId;
  for (;;) {
    try {
      cursor = await attachRound(control, sessionArg, cursor, {
        println: (line) => console.log(line),
        write: (chunk) => process.stdout.write(chunk),
        warn: (line) => log.warn(line),
        settleMs: 300,
      });
    } catch (error) {
      if (isAuthError(error)) stale(error);
      log.warn(`[fastagent] round failed: ${String(error)}`);
    }
    await new Promise((r) => setTimeout(r, 1_000)); // the stream dropped — pause, then resubscribe
  }
}

const isAuthError = (error: unknown): boolean => error instanceof ControlRequestError && error.status === 401;

/** `failStartup` borrowed for its print-one-line-and-exit behavior — attach can fail long after
 *  startup (a serve restart hours in), so the local name must not imply "startup only". */
const exitWith = failStartup;

/** What one round prints through — the COMPLETE output seam (streamed deltas included), so tests
 *  can observe every path a round writes. */
export interface AttachIo {
  println: (line: string) => void;
  /** Raw chunk, no newline — the streamed message_delta path. */
  write: (chunk: string) => void;
  warn: (line: string) => void;
  /** The subscribe→sync settle heuristic (see the round comment). Tests shrink it. */
  settleMs: number;
}

/**
 * ONE attach round: subscribe → backfill (render the durable record since `cursor`) → drain live
 * until the stream drops. Returns the advanced cursor. Subscribing first + the server's eager
 * registration (subscribed before response headers) covers the cursor→subscription window in the
 * normal case; `settleMs` is a HEURISTIC — on a very slow link an event can still land between the
 * backfill and the subscription taking effect, surfacing only at the next round's replay. Live
 * events carry no entry ids, so the cursor advances only on backfill; a replay may overlap what
 * was already seen live — labeled, not silently dropped. A 401 (stale token after a serve restart)
 * is thrown to the caller: unrecoverable here, never retried silently.
 */
export async function attachRound(
  control: SessionControl,
  session: string,
  cursor: string | undefined,
  io: AttachIo,
): Promise<string | undefined> {
  // The round HOLDS its subscription's iterator: one round = one stream, on every path — a
  // backfill failure must close it before propagating, or the caller's retry round would stack a
  // second concurrent stream interleaving the same session's output.
  const iterator = control.events(session)[Symbol.asyncIterator]();
  let authError: unknown;
  const draining = drainEvents(iterator, io).catch((error) => {
    if (isAuthError(error)) {
      authError = error;
      return;
    }
    io.warn(`[fastagent] event stream error: ${String(error)}`);
  });
  await new Promise((r) => setTimeout(r, io.settleMs)); // let the subscription land before syncing
  let backfill: Awaited<ReturnType<SessionControl["entries"]>>;
  try {
    backfill = await control.entries(session, cursor !== undefined ? { since: cursor } : undefined);
  } catch (error) {
    await iterator.return?.(undefined)?.catch?.(() => {});
    await draining;
    throw error;
  }
  const next = backfill.leafEntryId ?? cursor;
  if (backfill.entries.length > 0) {
    io.println("[replaying the record since the last sync (may overlap what you saw live)]");
    for (const entry of backfill.entries) {
      let line: string | undefined;
      try {
        line = renderEntry(entry);
      } catch {
        line = `[${entry.kind}]`;
      }
      if (line !== undefined) io.println(line);
    }
    io.println("[end of replay]");
  }
  // The protocol's reconnect step the replay cannot cover: status changes while away are LIVE-only
  // events (state_changed before a restart is neither replayed nor re-emitted) — re-check and show.
  const now = await control.state(session);
  io.println(`[live — ${now.status}${now.activeRunId ? ` (run ${now.activeRunId})` : ""}]`);
  await draining;
  if (authError) throw authError; // the stream's 401 is the round's 401
  return next;
}

/** Render one durable record on replay — the guaranteed kind vocabulary; other kinds are skipped. */
function renderEntry(entry: SessionEntry): string | undefined {
  const d = entry.data as Record<string, unknown>;
  switch (entry.kind) {
    case "user":
      return `> ${String(d.text)}`;
    case "assistant":
      return String(d.text);
    case "tool":
      return `[tool ${String(d.toolName)} ${(d.isError as boolean) ? "FAILED" : "done"}]`;
    default:
      return undefined;
  }
}
