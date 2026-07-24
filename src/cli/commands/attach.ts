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
import { resolveStateRoot, resolveWorkspace } from "../../engines/pi/config.ts";
import { log, setLogLevel } from "../../log.ts";
import { ABORTED_CODE, SESSION_BUSY_CODE } from "../../agent.ts";
import { NO_ACTIVE_RUN_CODE } from "../../session.ts";
import { ControlRequestError, connectAgent, connectSessionControl } from "../../session-remote.ts";
import type { SessionControl, SessionEntry, SessionEvent, SessionState } from "../../session.ts";
import { failStartup, failStartupOn } from "../fail.ts";

export interface AttachOptions {
  /** Override the control endpoint (skip control.json discovery) — for a remote serve. */
  url?: string;
  token?: string;
}

/** Read the serving process's local discovery file. */
function discover(dir: string): { url: string; token: string } {
  const path = join(resolveStateRoot(dir), "control.json");
  try {
    // Parse-don't-validate: the file is external input (hand-edited, older format, partial write).
    // A missing token would otherwise become `Bearer undefined` → 401 → a misleading diagnosis.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; token?: unknown };
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") {
      throw new Error("missing url/token fields");
    }
    return { url: parsed.url, token: parsed.token };
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
      // aborted is a deliberate stop (this attach's /abort or another client's) — not a failure.
      return `[compaction ${d.aborted ? "aborted" : d.error ? `FAILED: ${String(d.error)}` : "done"}]`;
    default:
      return `[${event.type}]`;
  }
}

