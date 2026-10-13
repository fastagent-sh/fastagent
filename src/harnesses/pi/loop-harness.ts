/**
 * pi-coding-agent as a `LoopHarness` (loop-port.ts): the session's log is its pi record, held as ONE `SessionManager`
 * for as long as `LoopPort` holds the session, and every run binds a fresh `AgentSession` to it.
 *
 * What pi tells the harness about a handed message is reported as its fate: a steer pi queued is matched to the user
 * message pi appends for it (the object pi queued, or, as pi itself does, its text), one an extension consumed is
 * `handled`, and one still in pi's queue when the run settled, which pi will never run, is `untaken`.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Models, contentText, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentSession, SessionEntry as PiSessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import type { LogRecord, LoopHarness, LoopLog, LoopRun, MessageFate, RunMarker } from "../../loop-port.ts";
import {
  type AgentCommand,
  type AgentError,
  type Json,
  type Prompt,
  type Result,
  type SessionSettings,
  type SessionState,
  type Usage,
  agentError,
  failure,
} from "../../protocol.ts";
import type { PiSessionBinder } from "./agent-session-factory.ts";
import { startCompaction } from "./agent-session-factory.ts";
import { imageAt } from "./entry-images.ts";
import { OWED_BY_THE_RUN, toSessionEvent, trackExtensionTurns } from "./invoke-session.ts";
import type { AnyModel } from "./models.ts";
import { sessionUsage, toSessionEntry } from "./session-control.ts";
import { RUN_MARKERS, isConversationMessage, isPlaneMarker, isRunMarker } from "./session-markers.ts";
import {
  MissingModel,
  THINKING_LEVELS,
  activePath,
  describeModels,
  resolveSessionSettings,
} from "./session-settings.ts";
import { type PiSessionRecordStore, applyPropertiesTo } from "./session-store.ts";
import { agentEventProjection, answerOutcome, classifyRetryable, toPiPromptOptions } from "./turn-kit.ts";

export interface PiLoopHarnessOptions {
  sessions: PiSessionRecordStore;
  bind: PiSessionBinder;
  /** The registry as a run would resolve it now. */
  models: () => Promise<Models>;
  /** The configured default model; undefined when the agent sets none. */
  defaultModel: (models: Models) => AnyModel | undefined;
  thinkingLevel: ThinkingLevel;
  commands?: () => Promise<AgentCommand[]>;
}

const MARKER_KINDS = new Map<string, RunMarker>(
  Object.entries(RUN_MARKERS).map(([kind, customType]) => [customType, kind as RunMarker]),
);

const V1_KINDS: Record<string, string> = { user: "user_message", assistant: "assistant_message", tool: "tool_result" };

/** Whether an entry is a record of the log at all: pi's prompt bookkeeping, labels and extension state are not. */
function isRecord(entry: PiSessionEntry): boolean {
  if (entry.type === "message") return isConversationMessage(entry);
  if (entry.type === "custom") return isRunMarker(entry);
  return entry.type !== "label" && entry.type !== "usage" && !isPlaneMarker(entry);
}

