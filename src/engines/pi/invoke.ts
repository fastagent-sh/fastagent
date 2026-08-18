/**
 * The harness L0: fan pi AgentHarness's two ports (subscribe event side-channel + prompt final
 * value) into SPEC's single event stream, under a single-writer-per-session lease.
 *
 * The half that does not care which pi class runs the turn — lease, terminals, event queue, prompt
 * prep — is turn-kit.ts. What lives here is what only the harness has: its event vocabulary, translated ONCE
 * into the rich `SessionEvent` layer, and the observation plane that layer feeds.
 *
 * Concurrency: at most one in-flight turn per session; a second invoke fails fast with
 * `failed{retryable}` ("session busy"), leaving dedupe/queueing/steering to the channel. Each
 * invoke builds a fresh harness bound to the session and discards it (stateless multi-session).
 */
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, calculateContextTokens, shouldCompact } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  ABORTED_CODE,
  type Agent,
  type AgentEvent,
  type Json,
  type Prompt,
  type Scope,
  SESSION_BUSY_CODE,
} from "../../agent.ts";
import { type CancelHooks, cancellableStream } from "../../collect.ts";
import type { RetryScheduledEvent, RunSettledEvent, SessionEvent } from "../../session.ts";
import { log } from "../../log.ts";
import { TOOL_ACTIVATION_ENTRY, harnessSession, type PiHarnessFactory } from "./harness.ts";
import { EventQueue, type Lease, errorToTerminal, inProcessLease, toPiPromptOptions, toTerminal } from "./turn-kit.ts";
import { type ReadonlySessionManager, type ToolActivation, additiveActivation, turnContext } from "./tool-context.ts";

// ── Event translation: the single pi↔SPEC translation point ─────────────────
//
// `retryable` = worth re-sending with the same session (SPEC §6: advisory, not a session-atomicity
// guarantee). Classify from the STRUCTURED signal first, prose only as the last-resort ceiling. What
// is actually available differs by path, and the two are NOT symmetric:
//   - thrown error (errorToTerminal): an HTTP `.status`/`.statusCode` AND a network `.code` (incl.
//     `.cause.code`) — this is where a numeric status genuinely drives the decision.
//   - failed message (toTerminal): ONLY `diagnostics[].error.code`. pi's `DiagnosticErrorInfo` carries
//     a `code` (a network code, or a status delivered as a code), with no separate HTTP-status field —
//     so a message whose provider `code` is a string label (e.g. "rate_limit_exceeded") is not
//     decisive here and falls to prose.
// The prose fallback is bounded, not a cop-out: pi-ai already ran its own status-code-based client
// retries (harness.ts PROVIDER_MAX_RETRIES) before surfacing, so an error that reaches this point has
// already exhausted the cleanly-retryable cases. The regex is the narrow ceiling, not the classifier.
// Upstream ask: a first-class `retryable`/`kind` on pi's terminal error would retire the prose path
// entirely (mirrors the §11 "the deeper fix is upstream in pi" pattern).

/**
 * In-stream event mapping — pi events are translated ONCE into the rich `SessionEvent` vocabulary;
 * the SPEC `AgentEvent` stream is a narrow {@link projectAgentEvent} of it (design §6: one
 * translation plus one projection, never two parallel translations). pi events with no session
 * vocabulary yet (turn_start, agent_start, …) are dropped.
 */
