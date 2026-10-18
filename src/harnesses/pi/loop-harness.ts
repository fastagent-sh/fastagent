/**
 * pi-coding-agent as a `LoopHarness` (loop-port.ts): the session's log is its pi record, held as ONE `SessionManager`
 * for as long as `LoopPort` holds the session, and every run binds a fresh `AgentSession` to it.
 *
 * What pi tells the harness about a handed message is reported as its fate: a steer pi queued is matched to the user
 * message pi appends for it (the object pi queued, or, as pi itself does, its text), one an extension consumed is
 * `handled`, and one still in pi's queue when the run settled, which pi will never run, is `untaken`.
 */
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import type { AgentSession, SessionEntry as PiSessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { warnWhenChanged } from "./report.ts";
import type {
  HandedMessage,
  LogRecord,
  LoopHarness,
  LoopHooks,
  LoopLog,
  LoopOutcome,
  LoopRun,
  MessageFate,
} from "../../loop-port.ts";
import {
  type AgentCommand,
  type AgentError,
  type Result,
  type SessionSettings,
  type SessionState,
  type Usage,
  agentError,
  failure,
} from "../../protocol.ts";
import { type PiBindingOptions, piSessionBinder, startCompaction } from "./session-binding.ts";
import { resolveModel } from "./config.ts";
import { imageAt } from "./entry-images.ts";
import { liveEvents } from "./live-events.ts";
import { contextOf, isRecord, toRecord } from "./log-records.ts";
import { answeredOutcome, thrownFailure, toPiPromptOptions } from "./messages.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL } from "./models.ts";
import { MESSAGE_MARKERS, isConversationMessage } from "./session-markers.ts";
import {
  MissingModel,
  modelBySpec,
  thinkingLevelProblem,
  activePath,
  describeModels,
  resolveSessionSettings,
} from "./session-settings.ts";
import { type PiSessionRecordStore, applyProperties } from "./session-store.ts";

/**
 * ONE assembly: the binder's own options decide what a run binds (its default model and thinking level), and the same
 * ones decide what `state()` reports and `update()` validates against, so the two cannot disagree.
 */
export interface PiLoopHarnessOptions extends PiBindingOptions {
  sessions: PiSessionRecordStore;
  /** The registry a run resolves against, as it is now: for `state()`, `update()` and `models()`. */
  catalog: () => Promise<Models>;
  commands?: () => Promise<AgentCommand[]>;
}

const usageOf = (message: AssistantMessage): Usage => ({
  inputTokens: message.usage.input,
  outputTokens: message.usage.output,
  cacheReadTokens: message.usage.cacheRead,
  cacheWriteTokens: message.usage.cacheWrite,
  cost: message.usage.cost.total,
});

function addUsage(total: Usage | undefined, more: Usage): Usage {
  if (!total) return more;
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (more.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (more.cacheWriteTokens ?? 0),
    cost: (total.cost ?? 0) + (more.cost ?? 0),
  };
}

function thrownOutcome(error: unknown): LoopOutcome {
  if (error instanceof MissingModel) return { status: "failed", error: agentError("missing_model", error.message) };
  return { status: "failed", error: thrownFailure(error) };
}

/** pi's error-channel events for work a run owes its caller: the command it ran, and the turns it started. */
const OWED_BY_THE_RUN = new Set(["command", "send_user_message", "send_message"]);

/**
 * The turns extensions start on this session and have not finished. `pi.sendUserMessage` and `pi.sendMessage` reach
 * these two session methods, and pi discards the promise; wrapping the methods keeps it. The session is not busy until
 * such a turn's run starts, after its `input` handlers, so waiting for idle alone could settle the run before it. The
 * session is this run's alone, so the wrap never outlives the run.
 */
function trackExtensionTurns(session: AgentSession): ReadonlySet<Promise<void>> {
  const pending = new Set<Promise<void>>();
  const track = (sent: Promise<void>): Promise<void> => {
    pending.add(sent);
    const done = () => void pending.delete(sent);
    sent.then(done, done); // pi's own `.catch` on `sent` reports the failure
    return sent;
  };
  const sendUserMessage = session.sendUserMessage.bind(session);
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendUserMessage = (...args) => track(sendUserMessage(...args));
  session.sendCustomMessage = (...args) => track(sendCustomMessage(...args));
  return pending;
}

interface Settings {
  models: Models;
  defaults: { model?: AnyModel; thinkingLevel: ThinkingLevel };
}

interface Handed extends HandedMessage {
  /** Whether its fate has been said. */
  said?: true;
  /** The user message pi queued for it. */
  queued?: unknown;
}

type Disposable = { dispose(): void; extensionRunner: AgentSession["extensionRunner"] };

async function release(session: Disposable): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } catch (error) {
    log.warn(`[fastagent] session_shutdown failed: ${String(error)}`);
  } finally {
    session.dispose();
  }
}

