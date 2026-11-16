/**
 * A Slack place's history, read when the `history` tool asks: a channel's top level from `conversations.history`, a
 * thread from `conversations.replies`, its people named through `users.info`. Nothing is kept: Slack asks an app not to
 * store what it reads.
 */
import type { PlaceMessage, PlaceRead } from "../kit/history.ts";
import { CONTEXT_READ } from "../kit/ingress.ts";
import { slackMessageText } from "./parse.ts";
import { log } from "../../log.ts";
import { type SlackApi, SlackApiError, type SlackListedMessage } from "./slack-api.ts";

/** Message subtypes that are someone saying something; every other subtype is the platform's (a join, a topic). */
const SPOKEN_SUBTYPES = new Set(["file_share", "thread_broadcast", "bot_message", "me_message"]);

/** How long a person's name is reused before it is looked up again. */
const NAMES_TTL_MS = 10 * 60_000;

/** How many of a thread's replies one read lists: Slack lists a thread oldest first. */
const THREAD_PAGE = 1000;

/** A place: a channel's top level, or a thread in it. The turn record carries it as this key. */
export function slackHistoryKey(teamId: string, place: { channelId: string; threadTs?: string }): string {
  const base = `${teamId}:${place.channelId}`;
  return place.threadTs ? `${base}:root:${place.threadTs}` : base;
}

/** The inverse of {@link slackHistoryKey}. Slack ids and timestamps never contain a colon. */
function slackPlaceOf(key: string): { teamId: string; channelId: string; threadTs?: string } {
  const [teamId = "", channelId = "", , threadTs] = key.split(":");
  return { teamId, channelId, ...(threadTs ? { threadTs } : {}) };
}

/** A block's text, or undefined for a block this does not know how to read. */
type BlockReader = (block: Record<string, unknown>) => string | undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
const textOf = (value: unknown): string | undefined => str((value as { text?: unknown } | undefined)?.text);

/** One run of `rich_text`, as the person wrote it. */
function inline(element: Record<string, unknown>): string | undefined {
  switch (element.type) {
    case "text":
      return str(element.text);
    case "link":
      return str(element.text) ?? str(element.url);
    case "user":
      return `<@${str(element.user_id)}>`;
    case "usergroup":
      return `<!subteam^${str(element.usergroup_id)}>`;
    case "channel":
      return `<#${str(element.channel_id)}>`;
    case "emoji":
      return `:${str(element.name)}:`;
    case "broadcast":
      return `@${str(element.range)}`;
    case "date":
      return str(element.fallback) ?? "";
    default:
      return undefined;
  }
}

function joined<T>(items: T[], read: (item: T) => string | undefined, separator: string): string | undefined {
  const parts = items.map(read);
  return parts.every((part) => part !== undefined) ? parts.join(separator) : undefined;
}

/** A `rich_text` block: sections, lists, quotes and code, each a run of inline elements. */
function richText(block: Record<string, unknown>): string | undefined {
  return joined(
    list(block.elements),
    (element) => {
      const runs = (item: Record<string, unknown>) => joined(list(item.elements), inline, "");
      switch (element.type) {
        case "rich_text_section":
        case "rich_text_preformatted":
          return runs(element);
        case "rich_text_quote": {
          const run = runs(element);
          return run === undefined ? undefined : `> ${run}`;
        }
        case "rich_text_list": {
          // A list split by other blocks continues its numbering from `offset`.
          const first = typeof element.offset === "number" ? element.offset + 1 : 1;
          return joined(
            list(element.elements).map((item, index) => ({ item, index })),
            ({ item, index }) => {
              const run = runs(item);
              return run === undefined
                ? undefined
                : `${element.style === "ordered" ? `${first + index}.` : "-"} ${run}`;
            },
            "\n",
          );
        }
        default:
          return undefined;
      }
    },
    // Each element is a block (a paragraph, a list, a quote, code): Slack does not always end one with a newline.
    "\n",
  );
}

const BLOCKS: Record<string, BlockReader> = {
  header: (block) => textOf(block.text),
  section: (block) => [textOf(block.text), ...list(block.fields).map(textOf)].filter(Boolean).join("\n"),
  context: (block) => list(block.elements).map(textOf).filter(Boolean).join(" "),
  markdown: (block) => str(block.text),
  divider: () => "---",
  image: (block) => `[image${str(block.alt_text) ? `: ${str(block.alt_text)}` : ""}]`,
  rich_text: richText,
  // A cell is `rich_text` or `raw_text`.
  table: (block) =>
    joined(
      Array.isArray(block.rows) ? (block.rows as unknown[]) : [],
      (row) => joined(list(row), (cell) => (cell.type === "raw_text" ? str(cell.text) : richText(cell)), " | "),
      "\n",
    ),
};

/**
 * What a message says. A Markdown post (every answer and `send` post) is stored as blocks, and its `text` is a
 * rendering that drops a table to ", with interactive elements" (measured), so the blocks are read when this knows them
 * all, and `text` otherwise. Legacy attachments follow: an integration often says everything there.
 */
function spokenText(message: SlackListedMessage): string {
  const blocks = list(message.blocks);
  const read = joined(blocks, (block) => BLOCKS[String(block.type)]?.(block), "\n");
  const body = blocks.length > 0 && read !== undefined ? read : (message.text ?? "");
  const attached = (message.attachments ?? []).map((attachment) => {
    const parts = [attachment.pretext, attachment.title, attachment.text].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : (attachment.fallback ?? "");
  });
  return [body, ...attached].filter((part) => part.trim() !== "").join("\n");
}