export function toSessionEvent(pe: AgentHarnessEvent, runId: string): SessionEvent | null {
  const at = Date.now();
  switch (pe.type) {
    case "queue_update":
      return {
        type: "queue_changed",
        timestamp: at,
        runId,
        data: { steering: pe.steer.length, followUp: pe.followUp.length },
      };
    case "message_start":
      // Assistant streaming only — a user/toolResult message is not a live message boundary.
      if (pe.message.role !== "assistant") return null;
      return { type: "message_started", timestamp: at, runId, data: {} };
    case "message_update": {
      const ev = pe.assistantMessageEvent;
      if (ev.type === "text_delta") {
        return { type: "message_delta", timestamp: at, runId, data: { channel: "text", delta: ev.delta } };
      }
      if (ev.type === "thinking_delta") {
        return { type: "message_delta", timestamp: at, runId, data: { channel: "thinking", delta: ev.delta } };
      }
      return null;
    }
    case "message_end":
      if (pe.message.role !== "assistant") return null;
      return { type: "message_finished", timestamp: at, runId, data: {} };
    case "tool_execution_start":
      return {
        type: "tool_started",
        timestamp: at,
        runId,
        data: { id: pe.toolCallId, name: pe.toolName, args: pe.args as Json },
      };
    case "tool_execution_update":
      return {
        type: "tool_progress",
        timestamp: at,
        runId,
        data: { id: pe.toolCallId, name: pe.toolName, partialResult: pe.partialResult as Json },
      };
    case "tool_execution_end":
      return {
        type: "tool_finished",
        timestamp: at,
        runId,
        data: { id: pe.toolCallId, isError: pe.isError, content: pe.result as Json },
      };
    case "retry_scheduled": {
      // Summarization retry backoff (auto-compaction / branch summary, pi ≥0.81.1) — without it,
      // up to ~14s of backoff at the turn's tail reads as a hang. `retry_attempt_start`/
      // `retry_finished` stay dropped: they carry no outcome, and the next event is the closure.
      // Typed against the vocabulary (as is the second construction site, session-control's
      // manual-compact callback) so a payload change breaks both at compile time.
      const event: RetryScheduledEvent = {
        type: "retry_scheduled",
        timestamp: at,
        runId,
        data: {
          operation: pe.operation,
          attempt: pe.attempt,
          maxAttempts: pe.maxAttempts,
          delayMs: pe.delayMs,
          error: pe.errorMessage,
        },
      };
      return event;
    }
    default:
      return null;
  }
}

/** The SPEC projection of the rich stream. Events with no `AgentEvent` counterpart (progress,
 *  message boundaries, run boundaries) project to null — the invoke terminal is produced from the
 *  resolved message ({@link toTerminal}), not from `run_settled`. */
export function projectAgentEvent(se: SessionEvent): AgentEvent | null {
  switch (se.type) {
    case "message_delta": {
      const d = se.data as { channel: "text" | "thinking"; delta: string };
      return d.channel === "text" ? { type: "text", delta: d.delta } : { type: "thinking", delta: d.delta };
    }
    case "tool_started": {
      const d = se.data as { id: string; name: string; args: Json };
      return { type: "tool_started", id: d.id, name: d.name, args: d.args };
    }
    case "tool_finished": {
      const d = se.data as { id: string; isError: boolean; content: Json };
      return { type: "tool_ended", id: d.id, isError: d.isError, content: d.content };
    }
    case "retry_scheduled": {
      // `operation` (compaction | branch_summary) stays session-plane vocabulary — a turn renderer
      // only needs "transient failure, retrying"; the engine detail lives in the control plane.
      const d = se.data as { attempt: number; maxAttempts: number; delayMs: number; error: string };
      return { type: "retrying", attempt: d.attempt, maxAttempts: d.maxAttempts, delayMs: d.delayMs, reason: d.error };
    }
    default:
      return null;
  }
}

/** Live modulation handles for one active run — what the control plane's `dispatch` routes to.
 *  Built inside the invoke closure (it owns the harness); registered with the observer at
 *  run_started, gone after run_settled. RACE WINDOW (all three commands, symmetric): the run may
 *  resolve between the settled-check and the engine call landing — an accepted `abort` can still
 *  settle `completed`, and an accepted `steer`/`followUp` can settle without the prompt ever being
 *  consumed. Acceptance is not outcome; the settlement is the truth. */
export interface RunControls {
  steer(prompt: Prompt): Promise<void>;
  followUp(prompt: Prompt): Promise<void>;
  abort(): Promise<void>;
}

