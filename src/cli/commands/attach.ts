/**
 * `fastagent attach <session> [dir]`: watch a session's live events from a running serve (`config.sessionControl:
 * true` → dev/start write `<stateRoot>/control.json`) and intervene from stdin — the pair-programming loop of the
 * session control plane, over the SAME wire protocol a Web panel or desktop app uses (`connectSessionControl`).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { log, setLogLevel } from "../../log.ts";
import { ABORTED_CODE, SESSION_BUSY_CODE } from "../../agent.ts";
import {
  NO_ACTIVE_RUN_CODE,
  type AgentCommand,
  type SessionControl,
  type SessionEntry,
  type SessionEvent,
  type SessionState,
} from "../../session.ts";
import { ControlRequestError, connectAgent, connectSessionControl } from "../../session-remote.ts";
import { failStartup, placementOrExit } from "../fail.ts";

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
  // Only close a line we actually opened: message_finished fires for EVERY assistant message (pure tool-call and pure
  // thinking ones included), and an unconditional newline would dilute a multi-tool run's output with blank lines.
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
    // A remote (or version-skewed) serve may send data shapes this renderer does not expect — a rendering surprise
    // degrades to the generic line, never breaks the watch loop.
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
  // --url and --token travel together, and BOTH must be non-empty.
  const remote = opts.url !== undefined || opts.token !== undefined;
  if (remote && !(opts.url && opts.token)) {
    failStartup(new Error("--url and --token must be given together and non-empty"));
  }
  // A REMOTE attach reads nothing under `dir`.
  const dir = remote ? resolve(dirArg ?? ".") : placementOrExit(resolve(dirArg ?? ".")).agentDir;
  if (!remote) loadDotEnv(dir);
  // For a discovered endpoint the FIRST read joins the startup budget below: the dev-watch restart window has two
  // halves.
  let endpoint!: { url: string; token: string };
  if (remote) endpoint = { url: opts.url as string, token: opts.token as string };
  const discovered = !remote;
  // ONE policy for both phases: startup and the round loop gather the same facts (errorFacts) and route them through
  // decideRound with their phase.
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
        return { control: connected, state: await connected.sessions.get(sessionArg).state() };
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
    // A typo'd id and a fresh session render identically otherwise (sessions are lazily created by invoke) — give the
    // human a corrective signal.
    log.warn(`[fastagent] no durable record for "${sessionArg}" yet — a new session, or a typo?`);
  }
  log.info(
    `[fastagent] type to steer the active run; /abort to stop it; /commands to list what this agent defines; Ctrl+C to detach`,
  );

  // stdin → the two planes: a line steers the ACTIVE run.
  let remoteAgent = connectAgent(endpoint);
  const startRun = async (text: string): Promise<void> => {
    // Drained quietly EXCEPT failures: a run that never started (transport 401/refused/404, wire errors) surfaces
    // only on this stream — the events plane has nothing to render.
    let sawBusy = false;
    for await (const e of remoteAgent.invoke({ session: sessionArg }, { text })) {
      if (e.type !== "failed") continue;
      if (e.code === SESSION_BUSY_CODE) sawBusy = true;
      else if (e.code !== ABORTED_CODE) console.log(`[prompt failed: ${e.details}]`);
      // ABORTED_CODE: a deliberate stop from ANY client (this attach's /abort, another attach, a Web panel).
    }
    // session_busy = the LEASE is held — by another run OR a boundary mutation (compact/update contend on the same
    // lease).
    if (sawBusy) console.log("[session busy — another run or a boundary operation holds it; try again shortly]");
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    // `/` is a reserved command prefix: a typo'd /aboort silently steering the model (injecting a prompt when the
    // user meant to STOP the run) is the dangerous direction of the ambiguity.
    if (trimmed.startsWith("/") && trimmed !== "/abort") {
      void answerSlashInput(trimmed, control, (l) => console.log(l));
      return;
    }
    const stopping = trimmed === "/abort";
    const label = stopping ? "abort" : "steer";
    const session = control.sessions.get(sessionArg);
    void (stopping ? session.abort() : session.steer({ text: trimmed })).then(
      (result) => {
        if (result.ok) {
          console.log(`[${label} accepted]`);
        } else if (!stopping && result.error.code === NO_ACTIVE_RUN_CODE) {
          // The invoke stream attach holds IS this run's driver (design: disconnect = cancel), so unlike
          // channel-started runs, this one dies with the attach.
          console.log("[no active run — trying to start one; if it starts, detaching (Ctrl+C) cancels it]");
          void startRun(trimmed).catch((error) => console.log(`[prompt failed: ${String(error)}]`));
        } else {
          console.log(`[${label} rejected: ${result.error.code} — ${result.error.message}]`);
        }
      },
      (error: unknown) => console.log(`[${label} failed: ${String(error)}]`),
    );
  });

  // Every round has ONE shape: subscribe → backfill (render the durable record since the cursor) → drain live until
  // the stream drops.
  let cursor = state.leafEntryId;
  // LIVENESS IS PROBED, NEVER INFERRED FROM THE FILE: control.json is advisory.
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
      // A failed round may still have advanced the cursor (backfill rendered before the stream error) — keep the
      // progress or every retry replays the same records in full.
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
        // The decision says the credentials changed (a restarted serve mints fresh ones); whether the new endpoint is
        // READY yet is an IO fact only the connect can tell.
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
// Remote endpoints get a LARGER budget (real networks recover slowly), but not an infinite one: steady-state and
// startup differ on priors, not on principle.
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
 * The reconnect policy for BOTH phases (`startup` = connectWithGrace, `steady` = the round loop), pure and testable:
 * every exit diagnosis and budget claim lives here.
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
    // Not health: an endpoint answering 200 and closing every stream immediately (buffering proxy, half-dead tunnel)
    // would otherwise loop forever with the budget never ticking.
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
    // --url mode: re-running with the SAME token would just 401 again.
    if (outcome.isAuth) {
      return {
        kind: "exit",
        message: startup
          ? `the control endpoint rejected the token (${String(outcome.error)}) — check --token`
          : `the control endpoint rejected the token (${String(outcome.error)}) — obtain the current token from the serve (its <stateRoot>/control.json) and re-run with --token`,
      };
    }
    // Startup: nothing has ever succeeded on this endpoint — a wrong --url is likelier than a transient, so fail fast
    // instead of burning a budget.
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
  // Local: changed credentials mean a restarted serve — reattach BEFORE any 401 verdict (a fresh boot mints a fresh
  // token, so this round's 401 may already be stale).
  if (outcome.discovery === "changed" && outcome.fresh) return { kind: "try-reattach", fresh: outcome.fresh };
  // 401 with UNCHANGED control.json is reachable-and-rejecting.
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

/** `failStartup` borrowed for its print-one-line-and-exit behavior. */
const exitWith = failStartup;