/** One pi entry as a record of the log, under the nearest ancestor that is one. */
function toRecord(entry: PiSessionEntry, parentEntryId: string | undefined): LogRecord {
  const base = { id: entry.id, ...(parentEntryId ? { parentEntryId } : {}), timestamp: Date.parse(entry.timestamp) };
  switch (entry.type) {
    case "custom":
      return { ...base, kind: MARKER_KINDS.get(entry.customType) as string, data: (entry.data ?? {}) as Json };
    case "model_change":
      return { ...base, kind: "settings_changed", data: { model: `${entry.provider}/${entry.modelId}` } };
    case "thinking_level_change":
      return { ...base, kind: "settings_changed", data: { thinkingLevel: entry.thinkingLevel } };
    case "session_info":
      return { ...base, kind: "settings_changed", data: entry.name ? { name: entry.name } : {} };
    case "compaction":
      return {
        ...base,
        kind: "compaction",
        data: { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId },
      };
    default: {
      const neutral = toSessionEntry(entry);
      return { ...base, kind: V1_KINDS[neutral.kind] ?? neutral.kind, data: neutral.data };
    }
  }
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

type LoopOutcome = Awaited<LoopRun["done"]>["outcome"];

function thrownOutcome(error: unknown): LoopOutcome {
  if (error instanceof MissingModel) return { status: "failed", error: agentError("missing_model", error.message) };
  const message = error instanceof Error ? error.message : String(error);
  return classifyRetryable(message, {})
    ? { status: "failed", error: { ...agentError("model_error", message), retryable: true } }
    : { status: "failed", error: agentError("internal", message) };
}

/** How a run ended, by its last answer: the one reading `answerOutcome` gives the entry too. */
function answeredOutcome(message: AssistantMessage): LoopOutcome {
  const outcome = answerOutcome(message);
  if (outcome?.status === "truncated") return { status: "max_tokens" };
  if (outcome?.status === "aborted") return { status: "failed", error: agentError("internal", "the run was aborted") };
  if (outcome?.status === "failed") {
    const detail = outcome.error?.message ?? "the model stopped with an error";
    return {
      status: "failed",
      error: { ...agentError("model_error", detail), retryable: classifyRetryable(detail, {}) },
    };
  }
  return { status: "completed" };
}

interface Handed {
  readonly message: Prompt;
  fate?: MessageFate;
  /** The user message pi queued for it. */
  queued?: { object: unknown; text: string };
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
  const { sessions, bind } = options;

  const settingsOf = async () => {
    const models = await options.models();
    return { models, defaults: { ...withDefault(models), thinkingLevel: options.thinkingLevel } };
  };
  const withDefault = (models: Models) => {
    try {
      const model = options.defaultModel(models);
      return model ? { model } : {};
    } catch (error) {
      log.warn(`[fastagent] the configured default model does not resolve: ${String(error)}`);
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

    const state = (): Omit<SessionState, "status" | "run" | "queued"> => {
      const name = record.getSessionName();
      const path = activePath(record);
      const resolved = resolveSessionSettings(path, settings.models, settings.defaults);
      const usage = sessionUsage(path as unknown as PiSessionEntry[], record, resolved?.model.contextWindow);
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
        ...(usage?.contextTokens !== undefined || usage?.contextWindow !== undefined
          ? {
              context: {
                ...(usage.contextTokens !== undefined ? { tokens: usage.contextTokens } : {}),
                ...(usage.contextWindow !== undefined ? { window: usage.contextWindow } : {}),
              },
            }
          : {}),
        ...(leaf ? { leafEntryId: leaf.id } : {}),
      };
    };

    const startRun = (message: Prompt, emit: Parameters<LoopLog["run"]>[1]): LoopRun => {
      const handed: Handed[] = [{ message }];
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
          const written = entry.message as { role: string; content?: unknown };
          if (written.role === "assistant") {
            usage = addUsage(usage, usageOf(written as AssistantMessage));
            return;
          }
          if (written.role !== "user") return;
          const text = contentText(written.content as never, "");
          const steered =
            handed.find((h) => h.fate === undefined && h.queued?.object === written) ??
            handed.find((h) => h.fate === undefined && h.queued !== undefined && h.queued.text === text);
          if (steered) steered.fate = { taken: entry.id };
          else if (handed[0] && handed[0].fate === undefined) handed[0].fate = { taken: entry.id };
        },
      };

      const deliver = async (h: Handed): Promise<void> => {
        const bound = await ready;
        if (!bound || finished) return;
        const prepared = await toPiPromptOptions(h.message, "queued");
        const agent = bound.agent;
        const queue = agent.steer;
        let pushed: unknown;
        agent.steer = (queued) => {
          pushed = queued;
          queue.call(agent, queued);
        };
        try {
          const disposition = await bound.steer(h.message.text, prepared?.images);
          if (disposition === "handled") h.fate = { handled: true };
          else if (pushed !== undefined) {
            const content = (pushed as { content?: unknown }).content;
            h.queued = { object: pushed, text: contentText(content as never, "") };
          }
        } catch (error) {
          log.warn(`[fastagent] session ${sessionId}: pi refused a steered message: ${String(error)}`);
        } finally {
          agent.steer = queue;
        }
      };

      const done = (async (): Promise<Awaited<LoopRun["done"]>> => {
        let outcome: LoopOutcome = { status: "completed" };
        try {
          session = await bind(sessionId, record);
        } catch (error) {
          resolveReady(undefined);
          finished = true;
          return { outcome: thrownOutcome(error), messages: handed.map(() => ({ untaken: true as const })) };
        }
        const bound = session;
        resolveReady(bound);
        const project = agentEventProjection();
        let finalAssistant: AssistantMessage | undefined;
        let runStarted = false;
        let streamedAnswer = false;
        let retriedAfterAnswer: string | undefined;
        let extensionFailure: string | undefined;
        let thrown: unknown;
        const abort = (why: string) => {
          void bound.abort().catch((error: unknown) => log.warn(`[fastagent] ${why} abort failed: ${String(error)}`));
        };
        const unsubscribe = bound.subscribe((event) => {
          if (event.type === "agent_start") runStarted = true;
          if ((event.type === "agent_start" || event.type === "compaction_start") && stopRequested) abort("requested");
          if (event.type === "message_end" && event.message.role === "assistant") {
            finalAssistant = event.message as AssistantMessage;
          }
          if (event.type === "auto_retry_start" && streamedAnswer && retriedAfterAnswer === undefined) {
            // A retry after streamed output would add a second answer to the first; pi installs its retry after this.
            retriedAfterAnswer = event.errorMessage;
            queueMicrotask(() => abort("retry-after-answer"));
            return;
          }
          const rich = toSessionEvent(event, "");
          const projected = rich && project(rich);
          if (!projected) return;
          switch (projected.type) {
            case "text":
            case "thinking":
              streamedAnswer = true;
              emit({ type: "message_delta", channel: projected.type, delta: projected.delta });
              break;
            case "tool_started":
              emit({ type: "tool_started", toolCallId: projected.id, name: projected.name, args: projected.args });
              break;
            case "tool_progress":
              emit({ type: "tool_progress", toolCallId: projected.id, text: projected.text });
              break;
            case "retrying":
              emit({
                type: "retry_scheduled",
                attempt: projected.attempt,
                maxAttempts: projected.maxAttempts,
                delayMs: projected.delayMs,
                reason: projected.reason,
              });
              break;
          }
        });
        const unlisten = bound.extensionRunner.onError((error) => {
          if (OWED_BY_THE_RUN.has(error.event)) {
            extensionFailure ??= `${error.event} failed (${error.extensionPath}): ${error.error}`;
          }
        });
        const extensionTurns = trackExtensionTurns(bound);
        const extensionMayTakeInput =
          bound.extensionRunner.getRegisteredCommands().length > 0 || bound.extensionRunner.hasHandlers("input");
        try {
          if (stopRequested) abort("requested");
          const prepared = await toPiPromptOptions(message, "prompt");
          await bound.prompt(message.text, prepared);
          do {
            await Promise.allSettled([...extensionTurns]);
            await bound.waitForIdle();
          } while (extensionTurns.size > 0);
        } catch (error) {
          thrown = error;
        }
        // A steer still in its `input` handlers may yet be consumed, which only its answer says.
        await steering;
        finished = true;
        // What pi still holds it will never run: this run has settled.
        bound.clearQueue();
        unsubscribe();
        unlisten();
        if (thrown !== undefined) outcome = thrownOutcome(thrown);
        else if (extensionFailure !== undefined)
          outcome = { status: "failed", error: agentError("internal", extensionFailure) };
        else if (retriedAfterAnswer !== undefined) {
          outcome = { status: "failed", error: { ...agentError("model_error", retriedAfterAnswer), retryable: true } };
        } else if (finalAssistant) outcome = answeredOutcome(finalAssistant);
        else if (!runStarted && extensionMayTakeInput) outcome = { status: "intercepted" };
        else outcome = { status: "failed", error: agentError("internal", "pi settled the run without an answer") };
        const first = handed[0] as Handed;
        if (first.fate === undefined && outcome.status === "intercepted") first.fate = { handled: true };
        await release(bound);
        return {
          outcome,
          ...(usage ? { usage } : {}),
          messages: handed.map((h) => h.fate ?? { untaken: true as const }),
        };
      })().finally(() => {
        run = undefined;
      });

      return {
        steer: (steered) => {
          const h: Handed = { message: steered };
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
        const id = record.appendCustomEntry(RUN_MARKERS[kind], data);
        const appended = records.at(-1);
        if (appended?.id !== id) throw new Error(`the ${kind} record ${id} was not seen being written`);
        return appended;
      },
      state,
      run: startRun,
      rewind: async (entryId) => {
        const applied = applyPropertiesTo(record, { leafEntryId: entryId });
        return applied.failure === undefined
          ? { ok: true }
          : failure("internal", `rewind failed: ${String(applied.failure)}`);
      },
      compact: async ({ instructions }, signal) => {
        if (!record.getEntries().some(isConversationMessage))
          return failure("nothing_to_compact", "nothing to compact");
        const bound = await bind(sessionId, record);
        const abort = () => bound.abortCompaction();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const compaction = startCompaction(bound, instructions, () => {});
          const admission = await compaction.admission;
          if (admission === "nothing_to_compact") return failure("nothing_to_compact", "nothing to compact");
          if (admission !== "admitted") return failure("internal", String(admission.refused));
          await compaction.done;
          return { ok: true };
        } finally {
          signal.removeEventListener("abort", abort);
          await release(bound);
        }
      },
      update: async (patch: SessionSettings) => {
        settings = await settingsOf();
        let model: AnyModel | undefined;
        if (patch.model !== undefined) {
          const slash = patch.model.indexOf("/");
          model =
            slash > 0
              ? (settings.models.getModel(patch.model.slice(0, slash), patch.model.slice(slash + 1)) as AnyModel)
              : undefined;
          if (!model) return invalid(`unknown model "${patch.model}": models() lists the accepted models`);
        }
        if (patch.name !== undefined && patch.name.trim() === "") return invalid("a session name cannot be empty");
        if (patch.thinkingLevel !== undefined) {
          if (!(THINKING_LEVELS as ReadonlySet<string>).has(patch.thinkingLevel)) {
            return invalid(`unknown thinking level "${patch.thinkingLevel}"`);
          }
          const target = model ?? resolveSessionSettings(activePath(record), settings.models, settings.defaults)?.model;
          const levels = target ? (getSupportedThinkingLevels(target) as string[]) : undefined;
          if (target && levels && !levels.includes(patch.thinkingLevel)) {
            return invalid(
              `thinking level "${patch.thinkingLevel}" is not supported by ${target.provider}/${target.id} (allowed: ${levels.join(", ")})`,
            );
          }
        }
        const applied = applyPropertiesTo(record, {
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
        await sessions.fork(source.sessionId, at, sessionId, `${source.sessionId}@${at}`);
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
        sessionId: summary.session,
        ...(summary.name ? { name: summary.name } : {}),
        status: "idle" as const,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        ...(summary.preview ? { preview: summary.preview } : {}),
      })),
    models: async () => describeModels((await options.models()).getModels() as AnyModel[]),
    commands: async () => (await options.commands?.()) ?? [],
  };
}

/** Which session and record a log stands for, so a fork can name its source to the store. */
const forkSources = new WeakMap<LoopLog, { sessionId: string; record: SessionManager }>();