/** The DATA-plane observation seam: every rich event of every run, pushed as it happens. `run`
 *  carries the live {@link RunControls}, attached to the `run_started` event only. A hub
 *  (session-control.ts) implements this to serve `events()`/`state()`/`dispatch`; absent = zero
 *  overhead. Scope: RUN events only — the hub's own boundary-mutation events (`state_changed`,
 *  `compaction_*`) originate in the hub and reach full-vocabulary taps via the hub's `tap` option,
 *  not this seam. TRUST BOUNDARY: since Phase 2a this seam hands every wired observer the run's
 *  modulation handles — it is the trusted hub seam, not a public fan-out point. Do not wire
 *  untrusted taps here; give third parties the read-only `events()` stream instead. */
export type SessionObserver = (session: string, event: SessionEvent, run?: RunControls) => void;

type PiHarness = Awaited<ReturnType<PiHarnessFactory>>;

/** Bind the concrete pi-agent-core Session behind FastAgent's tool-runtime manager port. */
function toolSessionManager(sessionId: string, harness: PiHarness): ReadonlySessionManager | undefined {
  const session = harnessSession(harness);
  if (!session) return undefined;
  return {
    getSessionId: () => sessionId,
    async getHeader() {
      const metadata = await session.getMetadata();
      return { id: sessionId, timestamp: metadata.createdAt };
    },
    getBranch: () => session.getBranch(),
  };
}

/**
 * The turn's {@link ToolActivation} over the live harness. `activate` is additive and filters to the
 * registered names first — pi's `setActiveTools` THROWS on unknown names, and a loader must get a
 * usable "nothing new" answer, not an exception. pi persists the change in the session, so the
 * per-invoke restore (harness.ts) carries it into later turns.
 */
function toolActivation(harness: PiHarness): ToolActivation {
  // Serialize activations per turn: "who activated first" must be decided HERE, not by whether pi's
  // setActiveTools happens to mutate before its first await — parallel tool calls in one batch race
  // their activate() calls, and the addedToolNames load points must not double-stamp.
  let chain: Promise<string[]> = Promise.resolve([]);
  return {
    active: () => harness.getActiveTools().map((t) => t.name),
    registered: () => harness.getTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
    activate(names) {
      const run = async (): Promise<string[]> => {
        const current = harness.getActiveTools().map((t) => t.name);
        const added = additiveActivation(
          harness.getTools().map((t) => t.name),
          current,
          names,
        );
        if (added.length > 0) {
          await harness.setActiveTools([...current, ...added]);
          // Persist the DELTA in a dedicated entry — what the per-invoke resolve (harness.ts) reads.
          // pi's own active_tools_change record is a full snapshot and is deliberately ignored there.
          // Absent session (a harness built outside piHarnessFactory): in-turn activation still works,
          // it just isn't durable — the factory owns persistence.
          await harnessSession(harness)?.appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: added });
        }
        return added;
      };
      const result = chain.then(run, run); // run after the predecessor settles, success or failure
      chain = result.catch(() => []); // the caller sees a rejection on `result`; the chain stays usable
      return result;
    },
  };
}

/**
 * After a successful turn, compact the session if its context has grown past pi's threshold — a long
 * shared (group) or 1:1 conversation otherwise overflows the model's window. pi owns the mechanism
 * (`harness.compact()` writes a summary entry into the session, so the next reopen is compacted); the
 * bare harness does NOT auto-trigger it, so fastagent checks `shouldCompact` here and fires it. The
 * context size is the provider's own count from the turn's assistant message (`usage`).
 */