export function createSlackHistory(deps: {
  api: Pick<SlackApi, "channelHistory" | "threadReplies" | "userName">;
  /** THIS app's bot user and bot ids, once `auth.test` answered: a message from either is the agent's own. */
  self(): { userId?: string; botId?: string };
  label: string;
}): (place: string, query: { limit: number; threadId?: string }) => Promise<PlaceRead> {
  const { api } = deps;

  /**
   * The people already looked up, named or known to have no name to find (a failed lookup), and whether the app
   * lacks `users:read`. All of it expires together, so a failure, a renamed person or a scope granted by a reinstall
   * is picked up after the TTL, not on every turn and not only at the next start.
   */
  const fresh = () => ({
    named: new Map<string, string>(),
    unnamed: new Set<string>(),
    scopeMissing: false,
    at: Date.now(),
  });
  let names = fresh();
  /** The missing scope is said once per process: after that, each retry would only repeat it. */
  let scopeWarned = false;

  /** Names for the people a read shows; one not found is shown by user id. Never rejects: a name is a label. */
  const peopleNames = async (messages: readonly SlackListedMessage[]): Promise<ReadonlyMap<string, string>> => {
    if (Date.now() - names.at >= NAMES_TTL_MS) names = fresh();
    const { named, unnamed } = names;
    const self = deps.self();
    const wanted = new Set(
      messages.flatMap((message) =>
        message.user !== undefined && message.bot_id === undefined && message.user !== self.userId
          ? [message.user]
          : [],
      ),
    );
    const unknown = [...wanted].filter((id) => !named.has(id) && !unnamed.has(id));
    if (names.scopeMissing || unknown.length === 0) return named;
    const failures: unknown[] = [];
    await Promise.all(
      unknown.map(async (id) => {
        try {
          const name = await api.userName(id, CONTEXT_READ);
          if (name) named.set(id, name);
          else unnamed.add(id);
        } catch (error) {
          unnamed.add(id);
          failures.push(error);
        }
      }),
    );
    const missingScope = failures.find(
      (error) => error instanceof SlackApiError && error.slackError === "missing_scope",
    );
    if (missingScope) {
      names.scopeMissing = true;
      if (!scopeWarned) {
        scopeWarned = true;
        log.warn(
          `${deps.label} users:read is not granted, so people are shown by user id — add it under the Slack app's OAuth & Permissions → Bot Token Scopes (an app \`fastagent channels setup slack\` creates has it), then Reinstall to Workspace; names appear within 10 minutes, or after a restart if the reinstall issued a new Bot Token`,
        );
      }
    } else if (failures.length > 0) {
      log.warn(
        `${deps.label} could not look up ${failures.length} name(s) (shown by user id for 10 minutes): ${String(failures[0])}`,
      );
    }
    return named;
  };

  /** Who said it: this app, another bot, or a person (by name where `users:read` gives one). */
  const speaker = (message: SlackListedMessage, people: ReadonlyMap<string, string>): PlaceMessage["from"] => {
    const self = deps.self();
    const own =
      (message.user !== undefined && message.user === self.userId) ||
      (message.bot_id !== undefined && message.bot_id === self.botId);
    if (own) return { kind: "self", label: "you" };
    if (message.bot_id !== undefined) {
      return { kind: "bot", label: `bot ${message.bot_profile?.name ?? message.username ?? message.bot_id}` };
    }
    const name = message.user === undefined ? undefined : people.get(message.user);
    return { kind: "human", label: name ?? `user ${message.user ?? "unknown"}` };
  };

  /** The place's newest `limit` messages, or those of a thread in its channel. */
  return async (key, { limit, threadId }) => {
    const place = slackPlaceOf(key);
    if (threadId !== undefined && !/^\d+\.\d+$/.test(threadId)) {
      throw new Error(`"${threadId}" is not a Slack thread id: pass a thread's id (like 1712345678.123456)`);
    }
    const thread = threadId ?? place.threadTs;
    const page =
      thread === undefined
        ? await api.channelHistory(place.channelId, { limit }, CONTEXT_READ).then(({ messages, hasMore }) => ({
            messages: messages.reverse(),
            hasMore,
          }))
        : await api.threadReplies(place.channelId, thread, { limit: THREAD_PAGE }, CONTEXT_READ);
    const spoken = page.messages.filter(
      (message): message is SlackListedMessage & { ts: string } =>
        message.ts !== undefined &&
        message.hidden !== true &&
        (message.subtype === undefined || SPOKEN_SUBTYPES.has(message.subtype)),
    );
    const newest = spoken.slice(-limit);
    const people = await peopleNames(newest);
    const messages = newest.flatMap((message): PlaceMessage[] => {
      const text = slackMessageText({ text: spokenText(message), files: message.files });
      if (text.trim() === "") return [];
      const opened = thread === undefined && (message.reply_count ?? 0) > 0;
      return [
        {
          id: message.ts,
          from: speaker(message, people),
          text,
          ...(opened ? { thread: { id: message.ts, replies: message.reply_count as number } } : {}),
        },
      ];
    });
    return { messages, earlier: page.hasMore || spoken.length > newest.length };
  };
}