async function drainEvents(iterator: AsyncIterator<SessionEvent>, io: AttachIo): Promise<number> {
  // Only close a line we actually opened: message_finished fires for EVERY assistant message
  // (pure tool-call and pure thinking ones included), and an unconditional newline would dilute a
  // multi-tool run's output with blank lines.
  let wroteText = false;
  let consumed = 0;
  for (;;) {
    const result = await iterator.next();
    if (result.done) return consumed;
    consumed++;
    const event = result.value;
    if (event.type === "message_delta") {
      const d = event.data as { channel: string; delta: string };
      if (d.channel === "text") {
        io.write(d.delta);
        wroteText = true;
      }
      continue;
    }
    if (event.type === "message_finished") {
      if (wroteText) io.write("\n");
      wroteText = false;
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
  const { root: dir } = failStartupOn(() => resolveWorkspace(resolve(dirArg ?? ".")));
  loadDotEnv(dir);
  // --url and --token travel together, and BOTH must be non-empty: a lone --url (or an empty
  // token) silently falling back to the LOCAL control.json would attach (and steer!) a same-named
  // local session while the user believes they are remote. One predicate decides — the guard and
  // the endpoint selection must never disagree on what "given" means.
  const remote = opts.url !== undefined || opts.token !== undefined;
  if (remote && !(opts.url && opts.token)) {
    failStartup(new Error("--url and --token must be given together and non-empty"));
  }
  // For a discovered endpoint the FIRST read joins the startup budget below: the dev-watch
  // restart window has two halves — control.json unlinked (not yet rewritten) and port not yet
  // bound — and dying instantly on the first half would contradict the grace the second half gets.
  let endpoint!: { url: string; token: string };
  if (remote) endpoint = { url: opts.url as string, token: opts.token as string };
  const discovered = !remote;
  // ONE policy for both phases: startup and the round loop gather the same facts (errorFacts)
  // and route them through decideRound with their phase — the local-401-unchanged diagnosis, the
  // reattach-on-changed-credentials rule, and every budget claim exist exactly once, tested.
  const errorFacts = (error: unknown): RoundOutcome => {
    let discovery: "unchanged" | "changed" | "unavailable" = "unavailable";
    let fresh: { url: string; token: string } | undefined;
    if (discovered && endpoint) {
      try {
        const read = discover(dir);
        if (read.url === endpoint.url && read.token === endpoint.token) discovery = "unchanged";
        else {
          discovery = "changed";
          fresh = read;
        }
      } catch {
        // Absent or torn — possibly mid-restart; budgets decide, never this read alone.
      }
    }
    return { type: "error", error, isAuth: isAuthError(error), discovery, fresh };
  };
  const connectWithGrace = async (): Promise<{ control: SessionControl; state: SessionState }> => {
    const startedAt = Date.now();
    for (;;) {
      try {
        if (!endpoint) endpoint = discover(dir); // discovered: the first read shares the budget
        const connected = await connectSessionControl(endpoint);
        return { control: connected, state: await connected.state(sessionArg) };
      } catch (error) {
        const decision = decideRound(errorFacts(error), {
          discovered,
          downMs: Date.now() - startedAt,
          phase: "startup",
        });
        if (decision.kind === "exit") exitWith(new Error(decision.message));
        // try-reattach at startup = adopt the fresh credentials; the next loop iteration connects.
        if (decision.kind === "try-reattach") endpoint = decision.fresh;
        else if (decision.kind === "retry") log.warn(decision.warn);
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
    // `/` is a reserved command prefix: a typo'd /aboort silently steering the model (injecting a
    // prompt when the user meant to STOP the run) is the dangerous direction of the ambiguity.
    if (trimmed.startsWith("/") && trimmed !== "/abort") {
      console.log(`[unknown command ${trimmed} — /abort stops the run; a leading / is reserved]`);
      return;
    }
    const command =
      trimmed === "/abort" ? ({ type: "abort" } as const) : ({ type: "steer", prompt: { text: trimmed } } as const);
    void control.dispatch(sessionArg, command).then(
      (result) => {
        if (result.ok) {
          console.log(`[${command.type} accepted]`);
        } else if (command.type === "steer" && result.error.code === NO_ACTIVE_RUN_CODE) {
          // The invoke stream attach holds IS this run's driver (design: disconnect = cancel), so
          // unlike channel-started runs, this one dies with the attach. Say so up front.
          // Intent, not fact: admission may still fail (session_busy — the lease could be held
          // by a compaction or another client's run); startRun's own lines report the outcome,
          // and promising "detaching will cancel it" for a run that never starts would be a lie.
          console.log("[no active run — trying to start one; if it starts, detaching (Ctrl+C) cancels it]");
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
  // exit; failure dispositions (401, budgets, reattach) live in decideRound.
  // Initial cursor: `state.leafEntryId` is the ACTIVE-PATH leaf, not an append-order position —
  // an approximation of "now" that avoids downloading the whole history just to find the tail. In
  // a branched record (compaction leaves abandoned branches) the first replay may include a few
  // post-leaf appends; advancement below is append-order, so it does not repeat.
  let cursor = state.leafEntryId;
  // LIVENESS IS PROBED, NEVER INFERRED FROM THE FILE: control.json is advisory — briefly absent
  // during a dev-watch restart (unlink → new worker rewrites seconds later) and stale after a
  // crash (no handler ran) — so its presence is neither necessary nor sufficient. The one state
  // machine for local endpoints: every failed round re-reads discovery (a CHANGED file → reattach
  // with the fresh credentials — 401s from an old token against a restarted serve heal here too);
  // otherwise a consecutive-failure budget decides — reset by any successful round or reattach,
  // exhausted → exit with the honest ambiguous diagnosis. --url endpoints keep plain retries with
  // immediate 401 exit: their token lifecycle is the operator's, not a local boot's.
  let failingSince: number | undefined;
  for (;;) {
    // Gather this round's FACTS (IO), then let decideRound (pure, tested) pick the disposition.
    let outcome: RoundOutcome;
    try {
      const round = await attachRound(control, sessionArg, cursor, {
        println: (line) => console.log(line),
        write: (chunk) => process.stdout.write(chunk),
        warn: (line) => log.warn(line),
      });
      cursor = round.cursor;
      outcome = round.sawProgress ? { type: "progress" } : { type: "empty" };
    } catch (error) {
      // A failed round may still have advanced the cursor (backfill rendered before the stream
      // error) — keep the progress or every retry replays the same records in full.
      const advanced = roundCursor(error);
      if (advanced !== undefined) cursor = advanced;
      outcome = errorFacts(error);
    }
    if (outcome.type !== "progress") failingSince ??= Date.now();
    const decision = decideRound(outcome, {
      discovered,
      downMs: failingSince === undefined ? 0 : Date.now() - failingSince,
    });
    switch (decision.kind) {
      case "reset":
        failingSince = undefined;
        break; // healthy round; still pause below before resubscribing
      case "exit":
        exitWith(new Error(decision.message));
        break;
      case "try-reattach": {
        // The decision says the credentials changed (a restarted serve mints fresh ones); whether
        // the new endpoint is READY yet is an IO fact only the connect can tell.
        const fresh = decision.fresh;
        try {
          const next = await connectSessionControl(fresh);
          endpoint = fresh;
          control = next;
          remoteAgent = connectAgent(fresh);
          failingSince = undefined;
          console.log("[serve restarted — reattached]");
          continue; // straight into the next round, no pause
        } catch (reconnectError) {
          // Mid-restart (file written, port not bound yet): the budget keeps us patient.
          log.warn(`[fastagent] serve restarting? reattach not ready: ${String(reconnectError)}`);
        }
        break;
      }
      case "retry":
        log.warn(decision.warn);
        break;
    }
    await new Promise((r) => setTimeout(r, 1_000)); // the stream dropped — pause, then resubscribe
  }
}

const LOCAL_GRACE_MS = 30_000;
// Remote endpoints get a LARGER budget (real networks recover slowly), but not an infinite one:
// steady-state and startup differ on priors, not on principle — at startup nothing has ever
// succeeded (a wrong --url is likelier than a transient → fail fast), while a drop after a
// working attach is likelier transient → retry, bounded. Wall-clock like STARTUP_GRACE_MS: a
// round's duration varies by an order of magnitude (fast ECONNREFUSED ≈ 1s vs the 10s black-hole
// timeout), so counting rounds would make the "~Ns" claims false exactly when they matter.
// Startup patience covers the dev-watch restart window's two halves — control.json unlinked (not
// yet rewritten) and port not yet bound — with discovery re-read each retry.
const REMOTE_GRACE_MS = 120_000;
const STARTUP_GRACE_MS = 15_000;

/** One round's observed facts, gathered by the loop (IO) and judged by {@link decideRound} (pure). */
export type RoundOutcome =
  | { type: "progress" }
  /** Clean end that delivered nothing — indistinguishable from a half-dead proxy closing every stream. */
  | { type: "empty" }
  | {
      type: "error";
      error: unknown;
      isAuth: boolean;
      /** discover(dir) compared against the current endpoint; remote endpoints report "unavailable". */
      discovery: "unchanged" | "changed" | "unavailable";
      /** The freshly discovered credentials when {@link discovery} is "changed". */
      fresh?: { url: string; token: string };
    };

export type RoundDecision =
  | { kind: "reset" }
  | { kind: "exit"; message: string }
  | { kind: "try-reattach"; fresh: { url: string; token: string } }
  | { kind: "retry"; warn: string };

/**
 * The reconnect policy for BOTH phases (`startup` = connectWithGrace, `steady` = the round loop),
 * pure and testable: every exit diagnosis and budget claim lives here. `downMs` is wall-clock time
 * since the phase's anchor (first connect attempt / first non-progress round). The phases differ
 * on priors, not principle: startup has never succeeded (short budget; a remote non-auth error
 * exits at once), steady-state had a working attach (longer budgets); the local-401-unchanged
 * diagnosis and reattach-on-changed-credentials apply identically to both.
 */
export function decideRound(
  outcome: RoundOutcome,
  ctx: { discovered: boolean; downMs: number; phase?: "startup" | "steady" },
): RoundDecision {
  const startup = ctx.phase === "startup";
  const limitMs = startup ? STARTUP_GRACE_MS : ctx.discovered ? LOCAL_GRACE_MS : REMOTE_GRACE_MS;
  const downSeconds = Math.round(ctx.downMs / 1000);
  if (outcome.type === "progress") return { kind: "reset" };
  if (outcome.type === "empty") {
    // Not health: an endpoint answering 200 and closing every stream immediately (buffering
    // proxy, half-dead tunnel) would otherwise loop forever with the budget never ticking.
    if (ctx.downMs >= limitMs) {
      return {
        kind: "exit",
        message: `the endpoint keeps closing the event stream immediately with nothing delivered (~${downSeconds}s) — a buffering proxy or half-dead tunnel? Re-run attach when the path is fixed`,
      };
    }
    return {
      kind: "retry",
      warn: `[fastagent] stream closed with nothing delivered (~${downSeconds}s / ${limitMs / 1000}s limit)`,
    };
  }
  if (!ctx.discovered) {
    // --url mode: re-running with the SAME token would just 401 again — name the real remedy
    // (at startup the shorter "check --token": the token came from the command line seconds ago).
    if (outcome.isAuth) {
      return {
        kind: "exit",
        message: startup
          ? `the control endpoint rejected the token (${String(outcome.error)}) — check --token`
          : `the control endpoint rejected the token (${String(outcome.error)}) — obtain the current token from the serve (its <stateRoot>/control.json) and re-run with --token`,
      };
    }
    // Startup: nothing has ever succeeded on this endpoint — a wrong --url is likelier than a
    // transient, so fail fast instead of burning a budget.
    if (startup) {
      return { kind: "exit", message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
    }
    if (ctx.downMs >= limitMs) {
      return {
        kind: "exit",
        message: `the remote endpoint has been unreachable for ~${downSeconds}s — check the serve and re-run attach`,
      };
    }
    return {
      kind: "retry",
      warn: `[fastagent] round failed (down ~${downSeconds}s, limit ${limitMs / 1000}s): ${String(outcome.error)}`,
    };
  }
  // Local: changed credentials mean a restarted serve — reattach BEFORE any 401 verdict (a fresh
  // boot mints a fresh token, so this round's 401 may already be stale).
  if (outcome.discovery === "changed" && outcome.fresh) return { kind: "try-reattach", fresh: outcome.fresh };
  // 401 with UNCHANGED control.json is reachable-and-rejecting — the file may belong to another
  // (or dead) serve on this port — and must exit with that fact, not burn budget toward "unreachable".
  if (outcome.isAuth && outcome.discovery === "unchanged") {
    return {
      kind: "exit",
      message:
        "the endpoint rejected the token though control.json is unchanged — the file may belong to " +
        "another (or dead) serve on this port; restart the serve and re-run attach",
    };
  }
  if (ctx.downMs >= limitMs) {
    return {
      kind: "exit",
      message: startup
        ? `${String(outcome.error)} — the serve is unreachable; it may be down, not yet started, or <stateRoot>/control.json is stale. Start (or restart) the serve and re-run attach.`
        : `the serve has been unreachable for ~${downSeconds}s — it may have crashed (stale control.json) or shut down; restart it and re-run attach`,
    };
  }
  return {
    kind: "retry",
    warn: startup
      ? `[fastagent] serve not ready (~${downSeconds}s) — retrying…`
      : `[fastagent] round failed (down ~${downSeconds}s, limit ${limitMs / 1000}s): ${String(outcome.error)}`,
  };
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
): Promise<{ cursor: string | undefined; sawProgress: boolean }> {
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
    // warn buffers too: a stream-error warn is not user-action feedback (the stdin exemption), and
    // an interleaved warn would break the replay block's contiguity the same as any other line.
    warn: (line) => (hold ? void pending.push(() => io.warn(line)) : io.warn(line)),
  };
  let authError: unknown;
  let streamError: unknown;
  let liveCount = 0;
  const draining = drainEvents(iterator, liveIo)
    .then((n) => {
      liveCount = n;
    })
    .catch((error) => {
      if (isAuthError(error)) {
        authError = error;
        return;
      }
      // Recorded and RETHROWN at round end: a stream error (protocol mismatch, dropped transport)
      // must fail the round so the caller's budget ticks — a warn-and-succeed round would loop a
      // permanent mismatch forever. Through liveIo: this warn is concurrent with the replay block
      // and must respect its buffering like every other drain-side line.
      streamError = error;
      liveIo.warn(`[fastagent] event stream error: ${String(error)}`);
    });
  await new Promise((r) => setTimeout(r, settleMs)); // let the subscription land before syncing
  // The WHOLE post-subscribe sync (backfill + state re-check) shares one failure discipline: close
  // this round's stream and drain before propagating — an exception escaping with the subscription
  // alive would stack a second concurrent stream on the caller's retry.
  let next = cursor;
  let sawBackfill = false;
  try {
    const backfill = await control.entries(session, cursor !== undefined ? { since: cursor } : undefined);
    sawBackfill = backfill.entries.length > 0;
    // Advance by APPEND ORDER (the last returned record), never by leafEntryId: `since` is an
    // append-position cursor (design §7), and a leaf that sits before later appends (abandoned
    // branches) would make every reconnect permanently replay the same tail.
    next = backfill.entries.at(-1)?.id ?? cursor;
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
    // The stream's 401 outranks this round's transient sync error (restart window: old connection
    // rejected while the port is still unbound) — auth facts must not degrade to transients.
    throw withCursor(authError ?? error, next);
  }
  release();
  await draining;
  if (authError) throw withCursor(authError, next); // the stream's 401 is the round's 401
  if (streamError) throw withCursor(streamError, next); // and its protocol/transport error is the round's failure
  // sawProgress feeds the caller's budget: a clean end that delivered NOTHING (no live events, no
  // backfill) is indistinguishable from a half-dead proxy closing every stream immediately — the
  // caller must not treat it as health.
  return { cursor: next, sawProgress: liveCount > 0 || sawBackfill };
}

/**
 * A failed round still carries its cursor progress: the backfill may have completed (rendered and
 * advanced) before the stream error surfaced — discarding the advancement would make every retry
 * round replay the same records in full until the budget runs out. The caller reads it back via
 * {@link roundCursor}.
 */
function withCursor(error: unknown, cursor: string | undefined): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  return Object.assign(e, { attachCursor: cursor });
}

/** The cursor a failed round reached, if it recorded one. */
export function roundCursor(error: unknown): string | undefined {
  return (error as { attachCursor?: string }).attachCursor;
}

/** Render one durable record on replay — the guaranteed kind vocabulary; other kinds are skipped. */
function renderEntry(entry: SessionEntry): string | undefined {
  const d = entry.data as Record<string, unknown>;
  switch (entry.kind) {
    case "user":
      return `> ${String(d.text)}`;
    case "assistant": {
      // Same rule as the live path's wroteText: a tool-only assistant record has empty text —
      // printing it would fill a multi-tool run's replay with blank lines.
      const assistantText = String(d.text ?? "");
      return assistantText === "" ? undefined : assistantText;
    }
    case "tool":
      return `[tool ${String(d.toolName)} ${(d.isError as boolean) ? "FAILED" : "done"}]`;
    default:
      return undefined;
  }
}
