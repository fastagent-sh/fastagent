/**
 * L0 for the `session` ENGINE CLASS: an Agent whose every turn builds a fresh pi-coding-agent
 * `AgentSession` over the session's durable record and discards it when the turn ends.
 *
 * Same state locality as the harness L0 (`invoke.ts`) — per-invoke, so SPEC MUST 6 holds and the
 * record is the only continuity — but a different engine surface: extensions, `/name` dispatch,
 * branch operations. The two axes are independent; see design/conformance-levels.md.
 *
 * Why per-invoke is affordable HERE, where a resident `AgentSession` was assumed: the expensive half
 * of that class is the `ResourceLoader` (extension modules, skills), which is built ONCE with the
 * assembly and shared across turns. What is per-turn is binding a session object to a record.
 *
 * That trade has a consequence the factory owns: a shared loader is a SNAPSHOT, so "the directory is
 * the agent, live" (what the harness path gets by re-reading the definition every turn) is not free
 * here. A factory that wants it must rebuild or reload the loader; one that shares it trades
 * definition freshness for the ~1ms turn cost. Either is a legitimate deployment choice — silence
 * about which one is in force is not.
 *
 * NOT YET WIRED, twice over. This module has no consumer in `src/`: the assembly that would produce
 * a session factory for a real definition (models, auth, tools, extensions) does not exist yet, and
 * neither this L0 nor `sessionRecordBinder` is exported from `src/pi.ts` — pi-coupled L0s stay
 * internal by convention (AGENTS.md), so selecting this engine class is an in-repo capability until
 * the assembly and the exports land together.
 *
 * And: the harness L0 accepts a `SessionObserver` and registers per-run modulation handles
 * (steer/follow_up/abort), which is what the session control plane consumes. This L0 has neither, so
 * an agent built here serves invokes but cannot be observed or steered through `/control/*` — the
 * gap to close before it backs a serving path, not an omission to discover later.
 *
 * This module owns the turn mechanism only. The assembly that produces the session factory
 * (models, auth, tools, definition, extensions) is a caller's concern, exactly as
 * `piHarnessFactory` is for the harness class.
 */
import type { CustomMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, Agent, Json, Prompt, Scope } from "../../agent.ts";
import { abortFirstIterator } from "../../collect.ts";
import { log } from "../../log.ts";
import { sessionToolActivation, toolSessionManagerFromSession } from "./session-bridge.ts";
import { turnContext } from "./tool-context.ts";
import {
  EventQueue,
  type Lease,
  errorToTerminal,
  inProcessLease,
  sessionBusyFailure,
  toPiPromptOptions,
  toTerminal,
} from "./turn-plumbing.ts";

/**
 * Build a session object bound to `sessionId`'s durable record. Called once per invoke; the returned
 * object is discarded when the turn ends, so an implementation must NOT cache it across turns (that
 * would be the resident level, with a different bill).
 *
 * DO NOT BIND `onError`: unlike `uiContext`/`mode`/`commandContextActions`, which pi merges, the
 * extension-error listener is a single slot — this L0 claims it to classify a command turn. A
 * factory that wants its own (logging, metrics, a toast) passes
 * {@link CreatePiAgentFromSessionOptions.onExtensionError}, which is forwarded every failure; binding
 * pi's slot directly would instead be dropped every turn with no signal.
 *
 * BIND TO AN EXISTING RECORD — use `sessionRecordBinder` (session-record.ts), do not let
 * `SessionManager` open a file of its own. Not a style preference: a SessionManager that starts a
 * fresh file BUFFERS everything until the first assistant message, so a crash between "the user
 * asked" and "the model answered" loses the question and the file is never created. The binder is
 * where that rule is implemented; this contract is where it is required.
 */
export interface CreatePiAgentFromSessionOptions {
  sessionFactory: (sessionId: string) => Promise<AgentSession>;
  /** Every extension-dispatch failure of every turn, forwarded. The supported place for a factory's
   *  own listener, since pi's `onError` is a single slot this L0 owns (see the factory contract).
   *  A throwing listener is contained — it is an observer, not part of the turn. */
  onExtensionError?: (error: { event: string; error: string }) => void;
  /** One in-flight turn per session, like the harness L0. A collision fails `session_busy`. */
  lease?: Lease;
}

/**
 * EXHAUSTIVE map of pi's delta-event vocabulary: which members this projection reads, and which it
 * deliberately ignores. A rename narrows the key set and a NEW member widens it — either way this
 * literal stops type-checking, which is the point: an added delta channel that nobody projects is
 * exactly the drift a two-name guard would wave through.
 */
