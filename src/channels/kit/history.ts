/**
 * The `history` tool a channel gives the agent: the recent messages of the place the calling session's turn was asked in
 * (a chat, a channel, a thread), read when the agent asks for them rather than folded into every turn. A channel says
 * where each turn runs ({@link SessionPlaces}) and how one of its places is read; the tool reads only that place, or a
 * thread in it. Also: where a thread's session forks from.
 */
import { type Agent, AgentError, type Message } from "../../agent-api.ts";
import type { ChannelTool, ForkSource } from "../../channel.ts";
import { truncateCodePointPrefix } from "./text.ts";

/** One message of a place, as the tool shows it. */
export interface PlaceMessage {
  id: string;
  from: { kind: "human" | "self" | "bot"; label: string };
  text: string;
  replyTo?: string;
  /** The thread this message opened, when it opened one. */
  thread?: { id: string; replies?: number };
}

/** A read of a place: its newest messages, oldest first, and whether earlier ones exist. */
export interface PlaceRead {
  messages: PlaceMessage[];
  earlier: boolean;
}

const HISTORY_DEFAULT_LIMIT = 30;
/** Feishu lists at most 50 messages a page, and one read is one page. */
export const HISTORY_MAX_LIMIT = 50;

const MESSAGE_MAX_CHARS = 2000;

function placeLine(message: PlaceMessage): string {
  const body = truncateCodePointPrefix(message.text.replace(/\s+/g, " ").trim(), MESSAGE_MAX_CHARS, " … (truncated)");
  const thread = message.thread;
  const meta = [
    `msg ${message.id}`,
    message.replyTo ? `reply to msg ${message.replyTo}` : undefined,
    thread
      ? `opened thread ${thread.id}${thread.replies === undefined ? "" : ` with ${thread.replies} repl${thread.replies === 1 ? "y" : "ies"}`}`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `${message.from.label} (${meta}): ${body}`;
}

function historyText({ messages, earlier }: PlaceRead, where: string): string {
  if (messages.length === 0) return `No messages ${where}.`;
  const head = `The ${messages.length} most recent messages ${where}, oldest first${earlier ? " (there are earlier ones)" : ""}:`;
  return [head, ...messages.map(placeLine)].join("\n");
}

/** Where each session's turn runs, while it runs: what the `history` tool reads. */
export interface SessionPlaces {
  /** The session's turn runs in `place` until the returned leave is called. */
  enter(sessionId: string, place: string): () => void;
  placeOf(sessionId: string): string | undefined;
}

export function createSessionPlaces(): SessionPlaces {
  const places = new Map<string, string>();
  return {
    enter(session, place) {
      places.set(session, place);
      return () => {
        if (places.get(session) === place) places.delete(session);
      };
    },
    placeOf: (session) => places.get(session),
  };
}

/**
 * The `history` tool of the channel `kind`. `places` is the mounted channel's, undefined until it is served in this
 * process; `read` reads one of its places, or a thread in it.
 */
export function historyTool(
  kind: string,
  places: () => SessionPlaces | undefined,
  read: (place: string, query: { limit: number; threadId?: string }) => Promise<PlaceRead>,
  threadId: string,
): ChannelTool {
  return {
    name: "history",
    description:
      "Read the recent messages of the chat, channel or thread you are answering in, oldest first: who said what, " +
      "with message ids and reply links. Call it when the message refers to something said here that you have not " +
      "seen, such as an earlier discussion, a decision or a file someone sent. A message that opened a thread says " +
      "so; pass that thread's id as `threadId` to read the thread. Only the place you are answering in can be read, " +
      "and only in a chat turn.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: HISTORY_MAX_LIMIT,
          description: `how many of the newest messages to read (default ${HISTORY_DEFAULT_LIMIT})`,
        },
        threadId: { type: "string", description: threadId },
      },
      additionalProperties: false,
    },
    async execute(args, { sessionId }) {
      const serving = places();
      if (serving === undefined) {
        throw new Error(`the ${kind} channel is not serving in this process: history is read only in a chat turn`);
      }
      const place = sessionId === undefined ? undefined : serving.placeOf(sessionId);
      if (place === undefined) {
        throw new Error(`this is not a ${kind} chat turn: history is read only from the place a turn was asked in`);
      }
      const { limit = HISTORY_DEFAULT_LIMIT, threadId: thread } = args as { limit?: number; threadId?: string };
      const found = await read(place, { limit, ...(thread === undefined ? {} : { threadId: thread }) });
      return historyText(found, thread === undefined ? "here" : `in thread ${thread}`);
    },
  };
}

function forkPoint(message: Message): string | undefined {
  if (message.status === "queued") return undefined;
  return message.answer?.entryId ?? message.entryId;
}

export async function threadForkSource(agent: Agent, sessionId: string | undefined, ask: string): Promise<ForkSource> {
  if (sessionId === undefined) return undefined;
  const message = await agent.messages.get({ sessionId, idempotencyKey: ask }).catch((error: unknown) => {
    if (error instanceof AgentError && error.code === "not_found") return undefined;
    throw error;
  });
  if (message === undefined) return undefined;
  const entryId = forkPoint(message);
  return { sessionId, ...(entryId === undefined ? {} : { entryId }) };
}
