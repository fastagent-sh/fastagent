/**
 * An Agent whose messages a test scripts: `messages.send` answers with what the script yields first (the message as
 * recorded, or why there is none), and the rest reaches the session's readers after the message's own `user` entry, as
 * `messages.stream` delivers a message. The rest of the Agent is what a channel asks of it, kept just faithful enough
 * to observe:
 *   - each message is recorded under its session, with its key and answer, so `entries` and `messages.get` answer for
 *     it (a thread forks from a room by the message its reply chain names);
 *   - any session id a message is sent to names a session, so a test need not create each; `sessions.create` records
 *     what it is asked for (`forks`);
 *   - `sessions.cancel` records the session (`canceled`) and answers what `stopped` says, nothing running by default.
 */
import {
  type Agent,
  AgentError,
  type CreateSessionOptions,
  type Entry,
  type Json,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
  type Session,
  type SessionEvent,
  agentError,
  hasEnded,
} from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";

export type Script = (request: SendRequest) => AsyncIterable<TurnEvent> | Iterable<TurnEvent>;

export interface ScriptedAgent extends Agent {
  /** Every `sessions.create`, in order. */
  forks: CreateSessionOptions[];
  /** Every session `sessions.cancel` was called for, in order. */
  canceled: string[];
  /** Every message sent, in order. */
  sent: SendRequest[];
}

interface Reader {
  push(event: SessionEvent): void;
  fail(error: unknown): void;
}

interface Kept {
  entries: Entry[];
  messages: Message[];
  readers: Set<Reader>;
  /** A message's end, for a `messages.get` that waits for it. */
  endings: Map<string, PromiseWithResolvers<Message>>;
}

const sessionOf = (id: string): Session => ({ id, status: "idle", usage: { models: {}, tools: {} } });

