/**
 * An Agent whose messages a test scripts: `invoke` answers with what the script yields first (its receipt, or why
 * there is none), and the rest reaches the session's `resume` readers after the message's own `user_message` entry, as
 * `stream` reads a message. The rest of the Agent is what a channel asks of it, kept just faithful enough to observe:
 *   - each message is recorded under its session, with its key and answer, so `read` and `getMessage` answer for it (a
 *     thread forks from a room by the message its reply chain names);
 *   - any session id names a session, so a test need not create each; `createSession` records what it is asked for
 *     (`forks`);
 *   - `abort` records the session (`aborted`) and answers what `stopped` says, nothing running by default.
 */
import type {
  AbortResult,
  Agent,
  CreateSessionOptions,
  DoneMessage,
  Entry,
  InvokeRequest,
  Json,
  MessageStatus,
  ResumeEvent,
  SessionEvent,
  SessionState,
} from "../src/agent-api.ts";
import { failure } from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";

export type Script = (request: InvokeRequest & { sessionId: string }) => AsyncIterable<TurnEvent> | Iterable<TurnEvent>;

export interface ScriptedAgent extends Agent {
  /** Every `createSession`, in order. */
  forks: CreateSessionOptions[];
  /** Every session `abort` was called for, in order. */
  aborted: string[];
  /** Every message sent, in order, with the session it was sent to. */
  sent: (InvokeRequest & { sessionId: string })[];
}

interface Reader {
  push(event: SessionEvent): void;
  fail(error: unknown): void;
}

interface Kept {
  entries: Entry[];
  messages: MessageStatus[];
  readers: Set<Reader>;
}

const idle = (): SessionState => ({ status: "idle", taken: [], queued: [], usage: { models: {}, tools: {} } });

