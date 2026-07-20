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
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../../env.ts";
import { resolveStateRoot } from "../../engines/pi/config.ts";
import { log, setLogLevel } from "../../log.ts";
import { ABORTED_CODE, SESSION_BUSY_CODE } from "../../agent.ts";
import { ControlRequestError, connectAgent, connectSessionControl } from "../../session-remote.ts";
import type { SessionControl, SessionEntry, SessionEvent, SessionState } from "../../session.ts";
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
  // --url and --token travel together, and BOTH must be non-empty: a lone --url (or an empty
  // token) silently falling back to the LOCAL control.json would attach (and steer!) a same-named
  // local session while the user believes they are remote. One predicate decides — the guard and
  // the endpoint selection must never disagree on what "given" means.
  const remote = opts.url !== undefined || opts.token !== undefined;
  if (remote && !(opts.url && opts.token)) {
    failStartup(new Error("--url and --token must be given together and non-empty"));
  }
  let endpoint: { url: string; token: string };
  try {
    endpoint = remote ? { url: opts.url as string, token: opts.token as string } : discover(dir);
  } catch (error) {
    failStartup(error as Error); // a user-fixable startup problem: one line, not a stack trace
  }
  const discovered = !remote;
  // The SAME patience the round loop applies, at startup: `attach` during a dev-watch restart's
  // 1–2s window (port not bound / control.json mid-rewrite) must wait it out, not exit with a
  // misleading "stale file" diagnosis while the serve is seconds from ready. Each retry re-reads
  // discovery (a restart mints fresh credentials mid-window). --url fails immediately — its
  // endpoint lifecycle is the operator's.
  const STARTUP_GRACE = 10; // ≈ 10s
  const connectWithGrace = async (): Promise<{ control: SessionControl; state: SessionState }> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const connected = await connectSessionControl(endpoint);
        return { control: connected, state: await connected.state(sessionArg) };
      } catch (error) {
        if (!discovered) {
          exitWith(
            isAuthError(error)
              ? new Error(`the control endpoint rejected the token (${String(error)}) — check --token`)
              : (error as Error),
          );
        }
        if (attempt >= STARTUP_GRACE) {
          exitWith(
            new Error(
              `${String(error)} — the serve is unreachable; it may be down, or <stateRoot>/control.json is stale. ` +
                `Start (or restart) the serve and re-run attach.`,
            ),
          );
        }
        try {
          endpoint = discover(dir);
        } catch {
          // Absent or torn — possibly mid-restart; the budget decides, never this read alone.
        }
        log.warn(`[fastagent] serve not ready (${attempt}/${STARTUP_GRACE}) — retrying…`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  };
  const startup = await connectWithGrace();
  let control = startup.control;
  const state = startup.state;
  log.info(`[fastagent] attached to ${sessionArg} @ ${endpoint.url} — ${state.status}`);
  if (state.leafEntryId === undefined && state.status === "idle") {
    // A typo'd id and a fresh session render identically otherwise (sessions are lazily created by
    // invoke) — give the human a corrective signal.
    log.warn(`[fastagent] no durable record for "${sessionArg}" yet — a new session, or a typo?`);
  }
  log.info(`[fastagent] type to steer the active run; /abort to stop it; Ctrl+C to detach`);

  // stdin → the two planes: a line steers the ACTIVE run; with no run to join (no_active_run) it
  // falls back to STARTING one over the remote data plane (`POST /control/invoke`) — try-steer-
  // then-prompt avoids a state() pre-check race. Acceptance is not outcome: rejections print and
  // move on. The invoke stream is drained silently (its content already renders via events); it
  // must be held open, though — disconnecting it cancels the run.
  let remoteAgent = connectAgent(endpoint);
  const startRun = async (text: string): Promise<void> => {
    // Drained quietly EXCEPT failures: a run that never started (transport 401/refused/404, wire
    // errors) surfaces only on this stream — the events plane has nothing to render. A run that
    // started and failed prints twice (here + run_settled) — the replay-overlap precedent: label,
    // never silently drop. connectAgent never throws (SPEC), so failures ARE these events.
    let sawBusy = false;
    for await (const e of remoteAgent.invoke({ session: sessionArg }, { text })) {
      if (e.type !== "failed") continue;
      if (e.code === SESSION_BUSY_CODE) sawBusy = true;
      else if (e.code !== ABORTED_CODE) console.log(`[prompt failed: ${e.details}]`);
      // ABORTED_CODE: a deliberate stop from ANY client (this attach's /abort, another attach, a
      // Web panel) — the settled line reports it either way; no source discrimination here.
    }
    // session_busy = the LEASE is held — by another run OR a boundary mutation (compact/set_model
    // contend on the same lease); "a run started" would be a guess, and "steer it" bad advice
    // against a compact. State the lease fact, promise nothing.
    if (sawBusy) console.log("[session busy — another run or a boundary operation holds it; try again shortly]");
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const command =
      trimmed === "/abort" ? ({ type: "abort" } as const) : ({ type: "steer", prompt: { text: trimmed } } as const);
    void control.dispatch(sessionArg, command).then(
      (result) => {
        if (result.ok) {
          console.log(`[${command.type} accepted]`);
        } else if (command.type === "steer" && result.error.code === "no_active_run") {
          // The invoke stream attach holds IS this run's driver (design: disconnect = cancel), so
          // unlike channel-started runs, this one dies with the attach. Say so up front.
          console.log("[no active run — starting one; detaching (Ctrl+C) will cancel it]");
          void startRun(trimmed).catch((error) => console.log(`[prompt failed: ${String(error)}]`));
        } else {
          console.log(`[${command.type} rejected: ${result.error.code} — ${result.error.message}]`);
        }
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
  // LIVENESS IS PROBED, NEVER INFERRED FROM THE FILE: control.json is advisory — briefly absent
  // during a dev-watch restart (unlink → new worker rewrites seconds later) and stale after a
  // crash (no handler ran) — so its presence is neither necessary nor sufficient. The one state
  // machine for local endpoints: every failed round re-reads discovery (a CHANGED file → reattach
  // with the fresh credentials — 401s from an old token against a restarted serve heal here too);
  // otherwise a consecutive-failure budget decides — reset by any successful round or reattach,
  // exhausted → exit with the honest ambiguous diagnosis. --url endpoints keep plain retries with
  // immediate 401 exit: their token lifecycle is the operator's, not a local boot's.
  const LOCAL_GRACE_ROUNDS = 30; // ≈ 30s+ of consecutive failures before giving up
  let failures = 0;
  for (;;) {
    try {
      cursor = await attachRound(control, sessionArg, cursor, {
        println: (line) => console.log(line),
        write: (chunk) => process.stdout.write(chunk),
        warn: (line) => log.warn(line),
      });
      failures = 0;
    } catch (error) {
      failures++;
      if (!discovered) {
        if (isAuthError(error)) stale(error);
        log.warn(`[fastagent] round failed: ${String(error)}`);
      } else {
        let reattached = false;
        try {
          const fresh = discover(dir);
          if (fresh.url !== endpoint.url || fresh.token !== endpoint.token) {
            try {
              const next = await connectSessionControl(fresh);
              endpoint = fresh;
              control = next;
              remoteAgent = connectAgent(fresh);
              failures = 0;
              reattached = true;
              console.log("[serve restarted — reattached]");
            } catch (reconnectError) {
              // Mid-restart (file written, port not bound yet): the budget keeps us patient.
              log.warn(`[fastagent] serve restarting? reattach not ready: ${String(reconnectError)}`);
            }
          }
        } catch {
          // Absent or torn — possibly mid-restart; the budget below decides, never this read alone.
        }
        if (reattached) continue; // straight into the next round, no pause
        if (failures >= LOCAL_GRACE_ROUNDS) {
          exitWith(
            new Error(
              `the serve has been unreachable for ~${LOCAL_GRACE_ROUNDS}s — it may have crashed (stale control.json) or shut down; restart it and re-run attach`,
            ),
          );
        }
        log.warn(`[fastagent] round failed (${failures}/${LOCAL_GRACE_ROUNDS}): ${String(error)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1_000)); // the stream dropped — pause, then resubscribe
  }
}

const isAuthError = (error: unknown): boolean => error instanceof ControlRequestError && error.status === 401;

/** `failStartup` borrowed for its print-one-line-and-exit behavior — attach can fail long after
 *  startup (a serve restart hours in), so the local name must not imply "startup only". */
const exitWith = failStartup;

/** What one ROUND prints through (streamed deltas included), so tests can observe every path a
 *  round writes. Round output only: stdin-side acceptance/rejection lines print directly — they
 *  are immediate feedback to a user action and may interleave with a replay block. Timing knobs
 *  travel as their own parameter. */
export interface AttachIo {
  println: (line: string) => void;
  /** Raw chunk, no newline — the streamed message_delta path. */
  write: (chunk: string) => void;
  warn: (line: string) => void;
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
  /** The subscribe→sync settle heuristic (see the round comment). Tests shrink it. */
  settleMs = 300,
): Promise<string | undefined> {
  // The round HOLDS its subscription's iterator: one round = one stream, on every path — a
  // backfill failure must close it before propagating, or the caller's retry round would stack a
  // second concurrent stream interleaving the same session's output.
  const iterator = control.events(session)[Symbol.asyncIterator]();
  // Live output is BUFFERED while the replay block prints, then flushed — the drain runs
  // concurrently with the backfill, and interleaving raw deltas into the labeled replay would make
  // both unreadable; the [end of replay] label is only honest if the block is contiguous.
  let hold = true;
  const pending: (() => void)[] = [];
  const release = (): void => {
    hold = false;
    for (const emit of pending) emit();
    pending.length = 0;
  };
  const liveIo: AttachIo = {
    println: (line) => (hold ? void pending.push(() => io.println(line)) : io.println(line)),
    write: (chunk) => (hold ? void pending.push(() => io.write(chunk)) : io.write(chunk)),
    warn: io.warn,
  };
  let authError: unknown;
  const draining = drainEvents(iterator, liveIo).catch((error) => {
    if (isAuthError(error)) {
      authError = error;
      return;
    }
    io.warn(`[fastagent] event stream error: ${String(error)}`);
  });
  await new Promise((r) => setTimeout(r, settleMs)); // let the subscription land before syncing
  // The WHOLE post-subscribe sync (backfill + state re-check) shares one failure discipline: close
  // this round's stream and drain before propagating — an exception escaping with the subscription
  // alive would stack a second concurrent stream on the caller's retry.
  let next = cursor;
  try {
    const backfill = await control.entries(session, cursor !== undefined ? { since: cursor } : undefined);
    next = backfill.leafEntryId ?? cursor;
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
    // The protocol's reconnect step the replay cannot cover: status changes while away are
    // LIVE-only events (state_changed before a restart is neither replayed nor re-emitted).
    const now = await control.state(session);
    io.println(`[live — ${now.status}${now.activeRunId ? ` (run ${now.activeRunId})` : ""}]`);
  } catch (error) {
    release(); // buffered live output must not be lost on the failure path
    await iterator.return?.(undefined)?.catch?.(() => {});
    await draining;
    throw error;
  }
  release();
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
