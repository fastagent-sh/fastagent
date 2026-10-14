/**
 * TEMPORARY test double, removed with `src/legacy-agent.ts` (step 4, PR 4b): a SPEC v1 `Agent` over a scripted v0.1
 * one, so the channel tests, written against v0.1 events, keep driving channels whose context now carries a v1 Agent.
 * A first `session_busy` failure is a rejection; every other stream is accepted and ends with its `run_ended`. Each
 * completed exchange is kept as that session's log, so a thread can fork from it; `forks` records each create.
 */
import { randomUUID } from "node:crypto";
import { ABORTED_CODE, type AgentEvent, type Agent as LegacyAgent, SESSION_BUSY_CODE } from "../src/agent.ts";
import {
  type AbortResult,
  type Entry,
  type InvokeEvent,
  type Agent as ProtocolAgent,
  type RunOutcome,
  type Session,
  agentError,
  failure,
} from "../src/protocol.ts";
import type { SessionControl } from "../src/session.ts";

function outcomeOf(event: Extract<AgentEvent, { type: "failed" }>): RunOutcome {
  if (event.code === ABORTED_CODE) return { status: "canceled", by: "abort" };
  return {
    status: "failed",
    error: { ...agentError("internal", event.details), code: event.code ?? "internal", retryable: event.retryable },
  };
}

type CreateOptions = NonNullable<Parameters<ProtocolAgent["sessions"]["create"]>[0]>;

export function asProtocolAgent(
  legacy: LegacyAgent,
  control?: SessionControl,
): ProtocolAgent & { forks: CreateOptions[] } {
  const logs = new Map<string, Entry[]>();
  const forks: CreateOptions[] = [];
  const session = (sessionId: string): Session => ({
    sessionId,
    read: async () => {
      const entries = logs.get(sessionId);
      if (!entries) return failure("not_found", `no session ${sessionId}`);
      const leafEntryId = entries.at(-1)?.id;
      return { ok: true, state: { status: "idle", queued: [], ...(leafEntryId ? { leafEntryId } : {}) }, entries };
    },
    follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    attachment: async () => undefined,
    abort: async (): Promise<AbortResult> => {
      if (!control) return { ok: true, stopped: { queued: [], compaction: false } };
      const result = await control.sessions.get(sessionId).abort();
      if (result.ok) return { ok: true, stopped: { runId: "run", queued: [], compaction: false } };
      if (result.error.code === "no_active_run") return { ok: true, stopped: { queued: [], compaction: false } };
      return { ok: false, error: result.error };
    },
    rewind: async () => failure("unsupported", "not in this double"),
    compact: async () => failure("unsupported", "not in this double"),
    update: async () => failure("unsupported", "not in this double"),
    delete: async () => failure("unsupported", "not in this double"),
    runs: {
      get: async () => undefined,
      follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      cancel: async () => ({ ok: true }),
    },
  });
  return {
    invoke: (request) => {
      const sessionId = request.sessionId ?? randomUUID();
      const runId = randomUUID();
      let n = 0;
      const record = (kind: string, data: Entry["data"]): Entry => {
        const log = logs.get(sessionId) ?? [];
        logs.set(sessionId, log);
        const parentEntryId = log.at(-1)?.id;
        const kept = {
          id: `${runId}-${n++}`,
          timestamp: Date.now(),
          runId,
          kind,
          data,
          ...(parentEntryId ? { parentEntryId } : {}),
        };
        log.push(kept);
        return kept;
      };
      const entry = (kind: string, data: Entry["data"]): InvokeEvent => ({
        type: "entry",
        entry: { id: `${runId}-${n++}`, timestamp: Date.now(), runId, kind, data },
      });
      let answer = "";
      const iterator = legacy.invoke({ session: sessionId }, request.prompt)[Symbol.asyncIterator]();
      async function* events(): AsyncGenerator<InvokeEvent> {
        let first = true;
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          const event = next.value;
          if (first) {
            first = false;
            if (event.type === "failed" && event.code === SESSION_BUSY_CODE) {
              yield { type: "rejected", error: agentError("busy", event.details) };
              return;
            }
            yield {
              type: "accepted",
              sessionId,
              run: { runId, messages: [{}], status: "running", startedAt: Date.now() },
              joined: false,
              duplicate: false,
            };
          }
          switch (event.type) {
            case "text":
              answer += event.delta;
              yield { type: "message_delta", runId, channel: event.type, delta: event.delta };
              break;
            case "thinking":
              yield { type: "message_delta", runId, channel: event.type, delta: event.delta };
              break;
            case "tool_started":
              yield { type: "tool_started", runId, toolCallId: event.id, name: event.name, args: event.args };
              break;
            case "tool_progress":
              yield { type: "tool_progress", runId, toolCallId: event.id, text: event.text };
              break;
            case "tool_ended":
              yield entry("tool_result", { toolCallId: event.id, isError: event.isError, text: "" });
              break;
            case "retrying":
              yield {
                type: "retry_scheduled",
                runId,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                reason: event.reason,
              };
              break;
            case "completed":
              record("user_message", { text: request.prompt.text ?? "" });
              record("assistant_message", { text: answer });
              yield entry("run_ended", { runId, outcome: { status: "completed" } });
              return;
            case "failed":
              yield entry("run_ended", { runId, outcome: outcomeOf(event) as unknown as Entry["data"] });
              return;
          }
        }
      }
      const generator = events();
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => generator.next(),
          // Straight to the scripted stream: v0.1's cancel is what the channel tests watch for.
          return: async () => {
            await iterator.return?.();
            return { done: true, value: undefined };
          },
        }),
      };
    },
    sessions: {
      create: async (options = {}) => {
        forks.push(options);
        return { ok: true, sessionId: options.sessionId ?? randomUUID() };
      },
      list: async () => [],
      get: session,
    },
    info: () => ({
      protocolVersion: "1.0",
      capabilities: {
        steer: false,
        fork: false,
        rewind: false,
        compaction: false,
        delete: false,
        updatable: [],
        durableQueue: false,
        durableRuns: false,
        toolProgress: true,
        usage: false,
      },
    }),
    models: async () => [],
    commands: async () => [],
    forks,
  };
}