/** What one ROUND prints through (streamed deltas included), so tests can observe every path a round writes. */
export interface AttachIo {
  println: (line: string) => void;
  /** Raw chunk, no newline — the streamed message_delta path. */
  write: (chunk: string) => void;
  warn: (line: string) => void;
}

/** The backfill slice REDUCED TO THE ACTIVE PATH. */
export function activePathSlice(entries: SessionEntry[], leafEntryId: string | undefined): SessionEntry[] {
  if (leafEntryId === undefined) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  // An append always moves the leaf, so a leaf BEHIND the slice means every entry in it was appended and then
  // abandoned — a leaf move backwards with no new turn since.
  if (!byId.has(leafEntryId)) return [];
  const onPath = new Set<string>();
  for (let cur = byId.get(leafEntryId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    if (onPath.has(cur.id)) break;
    onPath.add(cur.id);
  }
  return entries.filter((e) => onPath.has(e.id));
}

/** Answer a RESERVED-SLASH line (anything starting with `/` that is not `/abort`). */
export async function answerSlashInput(
  trimmed: string,
  control: Pick<SessionControl, "commands">,
  println: (line: string) => void,
): Promise<void> {
  // The first WORD is the token: slash input naturally carries arguments (`/triage my inbox`), and taking the whole
  // line would answer "names nothing" for a name the user did give.
  const word = trimmed.slice(1).split(/\s+/)[0] ?? "";
  const listing = word === "commands";
  if (!listing) println("[a leading / is reserved — /abort stops the run, /commands lists what this agent defines]");
  let commands: AgentCommand[];
  try {
    commands = await control.commands();
  } catch (error) {
    println(`[command list unavailable: ${error}]`);
    return;
  }
  if (listing) {
    // `description` is what makes a listing usable — a bare name tells the author nothing they did not already know
    // from the directory.
    const listed = commands.map((c) => (c.description ? `${c.name} — ${c.description}` : c.name));
    println(listed.length ? `[this agent defines: ${listed.join("; ")}]` : "[this agent defines no names]");
    return;
  }
  const hit = commands.find((c) => c.name === word);
  println(
    hit
      ? `[${hit.name} is a ${hit.source}${hit.description ? ` — ${hit.description}` : ""}; name it in a normal message, without the /]`
      : `[/${word} names nothing this agent defines]`,
  );
}

/**
 * ONE attach round: subscribe → backfill (render the durable record since `cursor`) → drain live until the stream
 * drops.
 */
export async function attachRound(
  control: SessionControl,
  session: string,
  cursor: string | undefined,
  io: AttachIo,
  /** The subscribe→sync settle heuristic (see the round comment). */
  settleMs = 300,
): Promise<{ cursor: string | undefined; sawProgress: boolean }> {
  // The round HOLDS its subscription's iterator: one round = one stream, on every path.
  const iterator = control.sessions.get(session).events()[Symbol.asyncIterator]();
  // Live output is BUFFERED while the replay block prints, then flushed.
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
    // warn buffers too: a stream-error warn is not user-action feedback (the stdin exemption), and an interleaved
    // warn would break the replay block's contiguity the same as any other line.
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
      // Recorded and RETHROWN at round end: a stream error (protocol mismatch, dropped transport) must fail the round
      // so the caller's budget ticks.
      streamError = error;
      liveIo.warn(`[fastagent] event stream error: ${String(error)}`);
    });
  await new Promise((r) => setTimeout(r, settleMs)); // let the subscription land before syncing
  // The WHOLE post-subscribe sync (backfill + state re-check) shares one failure discipline: close this round's
  // stream and drain before propagating.
  let next = cursor;
  let sawBackfill = false;
  try {
    const backfill = await control.sessions.get(session).entries(cursor !== undefined ? { since: cursor } : undefined);
    sawBackfill = backfill.entries.length > 0;
    // Advance by APPEND ORDER (the last returned record), never by leafEntryId.
    next = backfill.entries.at(-1)?.id ?? cursor;
    // Cursor advancement is APPEND ORDER over the whole slice; RENDERING is the active path only.
    const replay = activePathSlice(backfill.entries, backfill.leafEntryId);
    if (replay.length > 0) {
      io.println("[replaying the record since the last sync (may overlap what you saw live)]");
      for (const entry of replay) {
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
    // The protocol's reconnect step the replay cannot cover: status changes while away are LIVE-only events
    // (state_changed before a restart is neither replayed nor re-emitted).
    const now = await control.sessions.get(session).state();
    io.println(`[live — ${now.status}${now.activeRunId ? ` (run ${now.activeRunId})` : ""}]`);
  } catch (error) {
    release(); // buffered live output must not be lost on the failure path
    await iterator.return?.(undefined)?.catch?.(() => {});
    await draining;
    // The stream's 401 outranks this round's transient sync error (restart window: old connection rejected while the
    // port is still unbound).
    throw withCursor(authError ?? error, next);
  }
  release();
  await draining;
  if (authError) throw withCursor(authError, next); // the stream's 401 is the round's 401
  if (streamError) throw withCursor(streamError, next); // and its protocol/transport error is the round's failure
  // sawProgress feeds the caller's budget: a clean end that delivered NOTHING (no live events, no backfill) is
  // indistinguishable from a half-dead proxy closing every stream immediately — the caller must not treat it as
  // health.
  return { cursor: next, sawProgress: liveCount > 0 || sawBackfill };
}

/**
 * A failed round still carries its cursor progress: the backfill may have completed (rendered and advanced) before the
 * stream error surfaced.
 */
function withCursor(error: unknown, cursor: string | undefined): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  return Object.assign(e, { attachCursor: cursor });
}

/** The cursor a failed round reached, if it recorded one. */
function roundCursor(error: unknown): string | undefined {
  return (error as { attachCursor?: string }).attachCursor;
}

/** Render one durable record on replay — the guaranteed kind vocabulary; other kinds are skipped. */
function renderEntry(entry: SessionEntry): string | undefined {
  const d = entry.data as Record<string, unknown>;
  switch (entry.kind) {
    case "user":
      return `> ${String(d.text)}`;
    case "assistant": {
      // Same rule as the live path's wroteText: a tool-only assistant record has empty text — printing it would fill
      // a multi-tool run's replay with blank lines.
      const assistantText = String(d.text ?? "");
      return assistantText === "" ? undefined : assistantText;
    }
    case "tool":
      return `[tool ${String(d.toolName)} ${(d.isError as boolean) ? "FAILED" : "done"}]`;
    default:
      return undefined;
  }
}