const DELTA_CHANNELS: Record<AssistantMessageEvent["type"], "project" | "ignore"> = {
  text_delta: "project",
  thinking_delta: "project",
  // Boundaries and tool-call assembly: the Agent Handler stream carries tool activity from pi's
  // tool_execution_* events instead, and message boundaries have no SPEC counterpart.
  start: "ignore",
  text_start: "ignore",
  text_end: "ignore",
  thinking_start: "ignore",
  thinking_end: "ignore",
  toolcall_start: "ignore",
  toolcall_delta: "ignore",
  toolcall_end: "ignore",
  done: "ignore",
  error: "ignore",
};

/**
 * EXHAUSTIVE map of pi's session-class event vocabulary, same discipline as {@link DELTA_CHANNELS}
 * one level down. This union is the one pi extends most (bash execution, compaction phases,
 * summarization retries), and an added member that nobody projects is exactly the drift a bare
 * `default:` waves through — here it stops the build instead.
 */
const SESSION_EVENTS = {
  // Projected below into the Agent Handler vocabulary.
  message_update: "project",
  tool_execution_start: "project",
  tool_execution_end: "project",
  auto_retry_start: "project",
  summarization_retry_scheduled: "project",
  // A COMMAND's output arrives as a custom-role message (an extension's `sendMessage`), and it is
  // the only output such a turn has — ignoring it would make "the command ran" indistinguishable
  // from "nothing happened" to a stream consumer. Model text keeps arriving as deltas.
  message_end: "project",
  // The turn's OUTCOME, read by the turn loop rather than projected as a stream event.
  agent_end: "ignore",
  // Bookkeeping with no Agent Handler counterpart: run/turn boundaries and message STARTS,
  // durable-record and queue notifications, and richer-plane material the control plane projects.
  agent_start: "ignore",
  agent_settled: "ignore",
  turn_start: "ignore",
  turn_end: "ignore",
  message_start: "ignore",
  tool_execution_update: "ignore",
  queue_update: "ignore",
  entry_appended: "ignore",
  session_info_changed: "ignore",
  thinking_level_changed: "ignore",
  compaction_start: "ignore",
  compaction_end: "ignore",
  auto_retry_end: "ignore",
  summarization_retry_attempt_start: "ignore",
  summarization_retry_finished: "ignore",
  bash_execution_update: "ignore",
} as const satisfies Record<AgentSessionEvent["type"], "project" | "ignore">;

/** The members {@link SESSION_EVENTS} declares projectable — what the switch below must handle. */
type ProjectedType = {
  [K in keyof typeof SESSION_EVENTS]: (typeof SESSION_EVENTS)[K] extends "project" ? K : never;
}[keyof typeof SESSION_EVENTS];

/** pi's session-class event → the Agent Handler vocabulary. `null` = nothing to project. */
function projectSessionEvent(event: AgentSessionEvent): AgentEvent | null {
  // The runtime filter and the type narrowing are the same decision, made once: everything past
  // this line is a member {@link SESSION_EVENTS} declared projectable, which is what lets the
  // switch below be exhaustively checked.
  if (SESSION_EVENTS[event.type] === "ignore") return null;
  return projectProjectable(event as Extract<AgentSessionEvent, { type: ProjectedType }>);
}

function projectProjectable(event: Extract<AgentSessionEvent, { type: ProjectedType }>): AgentEvent | null {
  switch (event.type) {
    case "message_update": {
      // The delta channel: pi reports the accumulated message plus the typed event that changed it.
      const e = event.assistantMessageEvent;
      if (DELTA_CHANNELS[e.type] === "ignore") return null;
      if (e.type === "thinking_delta") return { type: "thinking", delta: e.delta };
      if (e.type === "text_delta") return { type: "text", delta: e.delta };
      return null;
    }
    case "message_end": {
      // Only the DISPLAY-worthy custom messages: an assistant message already streamed as deltas,
      // and a non-display custom message is extension bookkeeping the user was never meant to read.
      const m = event.message;
      if (m.role !== "custom" || m.display === false) return null;
      const delta = customText(m.content);
      return delta === "" ? null : { type: "text", delta };
    }
    case "tool_execution_start":
      return {
        type: "tool_started",
        id: event.toolCallId,
        name: event.toolName,
        args: (event.args ?? null) as Json,
      };
    case "tool_execution_end":
      return {
        type: "tool_ended",
        id: event.toolCallId,
        isError: event.isError,
        content: (event.result ?? null) as Json,
      };
    // BOTH backoffs, for one reason: a quiet tail reads as a hang. The turn-level auto-retry and
    // the summarization retry (compaction / branch summary) are the same silence to a consumer.
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return {
        type: "retrying",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.errorMessage,
      };
    default: {
      // Declaring a member "project" and forgetting its case would otherwise project nothing — the
      // same silent drift the map exists to stop, one step later. This assignment is `never` only
      // while every projectable member has a case above.
      const unhandled: never = event;
      void unhandled;
      return null;
    }
  }
}