/** A session's events from now on, as `resume` gives them: a snapshot first, then each as it is published. */
function reader(kept: Kept): AsyncIterator<ResumeEvent> {
  const ready: IteratorResult<ResumeEvent>[] = [{ done: false, value: { type: "state", state: idle() } }];
  let waiting: { resolve: (r: IteratorResult<ResumeEvent>) => void; reject: (e: unknown) => void } | undefined;
  let failed: { error: unknown } | undefined;
  const self: Reader = {
    push(event) {
      const result = { done: false, value: event } as const;
      if (waiting) {
        waiting.resolve(result);
        waiting = undefined;
      } else ready.push(result);
    },
    fail(error) {
      if (waiting) {
        waiting.reject(error);
        waiting = undefined;
      } else failed = { error };
    },
  };
  kept.readers.add(self);
  return {
    next() {
      const result = ready.shift();
      if (result) return Promise.resolve(result);
      if (failed) return Promise.reject(failed.error);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    return() {
      kept.readers.delete(self);
      waiting?.resolve({ done: true, value: undefined });
      waiting = undefined;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
}

export function scriptedAgent(script: Script, options: { stopped?: (sessionId: string) => AbortResult } = {}) {
  const sessions = new Map<string, Kept>();
  const forks: CreateSessionOptions[] = [];
  const aborted: string[] = [];
  const sent: ScriptedAgent["sent"] = [];
  let created = 0;
  let entries = 0;
  let messages = 0;

  const keptOf = (sessionId: string): Kept => {
    const kept = sessions.get(sessionId) ?? { entries: [], messages: [], readers: new Set() };
    sessions.set(sessionId, kept);
    return kept;
  };
  const publish = (kept: Kept, event: SessionEvent) => {
    for (const reader of kept.readers) reader.push(event);
  };
  const setStatus = (kept: Kept, status: MessageStatus) => {
    const at = kept.messages.findIndex((message) => message.messageId === status.messageId);
    if (at === -1) kept.messages.push(status);
    else kept.messages[at] = status;
  };

  /** The message's own entry, then what the script yields after its receipt, each kept and published. */
  const run = async (
    kept: Kept,
    sessionId: string,
    request: InvokeRequest,
    messageId: string,
    rest: AsyncIterator<TurnEvent> | Iterator<TurnEvent>,
    settled: (message: DoneMessage) => void,
  ) => {
    const key = request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey };
    const own: Entry = {
      id: `e${++entries}`,
      sessionId,
      timestamp: Date.now(),
      kind: "user_message",
      data: { content: request.content as Json, messageId, ...key } as Json,
    };
    kept.entries.push(own);
    setStatus(kept, { messageId, ...key, status: "taken", entryId: own.id });
    publish(kept, { type: "entry", entry: own });
    let answer: { entryId: string; text: string } | undefined;
    try {
      for (let next = await rest.next(); !next.done; next = await rest.next()) {
        const event = next.value;
        if (event.type === "accepted" || event.type === "rejected" || event.type === "unknown") continue;
        if (event.type === "entry") {
          const entry = { ...event.entry, sessionId, id: `e${++entries}` };
          kept.entries.push(entry);
          if (entry.kind === "assistant_message") {
            answer = { entryId: entry.id, text: (entry.data as { text?: string }).text ?? "" };
          }
          publish(kept, { type: "entry", entry });
          continue;
        }
        if (event.type === "done" && event.message.messageId === messageId) {
          // The answer is the entry kept here, by the id this session gave it.
          const done: DoneMessage = { ...event.message, ...key, entryId: own.id, ...(answer ? { answer } : {}) };
          setStatus(kept, done);
          publish(kept, { type: "done", message: done });
          settled(done);
          continue;
        }
        publish(kept, event);
      }
    } catch (error) {
      for (const reader of kept.readers) reader.fail(error);
    }
  };

  const agent: ScriptedAgent = {
    info: () => ({ protocolVersion: "1.0", name: "scripted", inputs: ["text", "image"], commands: [] }),
    async invoke(request) {
      let sessionId = request.sessionId;
      if (sessionId === undefined) {
        const made = await agent.createSession();
        if (!made.ok) return made;
        sessionId = made.sessionId;
      }
      const kept = keptOf(sessionId);
      const asked = { ...request, sessionId };
      sent.push(asked);
      const source = script(asked);
      const events: AsyncIterator<TurnEvent> | Iterator<TurnEvent> =
        Symbol.asyncIterator in source
          ? (source as AsyncIterable<TurnEvent>)[Symbol.asyncIterator]()
          : (source as Iterable<TurnEvent>)[Symbol.iterator]();
      const first = await events.next();
      if (!first.done && first.value.type === "rejected") return { ok: false, error: first.value.error };
      if (!first.done && first.value.type === "unknown") return { ok: false, unknown: { reason: first.value.reason } };
      const accepted = !first.done && first.value.type === "accepted" ? first.value : undefined;
      const messageId = accepted?.message.messageId ?? `message-${++messages}`;
      // A script that starts with the session's events, not a receipt, is a message accepted as it starts.
      const rest: AsyncIterator<TurnEvent> | Iterator<TurnEvent> =
        accepted !== undefined || first.done
          ? events
          : (async function* () {
              yield first.value;
              for (let next = await events.next(); !next.done; next = await events.next()) yield next.value;
            })();
      const message: MessageStatus = accepted?.message ?? { messageId, status: "queued", position: 0 };
      const key = request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey };
      setStatus(kept, { ...message, ...key });
      let settle: (message: DoneMessage) => void = () => {};
      const done = new Promise<DoneMessage>((resolve) => {
        settle = resolve;
      });
      void Promise.resolve().then(() => run(kept, asked.sessionId, request, messageId, rest, settle));
      return {
        ok: true,
        sessionId,
        message: { ...message, ...key },
        duplicate: accepted?.duplicate ?? false,
        wait: async () => ({ ok: true, message: await done }),
      };
    },
    getMessage: async (sessionId, key) =>
      sessions
        .get(sessionId)
        ?.messages.find((message) =>
          "messageId" in key ? message.messageId === key.messageId : message.idempotencyKey === key.idempotencyKey,
        ),
    async createSession(options = {}) {
      forks.push(options);
      if (options.from !== undefined && !sessions.has(options.from.sessionId)) {
        return failure("not_found", `No session ${options.from.sessionId}`);
      }
      const sessionId = `session-${++created}`;
      const kept = keptOf(sessionId);
      if (options.from !== undefined) {
        const source = keptOf(options.from.sessionId).entries;
        const through =
          options.from.entryId === undefined
            ? source.length
            : source.findIndex((entry) => entry.id === options.from?.entryId) + 1;
        kept.entries.push(...source.slice(0, through).map((entry) => ({ ...entry, sessionId })));
      }
      return { ok: true, sessionId };
    },
    configure: async () => ({ ok: true }),
    async read(sessionId, options = {}) {
      const kept = sessions.get(sessionId);
      if (!kept) return failure("not_found", `No session ${sessionId}`);
      const from = options.after === undefined ? 0 : kept.entries.findIndex((entry) => entry.id === options.after) + 1;
      return { ok: true, state: idle(), entries: kept.entries.slice(from) };
    },
    resume(sessionId, options = {}) {
      return {
        [Symbol.asyncIterator]: () => {
          if (options.replayFrom !== undefined) {
            const refused: IteratorResult<ResumeEvent> = {
              done: false,
              value: { type: "rejected", error: failure("internal", "replay is not in this double").error },
            };
            let given = false;
            return {
              next: async () => (given ? { done: true, value: undefined } : ((given = true), refused)),
              return: async () => ({ done: true, value: undefined }),
            };
          }
          // Any session id is one: a test names its sessions rather than creating each.
          return reader(keptOf(sessionId));
        },
      };
    },
    abort: async (sessionId) => {
      aborted.push(sessionId);
      return options.stopped?.(sessionId) ?? { ok: true, stopped: { taken: [], queued: [] } };
    },
    attachment: async () => undefined,
    listSessions: async () => ({ ok: true, sessions: [...sessions.keys()].map((sessionId) => ({ sessionId })) }),
    forks,
    aborted,
    sent,
  };
  return agent;
}

/** What a stop answers when it stopped work in progress. */
export const stoppedRun: AbortResult = { ok: true, stopped: { taken: ["message"], queued: [] } };

/** `agent` with its `abort` answering `stopped`, each session it is called for recorded in `aborted`. */
export function withStop<A extends Agent>(
  agent: A,
  stopped: (sessionId: string) => AbortResult,
): A & { aborted: string[] } {
  const aborted: string[] = [];
  return {
    ...agent,
    abort: async (sessionId: string) => {
      aborted.push(sessionId);
      return stopped(sessionId);
    },
    aborted,
  };
}

/** What a message asks, read back as text and images: the shape a channel builds its content from. */
export interface Prompt {
  text: string;
  images?: { mimeType: string; data: string }[];
}

export function promptOf(request: Pick<InvokeRequest, "content">): Prompt {
  const text = request.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const images = request.content.flatMap((part) =>
    part.type === "image" && "data" in part ? [{ mimeType: part.mimeType, data: part.data }] : [],
  );
  return images.length > 0 ? { text, images } : { text };
}

/** A message as a test records it: the request, and what it asks read back ({@link promptOf}). */
export type Asked = InvokeRequest & { sessionId: string; prompt: Prompt };

export const asked = (request: InvokeRequest & { sessionId: string }): Asked => ({
  ...request,
  prompt: promptOf(request),
});