/** A session's events from now on: a snapshot first when `snapshot`, then each as it is published. */
function reader(kept: Kept, snapshot: Session | undefined): AsyncIterator<SessionEvent> {
  const ready: IteratorResult<SessionEvent>[] =
    snapshot === undefined ? [] : [{ done: false, value: { type: "state", session: snapshot } }];
  let waiting: { resolve: (r: IteratorResult<SessionEvent>) => void; reject: (e: unknown) => void } | undefined;
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

const iterate = <T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> | Iterator<T> =>
  Symbol.asyncIterator in source
    ? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
    : (source as Iterable<T>)[Symbol.iterator]();

const contentOf = (content: SendRequest["content"]): Json =>
  (typeof content === "string" ? [{ type: "text", text: content }] : content) as Json;

const userMessageOf = (entry: Entry): string | undefined =>
  entry.kind === "user" ? (entry.data as { messageId?: string }).messageId : undefined;

export function scriptedAgent(
  script: Script,
  options: { stopped?: (sessionId: string) => { stopped: string[] } } = {},
): ScriptedAgent {
  const sessions = new Map<string, Kept>();
  const forks: CreateSessionOptions[] = [];
  const canceled: string[] = [];
  const sent: SendRequest[] = [];
  let created = 0;
  let entries = 0;
  let messages = 0;

  const keptOf = (sessionId: string): Kept => {
    const kept = sessions.get(sessionId) ?? { entries: [], messages: [], readers: new Set(), endings: new Map() };
    sessions.set(sessionId, kept);
    return kept;
  };
  const existing = (sessionId: string): Kept => {
    const kept = sessions.get(sessionId);
    if (kept === undefined) throw agentError("not_found", `No session ${sessionId}`);
    return kept;
  };
  const publish = (kept: Kept, event: SessionEvent) => {
    for (const reader of kept.readers) reader.push(event);
  };
  const setStatus = (kept: Kept, message: Message) => {
    const at = kept.messages.findIndex((other) => other.id === message.id);
    if (at === -1) kept.messages.push(message);
    else kept.messages[at] = message;
    if (hasEnded(message)) endingOf(kept, message.id).resolve(message);
  };
  const endingOf = (kept: Kept, id: string) => {
    const ending = kept.endings.get(id) ?? Promise.withResolvers<Message>();
    kept.endings.set(id, ending);
    return ending;
  };

  /** The message's own entry, then what the script yields after it was recorded, each kept and published. */
  const run = async (
    kept: Kept,
    request: SendRequest,
    message: Message,
    rest: AsyncIterator<TurnEvent> | Iterator<TurnEvent>,
  ) => {
    const own: Entry = {
      id: `e${++entries}`,
      timestamp: Date.now(),
      kind: "user",
      data: { content: contentOf(request.content), messageId: message.id },
    };
    kept.entries.push(own);
    setStatus(kept, { ...message, status: "running", entryId: own.id });
    publish(kept, { type: "entry", entry: own });
    let answer: { entryId: string; text: string } | undefined;
    let written = "";
    /** The answer as the harness settles it: an entry for what was written, when the script yielded none. */
    const settleAnswer = () => {
      if (answer !== undefined || written === "") return;
      const entry: Entry = { id: `e${++entries}`, timestamp: Date.now(), kind: "assistant", data: { text: written } };
      kept.entries.push(entry);
      answer = { entryId: entry.id, text: written };
      publish(kept, { type: "entry", entry });
    };
    try {
      for (let next = await rest.next(); !next.done; next = await rest.next()) {
        const event = next.value;
        if (event.type === "message" || event.type === "rejected") continue;
        if (event.type === "entry") {
          const entry = { ...event.entry, id: `e${++entries}` };
          kept.entries.push(entry);
          if (entry.kind === "assistant")
            answer = { entryId: entry.id, text: (entry.data as { text?: string }).text ?? "" };
          publish(kept, { type: "entry", entry });
          continue;
        }
        if (event.type === "delta" && event.channel === "text") written += event.text;
        if (event.type === "done" && event.message.id === message.id) {
          settleAnswer();
          // The answer is the entry kept here, by the id this session gave it.
          const { answer: _, ...end } = event.message;
          const done: Message = {
            ...end,
            sessionId: message.sessionId,
            ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
            entryId: own.id,
            ...(answer && (end.status === "completed" || end.status === "incomplete") ? { answer } : {}),
          };
          setStatus(kept, done);
          publish(kept, { type: "done", message: done });
          continue;
        }
        publish(kept, event);
      }
    } catch (error) {
      // The session's events fail, saying why.
      for (const reader of kept.readers) reader.fail(error);
    }
  };

  const send = async (request: SendRequest): Promise<Message> => {
    const kept = keptOf(request.sessionId);
    sent.push(request);
    const events = iterate(script(request));
    const first = await events.next();
    if (!first.done && first.value.type === "rejected") throw new AgentError(first.value.error);
    const recorded = !first.done && first.value.type === "message" ? first.value.message : undefined;
    // A script that starts with the session's events, not the message, is a message recorded as it starts.
    const rest: AsyncIterator<TurnEvent> | Iterator<TurnEvent> =
      recorded !== undefined || first.done
        ? events
        : (async function* () {
            yield first.value;
            for (let next = await events.next(); !next.done; next = await events.next()) yield next.value;
          })();
    const message: Message = {
      ...(recorded ?? { status: "queued" as const }),
      id: recorded?.id ?? `message-${++messages}`,
      sessionId: request.sessionId,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    };
    setStatus(kept, message);
    void Promise.resolve().then(() => run(kept, request, message, rest));
    return message;
  };

  const agent: ScriptedAgent = {
    info: async () => ({ name: "scripted", commands: [], tools: [], models: [] }),
    usage: async () => ({ models: {}, tools: {} }),
    sessions: {
      async create(createOptions = {}) {
        forks.push(createOptions);
        const from = createOptions.forkFrom;
        if (from !== undefined) existing(from.sessionId);
        const sessionId = `session-${++created}`;
        const kept = keptOf(sessionId);
        if (from !== undefined) {
          const source = keptOf(from.sessionId).entries;
          const through =
            from.entryId === undefined ? source.length : source.findIndex((entry) => entry.id === from.entryId) + 1;
          kept.entries.push(...source.slice(0, through));
        }
        return sessionOf(sessionId);
      },
      get: async (sessionId) => {
        existing(sessionId);
        return sessionOf(sessionId);
      },
      list: async () => ({ data: [...sessions.keys()].map(sessionOf) }),
      update: async (sessionId) => {
        existing(sessionId);
        return sessionOf(sessionId);
      },
      async entries(sessionId, entriesOptions = {}) {
        const kept = existing(sessionId);
        const from =
          entriesOptions.after === undefined
            ? 0
            : kept.entries.findIndex((entry) => entry.id === entriesOptions.after) + 1;
        return { data: kept.entries.slice(from) };
      },
      events(sessionId, eventsOptions = {}) {
        return {
          [Symbol.asyncIterator]: () => {
            if (eventsOptions.after !== undefined) {
              return {
                next: () => Promise.reject(agentError("internal", "replay is not in this double")),
                return: async () => ({ done: true, value: undefined }),
              };
            }
            // Any session id is one: a test names its sessions rather than creating each.
            return reader(keptOf(sessionId), sessionOf(sessionId));
          },
        };
      },
      cancel: async (sessionId) => {
        canceled.push(sessionId);
        return options.stopped?.(sessionId) ?? { stopped: [] };
      },
      compact: async (sessionId) => {
        existing(sessionId);
      },
      attachment: async (sessionId, ref) => {
        throw agentError("not_found", `No attachment ${ref} in session ${sessionId}`);
      },
    },
    messages: {
      async send(request, sendOptions) {
        const message = await send(request);
        if (sendOptions?.wait === undefined) return message;
        return agent.messages.get({ sessionId: message.sessionId, messageId: message.id }, sendOptions);
      },
      stream(request) {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
            const watching = reader(keptOf(request.sessionId), undefined);
            try {
              const message = await send(request);
              yield { type: "message", message };
              let opened = false;
              for (let next = await watching.next(); !next.done; next = await watching.next()) {
                const event = next.value;
                if (event.type === "stream_error") return yield event;
                if (event.type === "done" && event.message.id === message.id) return yield event;
                if (!opened && event.type === "entry" && userMessageOf(event.entry) === message.id) opened = true;
                if (opened) yield event;
              }
            } finally {
              await watching.return?.();
            }
          },
        };
      },
      async get(key, getOptions = {}) {
        const kept = existing(key.sessionId);
        const found = kept.messages.find((message) =>
          "messageId" in key ? message.id === key.messageId : message.idempotencyKey === key.idempotencyKey,
        );
        if (found === undefined) throw agentError("not_found", `No such message in session ${key.sessionId}`);
        if (getOptions.wait === undefined || hasEnded(found)) return found;
        const timeout = new Promise<Message>((resolve) => {
          if (Number.isFinite(getOptions.wait)) setTimeout(() => resolve(found), (getOptions.wait as number) * 1000);
        });
        return Promise.race([endingOf(kept, found.id).promise, timeout]);
      },
    },
    forks,
    canceled,
    sent,
  };
  return agent;
}

