/**
 * A SPEC v1 Agent whose messages a test scripts: `invoke` streams what the script yields for each request. The rest of
 * the Agent is what a channel asks of it, kept just faithful enough to observe:
 *   - each message the script ends is recorded under its session, with its key and answer, so `read` and
 *     `messages.get` answer for it (a thread forks from a room by the message its reply chain names);
 *   - `sessions.create` records each fork it is asked for (`forks`);
 *   - `abort` records the session (`aborted`) and answers what `stopped` says, nothing running by default.
 */
import type {
  AbortResult,
  Agent,
  Entry,
  ForkSource,
  InvokeEvent,
  InvokeRequest,
  MessageStatus,
  Outcome,
  Session,
} from "../src/protocol.ts";
import { failure } from "../src/protocol.ts";
import { answerText } from "../src/answer-text.ts";

export type Script = (request: InvokeRequest) => AsyncIterable<InvokeEvent> | Iterable<InvokeEvent>;

export interface ScriptedAgent extends Agent {
  /** Every `sessions.create`, in order. */
  forks: { sessionId?: string; fork?: ForkSource }[];
  /** Every session `abort` was called for, in order. */
  aborted: string[];
}

interface Kept {
  entries: Entry[];
  messages: MessageStatus[];
}

export function scriptedAgent(script: Script, options: { stopped?: (sessionId: string) => AbortResult } = {}) {
  const sessions = new Map<string, Kept>();
  const forks: ScriptedAgent["forks"] = [];
  const aborted: string[] = [];
  let entries = 0;

  /** Keep a message the script ended: it and its answer as entries, and its status, findable by its key. */
  const keep = (request: InvokeRequest, sessionId: string, messageId: string, outcome: Outcome, answer: string) => {
    const kept = sessions.get(sessionId) ?? { entries: [], messages: [] };
    sessions.set(sessionId, kept);
    const append = (kind: string, text: string): Entry => {
      const parentEntryId = kept.entries.at(-1)?.id;
      const entry: Entry = {
        id: `e${++entries}`,
        timestamp: Date.now(),
        kind,
        data: { text },
        ...(parentEntryId ? { parentEntryId } : {}),
      };
      kept.entries.push(entry);
      return entry;
    };
    const message = append("user_message", request.prompt.text);
    const answered = answer === "" ? undefined : append("assistant_message", answer);
    kept.messages.push({
      messageId,
      ...(request.source ? { source: request.source } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      entryId: message.id,
      status: "done",
      endedAt: Date.now(),
      outcome,
      ...(answered ? { answer: { entryId: answered.id, text: answer } } : {}),
    });
  };

  const session = (sessionId: string): Session => ({
    sessionId,
    read: async () => {
      const kept = sessions.get(sessionId);
      if (!kept) return failure("not_found", `no session ${sessionId}`);
      const leafEntryId = kept.entries.at(-1)?.id;
      return {
        ok: true,
        state: { status: "idle", taken: [], queued: [], ...(leafEntryId ? { leafEntryId } : {}) },
        entries: kept.entries,
      };
    },
    follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    attachment: async () => undefined,
    abort: async () => {
      aborted.push(sessionId);
      return options.stopped?.(sessionId) ?? { ok: true, stopped: { taken: [], queued: [], compaction: false } };
    },
    rewind: async () => failure("unsupported", "not in this double"),
    compact: async () => failure("unsupported", "not in this double"),
    update: async () => failure("unsupported", "not in this double"),
    delete: async () => failure("unsupported", "not in this double"),
    messages: {
      get: async (key) =>
        sessions
          .get(sessionId)
          ?.messages.find((message) =>
            "messageId" in key ? message.messageId === key.messageId : message.idempotencyKey === key.idempotencyKey,
          ),
      follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      cancel: async () => ({ ok: true }),
    },
  });

  const agent: ScriptedAgent = {
    invoke: (request) => ({
      async *[Symbol.asyncIterator]() {
        let messageId: string | undefined;
        let sessionId = request.sessionId ?? "";
        let answer = "";
        const textOf = answerText();
        for await (const event of script(request)) {
          if (event.type === "accepted") {
            messageId = event.message.messageId;
            sessionId = request.sessionId ?? event.sessionId;
          }
          if (event.type === "message_delta" || event.type === "entry") answer += textOf(event);
          if (messageId !== undefined && event.type === "done" && event.message.messageId === messageId) {
            keep(request, sessionId, messageId, event.message.outcome, answer);
          }
          yield event;
        }
      },
    }),
    sessions: {
      create: async (options = {}) => {
        forks.push(options);
        return { ok: true, sessionId: options.sessionId ?? `session-${forks.length}` };
      },
      list: async () => [],
      get: session,
    },
    info: () => ({
      protocolVersion: "1.0",
      capabilities: {
        steer: false,
        fork: true,
        rewind: false,
        compaction: false,
        delete: false,
        updatable: [],
        durableQueue: false,
        durableWork: false,
        toolProgress: true,
        usage: false,
      },
    }),
    models: async () => [],
    commands: async () => [],
    forks,
    aborted,
  };
  return agent;
}

/** What a stop answers when it stopped work in progress. */
export const stoppedRun: AbortResult = { ok: true, stopped: { taken: ["message"], queued: [], compaction: false } };

/** `agent` with its sessions' `abort` answering `stopped`, each session it is called for recorded in `aborted`. */
export function withStop(agent: Agent, stopped: (sessionId: string) => AbortResult): Agent & { aborted: string[] } {
  const aborted: string[] = [];
  return {
    ...agent,
    sessions: {
      ...agent.sessions,
      get: (sessionId) => ({
        ...agent.sessions.get(sessionId),
        abort: async () => {
          aborted.push(sessionId);
          return stopped(sessionId);
        },
      }),
    },
    aborted,
  };
}