type AppendHook = { _appendEntry(entry: PiSessionEntry): void };

export function piLoopHarness(options: PiLoopHarnessOptions): LoopHarness {
  const { sessions } = options;
  const bind = piSessionBinder(options);

  /**
   * The registry and the default pair as a run would resolve them now, or undefined when the registry cannot be built
   * (`extensions/` unreadable). Each fault is said when it appears or changes, not by every read that meets it.
   */
  const settingsOf = async (): Promise<Settings | undefined> => {
    let models: Models;
    try {
      models = await options.catalog();
      warnWhenChanged(`${options.cwd}: registry`, []);
    } catch (error) {
      warnWhenChanged(`${options.cwd}: registry`, [
        `[fastagent] the model registry cannot be built (sessions report no model): ${String(error)}`,
      ]);
      return undefined;
    }
    return {
      models,
      defaults: { ...withDefault(models), thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL },
    };
  };
  const withDefault = (models: Models): { model?: AnyModel } => {
    if (!options.modelSpec) return {};
    try {
      const model = resolveModel(models, options.modelSpec);
      warnWhenChanged(`${options.cwd}: default model`, []);
      return { model };
    } catch (error) {
      warnWhenChanged(`${options.cwd}: default model`, [
        `[fastagent] the configured default model does not resolve: ${String(error)}`,
      ]);
      return {};
    }
  };

  const logOf = async (
    sessionId: string,
    record: SessionManager,
    onRecord: (record: LogRecord) => void,
  ): Promise<LoopLog> => {
    let settings = await settingsOf();
    const records: LogRecord[] = [];
    /** The nearest record at or above each pi entry: what a record's parent is when pi's is not a record. */
    const nearest = new Map<string, string | undefined>();
    const take = (entry: PiSessionEntry): LogRecord | undefined => {
      const parent = entry.parentId === null ? undefined : nearest.get(entry.parentId);
      if (!isRecord(entry)) {
        nearest.set(entry.id, parent);
        return undefined;
      }
      nearest.set(entry.id, entry.id);
      const converted = toRecord(entry, parent);
      records.push(converted);
      return converted;
    };
    for (const entry of record.getEntries()) take(entry);

    let run: { written(entry: PiSessionEntry): void } | undefined;
    const hooked = record as unknown as AppendHook;
    if (typeof hooked._appendEntry !== "function") {
      throw new Error("pi's SessionManager has no _appendEntry: this pi release changed how a record is written");
    }
    const append = hooked._appendEntry;
    hooked._appendEntry = (entry) => {
      append.call(record, entry);
      run?.written(entry);
      const converted = take(entry);
      if (converted) onRecord(converted);
    };
    let closed = false;

    /** Total: a registry that cannot be built, or an entry chain that cannot be walked, leaves the pair out. */
    const state = (): Omit<SessionState, "status" | "taken" | "queued"> => {
      const name = record.getSessionName();
      let resolved: ReturnType<typeof resolveSessionSettings>;
      let context: SessionState["context"];
      try {
        const path = activePath(record);
        resolved = settings && resolveSessionSettings(path, settings.models, settings.defaults);
        // A virtual model's window is its router's choice: the physical model of the newest answer says which.
        const selected = resolved?.model;
        const latest =
          selected?.api === "pi-virtual"
            ? record
                .buildSessionContext()
                .messages.filter(
                  (m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted",
                )
                .at(-1)
            : undefined;
        const physical =
          latest?.role === "assistant" ? settings?.models.getModel(latest.provider, latest.model) : undefined;
        context = contextOf(path as unknown as PiSessionEntry[], record, (physical ?? selected)?.contextWindow);
      } catch (error) {
        log.warn(`[fastagent] session ${sessionId}: state unreadable (entry chain): ${String(error)}`);
      }
      const branch = record.getBranch();
      const leaf = [...branch].reverse().find(isRecord);
      return {
        ...(name ? { name } : {}),
        ...(resolved
          ? {
              model: `${resolved.model.provider}/${resolved.model.id}`,
              thinkingLevel: resolved.thinkingLevel,
              thinkingLevels: resolved.availableThinkingLevels,
            }
          : {}),
        ...(context ? { context } : {}),
        ...(leaf ? { leafEntryId: leaf.id } : {}),
      };
    };

    const startRun = (first: HandedMessage, { emit, fate }: LoopHooks): LoopRun => {
      const handed: Handed[] = [{ ...first }];
      const said = (h: Handed, what: MessageFate) => {
        if (h.said) return;
        h.said = true;
        fate(h.id, what);
      };
      let session: AgentSession | undefined;
      let stopRequested = false;
      let finished = false;
      let usage: Usage | undefined;
      let resolveReady!: (session: AgentSession | undefined) => void;
      const ready = new Promise<AgentSession | undefined>((resolve) => (resolveReady = resolve));
      // One steer at a time: pi queues each only after its `input` handlers, so serializing is what tells whose
      // message pi queued.
      let steering = Promise.resolve();

      run = {
        written: (entry) => {
          if (entry.type !== "message") return;
          const written = entry.message as { role: string };
          if (written.role === "assistant") {
            usage = addUsage(usage, usageOf(written as AssistantMessage));
            return;
          }
          if (written.role !== "user") return;
          // pi appends the very object it queued (its loop replaces only system messages, and in place), so identity
          // is the match; a user message that is none of the steers is the loop's own first.
          const steered = handed.find((h) => !h.said && h.queued === written);
          const owner = steered ?? (handed[0]?.said ? undefined : handed[0]);
          if (owner) said(owner, { taken: entry.id });
        },
      };

      /** Never rejects: a message pi did not take has nothing said for it, and the run then takes it itself. */
      const deliver = async (h: Handed): Promise<void> => {
        const bound = await ready;
        if (!bound || finished) return;
        const agent = bound.agent;
        const queue = agent.steer;
        // Registered as pi queues it, not when `steer()` returns: nothing orders pi's loop taking and writing it after
        // that return. Not reproduced: with the tool round ending the moment pi queues it, pi 1.1.0 writes it later.
        agent.steer = (queued) => {
          h.queued = queued;
          queue.call(agent, queued);
        };
        try {
          const prepared = await toPiPromptOptions(h.prompt, "queued");
          const disposition = await bound.steer(h.prompt.text, prepared?.images);
          if (disposition === "handled") said(h, { handled: true });
        } catch (error) {
          log.warn(`[fastagent] session ${sessionId}: pi refused a steered message: ${String(error)}`);
        } finally {
          agent.steer = queue;
        }
      };

      /** A run that failed on a provider with no credential failed for that, whatever pi's message says. */
      const withAuth = async (bound: AgentSession, outcome: LoopOutcome): Promise<LoopOutcome> => {
        const provider = bound.model?.provider;
        if (outcome.status !== "failed" || !provider) return outcome;
        const auth = await bound.modelRuntime.checkAuth(provider).catch((error: unknown) => {
          log.warn(`[fastagent] session ${sessionId}: could not check ${provider}'s credential: ${String(error)}`);
          return null;
        });
        return auth === undefined
          ? {
              status: "failed",
              error: agentError("auth_required", `no credential for ${provider}: ${outcome.error.message}`),
            }
          : outcome;
      };

      const done = (async (): Promise<Awaited<LoopRun["done"]>> => {
        try {
          session = await bind(sessionId, record);
        } catch (error) {
          resolveReady(undefined);
          finished = true;
          return { outcome: thrownOutcome(error) };
        }
        const bound = session;
        resolveReady(bound);
        const cleanup: (() => void)[] = [];
        try {
          const project = liveEvents();
          let finalAssistant: AssistantMessage | undefined;
          let runStarted = false;
          let streamedAnswer = false;
          let retriedAfterAnswer: string | undefined;
          let extensionFailure: string | undefined;
          let eventFailure: unknown;
          let thrown: unknown;
          const abort = (why: string) => {
            void bound.abort().catch((error: unknown) => log.warn(`[fastagent] ${why} abort failed: ${String(error)}`));
          };
          cleanup.push(
            bound.subscribe((event) => {
              if (retriedAfterAnswer !== undefined || eventFailure !== undefined) return;
              try {
                if (event.type === "agent_start") runStarted = true;
                if ((event.type === "agent_start" || event.type === "compaction_start") && stopRequested) {
                  abort("requested");
                }
                if (event.type === "message_end" && event.message.role === "assistant") {
                  finalAssistant = event.message as AssistantMessage;
                  for (const diagnostic of finalAssistant.diagnostics ?? []) {
                    log.warn(
                      `[fastagent] provider diagnostic ${diagnostic.type} (${finalAssistant.provider}/${finalAssistant.model}, session ${sessionId})`,
                    );
                  }
                }
                if (event.type === "compaction_end" && event.reason !== "manual") {
                  const status = event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed";
                  (event.errorMessage && !event.aborted ? log.warn : log.debug)(
                    `[fastagent] automatic compaction ${event.reason} (session ${sessionId}): ${status}`,
                  );
                }
                if (event.type === "auto_retry_start" && streamedAnswer) {
                  // A retry after streamed output would add a second answer to the first; pi installs its retry after
                  // this event.
                  retriedAfterAnswer = event.errorMessage;
                  queueMicrotask(() => abort("retry-after-answer"));
                  return;
                }
                const live = project(event);
                if (!live) return;
                if (live.type === "message_delta") streamedAnswer = true;
                emit(live);
              } catch (error) {
                // A listener fault leaves the run's stream incomplete: stop the run rather than let it go on unseen.
                eventFailure = error;
                queueMicrotask(() => abort("event-fault"));
              }
            }),
          );
          cleanup.push(
            bound.extensionRunner.onError((error) => {
              if (OWED_BY_THE_RUN.has(error.event)) {
                extensionFailure ??= `${error.event} failed (${error.extensionPath}): ${error.error}`;
              }
            }),
          );
          const extensionTurns = trackExtensionTurns(bound);
          const extensionMayTakeInput =
            bound.extensionRunner.getRegisteredCommands().length > 0 || bound.extensionRunner.hasHandlers("input");
          try {
            const prepared = await toPiPromptOptions(first.prompt, "prompt");
            await bound.prompt(first.prompt.text, prepared);
            do {
              await Promise.allSettled([...extensionTurns]);
              await bound.waitForIdle();
            } while (extensionTurns.size > 0);
          } catch (error) {
            thrown = error;
          }
          // A steer still in its `input` handlers may yet be consumed, which only its answer says.
          await steering;
          let outcome: LoopOutcome;
          if (thrown !== undefined) outcome = thrownOutcome(thrown);
          else if (eventFailure !== undefined) {
            outcome = {
              status: "failed",
              error: agentError("internal", `observing the run failed: ${String(eventFailure)}`),
            };
          } else if (extensionFailure !== undefined) {
            outcome = { status: "failed", error: agentError("internal", extensionFailure) };
          } else if (retriedAfterAnswer !== undefined) {
            outcome = {
              status: "failed",
              error: { ...agentError("model_error", retriedAfterAnswer), retryable: true },
            };
          } else if (finalAssistant) outcome = answeredOutcome(finalAssistant);
          else if (!runStarted && extensionMayTakeInput) outcome = { status: "intercepted" };
          else outcome = { status: "failed", error: agentError("internal", "pi settled the run without an answer") };
          if (outcome.status === "intercepted") said(handed[0] as Handed, { handled: true });
          return { outcome: await withAuth(bound, outcome), ...(usage ? { usage } : {}) };
        } finally {
          finished = true;
          // What pi still holds it will never run: this run has settled.
          bound.clearQueue();
          for (const stop of cleanup) stop();
          await release(bound);
        }
      })().finally(() => {
        run = undefined;
      });

      return {
        steer: (steered) => {
          const h: Handed = { ...steered };
          handed.push(h);
          steering = steering.then(() => deliver(h));
        },
        stop: () => {
          stopRequested = true;
          if (session) {
            const bound = session;
            void bound.abort().catch((error: unknown) => log.warn(`[fastagent] stop failed: ${String(error)}`));
          }
        },
        done,
      };
    };

    const invalid = (message: string): Result => failure("invalid_request", message);

    const opened: LoopLog = {
      records: () => records,
      append: (kind, data) => {
        const id = record.appendCustomEntry(MESSAGE_MARKERS[kind], data);
        const appended = records.at(-1);
        if (appended?.id !== id) throw new Error(`the ${kind} record ${id} was not seen being written`);
        return appended;
      },
      state,
      run: startRun,
      rewind: async (entryId) => {
        const applied = applyProperties(record, { leafEntryId: entryId });
        return applied.failure === undefined
          ? { ok: true }
          : failure("internal", `rewind failed: ${String(applied.failure)}`);
      },
      compact: async ({ instructions }, signal) => {
        if (!record.getEntries().some(isConversationMessage))
          return failure("nothing_to_compact", "nothing to compact");
        const bound = await bind(sessionId, record).catch((error: unknown) => {
          if (error instanceof MissingModel) return failure("missing_model", error.message);
          throw error;
        });
        if ("ok" in bound) return bound;
        const stopped = () => failure("internal", "the compaction was stopped by abort");
        const abort = () => bound.abortCompaction();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const compaction = startCompaction(bound, instructions, () => {});
          const admission = await compaction.admission;
          if (admission === "nothing_to_compact") return failure("nothing_to_compact", "nothing to compact");
          if (admission !== "admitted") return failure("internal", String(admission.refused));
          // pi's compact() makes its abort controller only after an await: an abort that came before admission (during
          // the binding, say) reached the previous one.
          if (signal.aborted) bound.abortCompaction();
          try {
            await compaction.done;
          } catch (error) {
            if (signal.aborted) return stopped();
            throw error;
          }
          return { ok: true };
        } finally {
          signal.removeEventListener("abort", abort);
          await release(bound);
        }
      },
      // Applies from the next run pi binds: a run accepted but not bound yet (its extensions still loading) binds on it.
      // Holding the run to its settings at acceptance would not help: pi records the model it binds, which would then
      // override this update for every later run too.
      update: async (patch: SessionSettings) => {
        settings = await settingsOf();
        const now = settings;
        if (!now && (patch.model !== undefined || patch.thinkingLevel !== undefined)) {
          return failure(
            "unavailable",
            "the model registry cannot be built now, so a model or level cannot be checked",
          );
        }
        let model: AnyModel | undefined;
        if (patch.model !== undefined && now) {
          model = modelBySpec(now.models, patch.model);
          if (!model) return invalid(`unknown model "${patch.model}": models() lists the accepted models`);
        }
        if (patch.name !== undefined && patch.name.trim() === "") return invalid("a session name cannot be empty");
        if (patch.thinkingLevel !== undefined && now) {
          const target = model ?? resolveSessionSettings(activePath(record), now.models, now.defaults)?.model;
          const problem = thinkingLevelProblem(patch.thinkingLevel, target);
          if (problem) return invalid(problem);
        }
        const applied = applyProperties(record, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
          ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
        });
        if (applied.failure === undefined) return { ok: true };
        const error: AgentError =
          applied.landed.length === 0
            ? agentError("internal", `update failed: ${String(applied.failure)}`)
            : agentError(
                "partial_update",
                `applied ${applied.landed.join(", ")}, then failed: ${String(applied.failure)}`,
              );
        return { ok: false, error };
      },
      attachment: async (ref) => imageAt(record, ref),
      close: () => {
        if (closed) return;
        closed = true;
        hooked._appendEntry = append;
      },
    };
    forkSources.set(opened, { sessionId, record });
    return opened;
  };

  return {
    capabilities: {
      steer: true,
      fork: true,
      rewind: true,
      compaction: true,
      delete: true,
      updatable: ["name", "model", "thinkingLevel"],
      toolProgress: true,
      usage: true,
    },
    open: async (sessionId, onRecord) => {
      const record = await sessions.openIfExists(sessionId);
      return record ? logOf(sessionId, record, onRecord) : undefined;
    },
    create: async (sessionId, onRecord, fork) => {
      if (fork) {
        const source = forkSources.get(fork.from);
        if (!source) throw new Error("a fork's source is not a log this harness opened");
        const at = fork.entryId ?? source.record.getLeafId();
        if (!at) throw new Error(`session ${source.sessionId} has nothing to fork`);
        await sessions.fork(source.sessionId, at, sessionId, `${source.sessionId}@${at}`, fork.context ?? "full");
        const record = await sessions.openIfExists(sessionId);
        if (!record) throw new Error(`the fork ${sessionId} has no record after it was written`);
        return logOf(sessionId, record, onRecord);
      }
      return logOf(sessionId, await sessions.openOrCreate(sessionId), onRecord);
    },
    delete: async (sessionId) => {
      await sessions.delete(sessionId);
    },
    list: async () =>
      (await sessions.list()).map((summary) => ({
        sessionId: summary.sessionId,
        ...(summary.name ? { name: summary.name } : {}),
        status: "idle" as const,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        ...(summary.preview ? { preview: summary.preview } : {}),
      })),
    models: async () => describeModels((await options.catalog()).getModels() as AnyModel[]),
    commands: async () => (await options.commands?.()) ?? [],
  };
}

/** Which session and record a log stands for, so a fork can name its source to the store. */
const forkSources = new WeakMap<LoopLog, { sessionId: string; record: SessionManager }>();