/**
 * A custom message's content rendered for the Agent Handler's text channel. Non-text blocks become a
 * bracketed placeholder rather than nothing: the vocabulary has no image event, and this projection
 * exists precisely so a command's turn is not an empty stream — an image-only reply must not
 * reintroduce that silence one content shape over.
 */
function customText(content: CustomMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("");
}

/** The assistant message a settled turn ended on, for terminal classification. */
function lastAssistant(event: AgentSessionEvent): AssistantMessage | undefined {
  if (event.type !== "agent_end") return undefined;
  const messages = event.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m as AssistantMessage;
  }
  return undefined;
}

/**
 * The `session`-class L0. Mirrors `createPiAgentFromHarness`'s discipline: failures are `failed`
 * events (never thrown mid-iteration), exactly one terminal, and a consumer break aborts in-flight
 * engine work.
 */
export function createPiAgentFromSession(options: CreatePiAgentFromSessionOptions): Agent {
  const { sessionFactory, lease = inProcessLease() } = options;

  async function* turn(
    scope: Scope,
    prompt: Prompt,
    onCancelReady: (cancel: () => void) => void,
    wasCancelled: () => boolean,
  ): AsyncGenerator<AgentEvent> {
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield sessionBusyFailure();
      return;
    }
    try {
      let session: AgentSession;
      try {
        session = await sessionFactory(scope.session);
      } catch (error) {
        // Setup failures (record open, auth, extension binding) are EVENTS, never throws.
        yield errorToTerminal(error);
        return;
      }
      // ONE teardown for every exit path: abort what is in flight, drop the subscription if there is
      // one, release the object. Written once because the three exits differ only in how far setup
      // got — three hand-written subsets drift the moment a line moves between them.
      let unsub: (() => void) | undefined;
      const teardown = async (): Promise<void> => {
        try {
          await session.abort();
        } catch (error) {
          log.warn(`[fastagent] session abort failed during cleanup: ${String(error)}`);
        }
        try {
          unsub?.();
        } catch (error) {
          log.warn(`[fastagent] session unsubscribe failed during cleanup: ${String(error)}`);
        }
        try {
          // pi: "remove all listeners and disconnect from agent". Without it a process serving
          // thousands of turns leaks one wired-up session per turn — this L0's whole posture.
          session.dispose();
        } catch (error) {
          log.warn(`[fastagent] session dispose failed during cleanup: ${String(error)}`);
        }
      };
      // Arm the cancellation door before any model work, then honour a cancel that arrived while
      // the session was still being built (the latch) — the same ordering the harness L0 uses.
      onCancelReady(() => {
        void session.abort().catch((error: unknown) => {
          log.warn(`[fastagent] session abort failed at cancellation: ${String(error)}`);
        });
      });
      if (wasCancelled()) {
        await teardown();
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      let settled: AssistantMessage | undefined;

      // EVERY extension-dispatch failure, not just a command handler's: pi reports them all here,
      // and one that vanished would be a silent failure inside a turn we are about to call
      // completed — so they ACCUMULATE (a second failing hook must not be swallowed by the first)
      // and each is warned as it arrives, whatever the turn's terminal turns out to be. Only the
      // COMMAND dispatch (`event: "command"`, pi's own label) can decide the terminal: a hook that
      // throws is not the work the caller asked for, and blaming their `/mute` for it would be the
      // same conflation the model branch refuses. bindExtensions MERGES uiContext/mode/actions, so
      // the assembly's stay as they were — but `onError` is a single slot, not a merge, so this L0
      // CLAIMS it (stated in the factory contract above).
      const commandErrors: string[] = [];
      try {
        await session.bindExtensions({
          onError: (error: { event: string; error: string }) => {
            const message = `extension ${error.event} failed: ${error.error}`;
            if (error.event === "command") commandErrors.push(message);
            log.warn(`[fastagent] session ${scope.session}: ${message}`);
            try {
              options.onExtensionError?.(error);
            } catch (listenerError) {
              log.warn(`[fastagent] onExtensionError threw: ${String(listenerError)}`);
            }
          },
        });
      } catch (error) {
        // Binding is this engine class's own setup step, and its failures obey the same rule as the
        // factory's: an EVENT, never a thrown iteration — and the session still gets torn down.
        // NOT through errorToTerminal: extension module code throwing in-process is as determinate
        // as a command handler throwing (the branch below), and that classifier's prose fallback
        // would read "timed out" out of an extension's message and invite a re-run that throws
        // identically. The FACTORY's failures keep the classifier: record open, auth and network
        // genuinely mix transient with permanent.
        await teardown();
        yield { type: "failed", details: String(error), retryable: false };
        return;
      }
      unsub = session.subscribe((event) => {
        if (event.type === "agent_end") {
          // `willRetry` means pi will run again for this same prompt — an auto-retry, not a settle.
          // Taking the message from a retried end would classify the turn on an error pi is about
          // to recover from.
          if (!event.willRetry) settled = lastAssistant(event);
          return;
        }
        const projected = projectSessionEvent(event);
        if (!projected) return;
        if (projected.type === "retrying") {
          // Same reason the harness L0 logs it: the event only reaches an ATTACHED consumer, while
          // an operator tailing logs must also see a backoff that would otherwise read as a hang.
          log.warn(
            `[fastagent] retry ${projected.attempt}/${projected.maxAttempts} in ${projected.delayMs}ms (session ${scope.session}): ${projected.reason}`,
          );
        }
        queue.push(projected);
      });
      try {
        // prompt() resolves when the turn is accepted-and-run; waitForIdle() closes the window in
        // which pi is still draining its own queues (a follow-up, a retry), so the terminal below
        // describes the whole activity window rather than the first response inside it.
        // Images ride the same conversion the harness L0 uses (resize + provider shape); dropping
        // them here would make an attachment invisible to the model AND silent to the author.
        const opts = await toPiPromptOptions(prompt);
        // Bind the turn context for the duration of the turn, like both siblings do (invoke.ts per
        // turn, session-builder.ts per session): without it every fastagent-defined tool degrades
        // SILENTLY — `wake` writes nowhere, `search_tools` activates nothing, cwd falls back to the
        // process's.
        // The cancel latch again, and this is its real window: binding extensions and converting
        // images (a Photon resize) are awaits, and a cancel arriving in either knocks a door that
        // no-ops on a session which has not prompted yet — the model call would then start anyway.
        // Checked here, after the last await before it.
        if (wasCancelled()) return;
        const run = turnContext.run(
          {
            cwd: session.sessionManager.getCwd(),
            sessionManager: toolSessionManagerFromSession(session),
            tools: sessionToolActivation(session),
          },
          async () => {
            await session.prompt(prompt.text, opts);
            await session.waitForIdle();
          },
        );
        yield* queue.drainUntil(run);
        let terminal: AgentEvent;
        try {
          await run;
          if (settled) {
            // The turn ran the model: its own outcome decides the terminal. Extension failures
            // alongside it are real (and already warned) but not the turn's verdict — flipping a
            // model answer the caller did receive into a failure would deny them the result.
            terminal = toTerminal(settled);
          } else {
            // No model response at all: the input was handled by a COMMAND, so that command's own
            // failure IS the turn's outcome — without this the turn reports success for work that
            // threw. A hook that threw alongside it stays a warning, for the same reason the model
            // branch keeps its answer.
            // NOT through errorToTerminal: that classifier's last-resort prose match reads
            // "timed out"/"rate limit"/5xx out of a message, which would tell a caller to re-run a
            // handler whose code throws identically every time. An in-process dispatch failure is a
            // determinate local outcome.
            terminal =
              commandErrors.length > 0
                ? { type: "failed", details: commandErrors.join("; "), retryable: false }
                : { type: "completed" };
          }
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        yield terminal;
      } finally {
        // Fresh-session discipline: the object dies with the turn.
        await teardown();
      }
    } finally {
      release();
    }
  }

  return {
    invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      let externalCancel: (() => void) | undefined;
      let cancelled = false;
      const gen = turn(
        scope,
        prompt,
        (cancel) => {
          externalCancel = cancel;
        },
        () => cancelled,
      );
      const iterator = abortFirstIterator(gen, () => {
        cancelled = true;
        externalCancel?.();
      });
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return iterator;
        },
      };
    },
  };
}