/** What a stop answers when it stopped work in progress. */
export const stoppedRun = { stopped: ["message"] };

/** `agent` with its `sessions.cancel` answering `stopped`, each session it is called for recorded in `canceled`. */
export function withStop<A extends Agent>(
  agent: A,
  stopped: (sessionId: string) => { stopped: string[] },
): A & { canceled: string[] } {
  const canceled: string[] = [];
  return {
    ...agent,
    sessions: {
      ...agent.sessions,
      cancel: async (sessionId: string) => {
        canceled.push(sessionId);
        return stopped(sessionId);
      },
    },
    canceled,
  };
}

/** What a message asks, read back as text and images: the shape a channel builds its content from. */
export interface Prompt {
  text: string;
  images?: { mimeType: string; data: string }[];
}

export function promptOf(request: Pick<SendRequest, "content">): Prompt {
  const parts =
    typeof request.content === "string" ? [{ type: "text" as const, text: request.content }] : request.content;
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const images = parts.flatMap((part) => (part.type === "image" ? [{ mimeType: part.mimeType, data: part.data }] : []));
  return images.length > 0 ? { text, images } : { text };
}

/** A message as a test records it: the request, and what it asks read back ({@link promptOf}). */
export type Asked = SendRequest & { prompt: Prompt };

export const asked = (request: SendRequest): Asked => ({ ...request, prompt: promptOf(request) });