async function maybeCompact(harness: PiHarness, message: AssistantMessage): Promise<void> {
  const contextWindow = harness.getModel().contextWindow;
  if (!contextWindow) return;
  if (shouldCompact(calculateContextTokens(message.usage), contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    await harness.compact();
  }
}

// ── createPiAgentFromHarness ────────────────────────────────────────────────

export interface CreatePiAgentFromHarnessOptions {
  harnessFactory: PiHarnessFactory;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
  /** Observation-plane tap (see {@link SessionObserver}). Optional; invoke behavior is identical
   *  with or without it — the SPEC stream is a projection of what the observer sees. */
  observer?: SessionObserver;
  /** Working directory exposed to FastAgent-defined tools. Defaults to process.cwd(). */
  cwd?: string;
}

/** "From a harness factory": engine wired by the caller; adds only the concurrency/stream shell. */
export function createPiAgentFromHarness(options: CreatePiAgentFromHarnessOptions): Agent {
  const { harnessFactory, lease = inProcessLease(), observer } = options;

  // The cancellation protocol (SPEC MUST 3) lives in cancellableStream. Both halves matter here:
  // the DOOR settles a generator suspended on a quiet stream (a tool mid-execution) — the local
  // for-await pattern never hit that deadlock, but pull-driven consumers (the SSE handler's eager
  // reads) do — and the LATCH covers the window where the harness is still being built, where a
  // knock would land on an idle harness and the LATER run would ignore it.
  const invoke = (scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> =>
    cancellableStream((hooks) => turn(scope, prompt, hooks));

  async function* turn(
    scope: Scope,
    prompt: Prompt,
    { onCancelReady, wasCancelled }: CancelHooks,
  ): AsyncGenerator<AgentEvent> {
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      // Rejected BEFORE acceptance: no run exists, so the observer sees nothing (replay-safe).
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
        code: SESSION_BUSY_CODE,
      };
      return;
    }
    // The run exists from here: one run_started, exactly one run_settled. Terminal points only
    // RECORD the outcome; the settlement event is emitted in the outer finally, right before
    // release() — so the observation plane's "running" window equals the lease window (state()
    // must never say idle while a new invoke would still be rejected session_busy), and the
    // post-terminal auto-compaction is naturally inside the run. A run with no recorded outcome
    // was cancelled by the caller (SPEC: cancellation has no terminal event) → aborted.
    const runId = crypto.randomUUID();
    let outcome: RunSettledEvent["data"] | undefined;
    const observe = (event: SessionEvent | null, run?: RunControls): void => {
      if (!event || !observer) return;
      try {
        observer(scope.session, event, run);
      } catch (error) {
        // The observation plane must never break the data plane; a broken hub is its own problem.
        log.warn(`[fastagent] session observer threw (event ${event.type}): ${String(error)}`);
      }
    };
    // run_started must be observed before the (awaited) harness build so no early event outruns
    // registration — so the controls AWAIT the build instead of erroring on the assembling window:
    // a dispatch that races the build simply queues on the freshly built harness. A setup failure
    // rejects the gate (and the run settles failed); the guard keeps an undispatched rejection from
    // becoming an unhandled-rejection crash.
    let harnessReady!: (h: Awaited<ReturnType<PiHarnessFactory>>) => void;
    let harnessFailed!: (e: unknown) => void;
    const harnessGate = new Promise<Awaited<ReturnType<PiHarnessFactory>>>((resolve, reject) => {
      harnessReady = resolve;
      harnessFailed = reject;
    });
    harnessGate.catch(() => {}); // observed via controls only when a dispatch actually happens
    // Aborted classification has two attribution sources, either suffices: pi's own
    // stopReason:"aborted" (toTerminal), and control-plane INTENT — needed because providers do
    // not uniformly attribute an aborted stream (verified empirically: the faux path surfaces a
    // plain error). Intent = "an abort() succeeded, OR one was still in flight when the terminal
    // arrived" (the harness error often lands before abort() resolves). A rejected abort that
    // RETURNED before the terminal counts as nothing — no rollback dance, no interleaving hazard.
    // GUARANTEE BOUNDARY: an abort still in flight that ultimately rejects can classify a
    // concurrent real error as aborted — narrow, and non-lossy: the settlement carries
    // `error.message` either way.
    let abortsInFlight = 0;
    let abortSucceeded = false;
    // Stale-controls guard: after settlement pi's steer()/followUp()/abort() would still resolve
    // (they queue / no-op on the to-be-discarded harness) — a silent acceptance of a command that
    // can never take effect. The flag flips at THREE points, earliest wins: (1) the moment the
    // run's terminal is determined (the main window — before the consumer-paced `yield terminal`
    // and auto-compaction), (2) the setup-failure path, (3) the outer finally as the backstop for
    // caller cancellation. A post-settle call throws and the dispatcher maps it to
    // `run_command_failed`.
    let runSettled = false;
    const settledError = () => new Error("run already settled; the command cannot take effect");
    // The settled check and the harness call MUST share one synchronous block (no await between):
    // pi enqueues/aborts synchronously at method entry, so check-then-call in the same tick truly
    // closes the race — a check behind its own await boundary would only shrink it.
    const controls: RunControls = {
      async steer(p: Prompt) {
        const opts = await toPiPromptOptions(p);
        const harness = await harnessGate;
        if (runSettled) throw settledError();
        await harness.steer(p.text, opts);
      },
      async followUp(p: Prompt) {
        const opts = await toPiPromptOptions(p);
        const harness = await harnessGate;
        if (runSettled) throw settledError();
        await harness.followUp(p.text, opts);
      },
      async abort() {
        const harness = await harnessGate;
        if (runSettled) throw settledError();
        abortsInFlight++;
        try {
          await harness.abort();
          abortSucceeded = true;
        } finally {
          abortsInFlight--;
        }
      },
    };
    observe({ type: "run_started", timestamp: Date.now(), runId, data: {} }, controls);
    try {
      let harness: Awaited<ReturnType<PiHarnessFactory>>;
      try {
        // Scope's lineage extension flows to the store's CREATE path only — an existing session
        // opens exactly as before, whatever the scope names (inheritance is one-time by construction).
        harness = await harnessFactory(
          scope.session,
          scope.parentSession === undefined
            ? undefined
            : {
                parentSession: scope.parentSession,
                ...(scope.branchHints !== undefined ? { branchHints: scope.branchHints } : {}),
              },
        );
      } catch (error) {
        // Setup failures (session open / auth / …) MUST surface as a failed event, never a throw.
        harnessFailed(error); // a pending dispatch learns the run cannot take commands
        const terminal = errorToTerminal(error);
        outcome = { status: "failed", error: { message: terminal.details, retryable: terminal.retryable } };
        runSettled = true; // commands can no longer take effect — reject stale controls from here on
        yield terminal;
        return; // → outer finally emits the settlement
      }

      harnessReady(harness);
      // Arm the cancellation door (see invoke's wrapper): aborting the harness settles the run,
      // releasing any await the generator is parked on so a queued return() can reach the finally.
      onCancelReady(() => {
        void harness.abort().catch(() => {});
      });
      const queue = new EventQueue<AgentEvent>();
      const unsub = harness.subscribe((pe) => {
        // Summarization retries also warn to server logs: the session `retry_scheduled` event only
        // reaches attached observers, and an operator tailing logs must see the backoff too.
        if (pe.type === "retry_scheduled") {
          log.warn(
            `[fastagent] ${pe.operation} retry ${pe.attempt}/${pe.maxAttempts} in ${pe.delayMs}ms (session ${scope.session}): ${pe.errorMessage}`,
          );
        }
        const rich = toSessionEvent(pe, runId);
        if (!rich) return;
        observe(rich);
        const event = projectAgentEvent(rich);
        if (event) queue.push(event);
      });
      let completed: AssistantMessage | undefined; // the assistant message of a cleanly completed turn
      try {
        // Preparing the prompt lazy-loads the image pipeline and re-encodes every attachment, so it
        // both takes time and can throw BEFORE any engine work exists to fail — and a throw here
        // would escape the generator and break iteration for the caller, which MUST 2 forbids. It
        // settles the run the same way a setup failure does.
        let opts: Awaited<ReturnType<typeof toPiPromptOptions>>;
        try {
          opts = await toPiPromptOptions(prompt);
        } catch (error) {
          const terminal = errorToTerminal(error);
          outcome = { status: "failed", error: { message: terminal.details, retryable: terminal.retryable } };
          runSettled = true;
          yield terminal;
          return; // → outer finally emits the settlement
        }
        // The consumer walked away while the harness was built or the prompt prepared (latched — the
        // door armed above only stops a RUNNING harness, so a knock in that window is a no-op the
        // LATER run would ignore): never start the model call. Read AFTER the last await before it,
        // so both windows are covered; settle as aborted and let the queued return() finish the
        // generator.
        if (wasCancelled()) {
          outcome = { status: "aborted" };
          runSettled = true;
          try {
            await harness.abort(); // teardown — fresh-harness discipline
          } catch (error) {
            log.warn(`[fastagent] harness abort failed during cleanup: ${String(error)}`);
          }
          return; // → outer finally emits the settlement
        }
        // Bind current cwd/session/activation capabilities for every FastAgent-defined tool.
        const run = turnContext.run(
          {
            cwd: options.cwd ?? process.cwd(),
            sessionManager: toolSessionManager(scope.session, harness),
            tools: toolActivation(harness),
          },
          () => harness.prompt(prompt.text, opts),
        );
        yield* queue.drainUntil(run);
        let terminal: AgentEvent;
        try {
          const message = await run;
          terminal = toTerminal(message);
          if (terminal.type === "completed") completed = message;
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        if ((abortSucceeded || abortsInFlight > 0) && terminal.type === "failed") {
          terminal = { type: "failed", details: terminal.details, retryable: false, code: ABORTED_CODE };
        }
        if (terminal.type === "completed") outcome = { status: "completed" };
        else if (terminal.type === "failed") {
          outcome =
            terminal.code === ABORTED_CODE
              ? // Carry the detail: an independent real error that raced an accepted abort must stay
                // diagnosable in the settlement (audit consumers read run_settled, not the invoke
                // stream) — aborted classifies the run, the message preserves what actually stopped it.
                { status: "aborted", error: { message: terminal.details, retryable: false } }
              : {
                  status: "failed",
                  error: { code: terminal.code, message: terminal.details, retryable: terminal.retryable },
                };
        }
        // Commands become ineffective the moment the run resolved — NOT at the outer finally, which
        // sits behind `yield terminal` (a consumer-paced suspension) and auto-compaction. Flipping
        // here closes the silent-drop window for steer/follow_up dispatched in that gap; the
        // outer-finally flip remains as the backstop for caller cancellation.
        runSettled = true;
        yield terminal;
      } finally {
        // After a successful turn, keep the session under the model's context window (a long shared group
        // or 1:1 conversation would otherwise overflow). Runs HERE — before teardown (it uses the harness)
        // and BEFORE the lease release below, and is awaited via the generator's return(), so the next
        // turn for this session waits and never reopens mid-compaction. That await rides the consumer's
        // iteration: a STREAMING consumer (e.g. telegram) already sent the reply on the terminal before
        // returning, so compaction — rare, only over threshold — does not delay it; a `collect`-style
        // consumer returns the reply FROM the loop, so it waits for the (occasional) compaction. Non-fatal:
        // a failed compaction leaves the (still-valid) session for the next turn to retry.
        if (completed) {
          try {
            await maybeCompact(harness, completed);
          } catch (error) {
            log.warn(`[fastagent] auto-compaction failed during cleanup: ${String(error)}`);
          }
        }
        // Cleanup MUST NOT throw after the terminal was yielded — that would make an already-closed
        // event stream throw on iteration (violating SPEC MUST 2 / MUST 3). Contain it, but surface it
        // (a cleanup failure is abnormal).
        try {
          unsub();
        } catch (error) {
          log.warn(`[fastagent] harness unsubscribe failed during cleanup: ${String(error)}`);
        }
        try {
          await harness.abort();
        } catch (error) {
          log.warn(`[fastagent] harness abort failed during cleanup: ${String(error)}`);
        }
      }
    } finally {
      // Exactly-one settlement, after ALL run work (incl. auto-compaction) and immediately before
      // the lease releases — see the outcome note above. The stale-controls flag flips FIRST so a
      // dispatch racing this settlement is rejected instead of silently accepted.
      runSettled = true;
      observe({ type: "run_settled", timestamp: Date.now(), runId, data: outcome ?? { status: "aborted" } });
      release(); // after cleanup, so the next invoke for this session can enter
    }
  }

  return { invoke };
}
