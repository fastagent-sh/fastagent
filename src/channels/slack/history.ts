/**
 * A Slack place's history, read when a turn runs (docs/design/place-history.md): a channel's top level from
 * `conversations.history`, a thread from `conversations.replies`. What a place remembers between turns, and what a
 * read leaves out, is the kit's (`createPlaceHistory`). A message's `ts` is its id and its position at once: the
 * turn's ask is the read's exclusive `latest`, and the next read's cursor. Each read lists the newest page before the
 * ask and stops at the cursor itself, as Feishu's does: Slack has no reliable "after this point" (`SlackRange`).
 */
import { capBufferedRefs } from "../kit/context-buffer.ts";
import {
  type PlaceDiscussion,
  type PlaceHistory,
  type PlaceListing,
  type PlaceMessage,
  type PlaceRead,
  createPlaceHistory,
} from "../kit/place-history.ts";
import { type ThreadSummary, threadList } from "../kit/room-threads.ts";
import { CONTEXT_READ } from "../kit/transport.ts";
import { slackMessageText } from "./parse.ts";
import { log } from "../../log.ts";
import { type SlackApi, SlackApiError, type SlackListedMessage } from "./slack-api.ts";

/** How many of a place's newest messages one read keeps; a place busier than this since its last answer says so. */
const PAGE_SIZE = 50;

/** What a place's first answered turn reads back, with no cursor yet. */
const FIRST_READ = 20;

/** Message subtypes that are someone saying something; every other subtype is the platform's (a join, a topic). */
const SPOKEN_SUBTYPES = new Set(["file_share", "thread_broadcast", "bot_message", "me_message"]);

export type SlackPlaceRead = PlaceRead<string>;
export type SlackDiscussion = PlaceDiscussion<string>;
export interface SlackPlaceHistory extends PlaceHistory<string> {
  /** The channel's threads among its newest messages, for a tool (`kit/room-threads.ts`); `room` is its place key. */
  threads(room: string): Promise<string>;
}

/** How long a person's name is reused before it is looked up again. */
const NAMES_TTL_MS = 10 * 60_000;

/** How many of a channel's newest messages a thread list looks through. */
const THREAD_SCAN = 100;

/** A background file carried into a turn, with attribution for its prompt manifest. */
export interface SlackBufferedFileRef {
  id: string;
  from: string;
  messageId: string;
}

/** A place: a channel's top level, or a thread in it. The turn record carries it as this key. */
export function slackHistoryKey(teamId: string, place: { channelId: string; threadTs?: string }): string {
  const base = `${teamId}:${place.channelId}`;
  return place.threadTs ? `${base}:root:${place.threadTs}` : base;
}

/** The inverse of {@link slackHistoryKey}. Slack ids and timestamps never contain a colon. */
export function slackPlaceOf(key: string): { teamId: string; channelId: string; threadTs?: string } {
  const [teamId = "", channelId = "", , threadTs] = key.split(":");
  return { teamId, channelId, ...(threadTs ? { threadTs } : {}) };
}

/**
 * Order two Slack timestamps (`seconds.micros`). A double tells microseconds apart until 2^33 seconds (the year 2242),
 * so plain numbers compare them exactly.
 */
const compareSlackTs = (a: string, b: string): number => Number(a) - Number(b);

/** Select the most recent background files of the folded messages, excluding the turn's own. */
export function collectFoldedFiles(
  folded: readonly PlaceMessage[],
  primaryIds: ReadonlySet<string>,
): { files: SlackBufferedFileRef[]; skipped: number } {
  const seen = new Set(primaryIds);
  const files: SlackBufferedFileRef[] = [];
  for (const message of folded) {
    for (const file of message.files) {
      if (seen.has(file.key)) continue;
      seen.add(file.key);
      files.push({ id: file.key, from: message.from.label, messageId: message.id });
    }
  }
  const capped = capBufferedRefs(files);
  return { files: capped.kept, skipped: capped.skipped };
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
 * What a message says. A Markdown post (every answer and `slack-send` post) is stored as blocks, and its `text` is a
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

export function createSlackPlaceHistory(deps: {
  api: Pick<SlackApi, "channelHistory" | "threadReplies" | "userName">;
  /** THIS app's bot user and bot ids, once `auth.test` answered: a message from either is the agent's own. */
  self(): { userId?: string; botId?: string };
  label: string;
  /** Where each place's cursor and outputs persist. */
  path: string;
  isTurnInput(key: string, ts: string): boolean;
}): SlackPlaceHistory {
  const { api } = deps;

  /**
   * The people already looked up, named or known to have no name to find (a failed lookup). Both halves expire
   * together, so a failure or a renamed person is retried after the TTL, not on every turn. Without `users:read`
   * nothing is looked up again in this process: a reinstall grants it to the same token, and the next start uses it.
   */
  let names = { named: new Map<string, string>(), unnamed: new Set<string>(), at: Date.now() };
  let scopeMissing = false;

  /** Names for the people a fold shows; one not found is shown by user id. Never rejects: a name is a label. */
  const peopleNames = async (messages: readonly SlackListedMessage[]): Promise<ReadonlyMap<string, string>> => {
    if (Date.now() - names.at >= NAMES_TTL_MS) names = { named: new Map(), unnamed: new Set(), at: Date.now() };
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
    if (scopeMissing || unknown.length === 0) return named;
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
      scopeMissing = true;
      log.warn(
        `${deps.label} users:read is not granted, so people are shown by user id — add it under the Slack app's OAuth & Permissions → Bot Token Scopes (an app \`fastagent add slack\` created gets it with the next \`dev --tunnel\` or \`deploy --run\`), then Reinstall to Workspace`,
      );
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

  const read = async (
    key: string,
    { cursor, drop }: { cursor?: string; drop(ts: string): boolean },
    until?: string,
  ): Promise<PlaceListing<string>> => {
    const place = slackPlaceOf(key);
    const range = { ...(until ? { latest: until } : {}), limit: cursor ? PAGE_SIZE : FIRST_READ };
    const page =
      place.threadTs === undefined
        ? await api.channelHistory(place.channelId, range, CONTEXT_READ).then(({ messages, hasMore }) => ({
            messages: messages.reverse(),
            hasMore,
          }))
        : await api
            .threadReplies(place.channelId, place.threadTs, range, CONTEXT_READ)
            .then(({ messages, hasMore }) => ({
              // The root comes first whatever the range: it is this place's discussion only on a first read.
              messages: messages.filter((message) => message.ts !== place.threadTs || cursor === undefined),
              hasMore,
            }));
    const after = (ts: string): boolean => cursor === undefined || compareSlackTs(ts, cursor) > 0;
    const listed = page.messages.filter(
      (message): message is SlackListedMessage & { ts: string } => message.ts !== undefined,
    );
    const fresh = listed.filter((message) => after(message.ts));
    const earlier = page.hasMore && fresh.length === listed.length;

    const spoken = fresh.filter(
      (message) =>
        message.hidden !== true &&
        (message.subtype === undefined || SPOKEN_SUBTYPES.has(message.subtype)) &&
        !drop(message.ts),
    );
    const people = await peopleNames(spoken);
    const messages = spoken
      .map((message): PlaceMessage | undefined => {
        const from = speaker(message, people);
        const text = slackMessageText({ text: spokenText(message), files: message.files });
        // No text, attachment or file to show: an empty line would only spend the fold's budget.
        if (text.trim() === "") return undefined;
        return {
          id: message.ts,
          at: Number(message.ts) * 1000,
          from,
          text,
          images: [],
          // Whether a file is an image is `files.info`'s answer, read when the turn loads it.
          files: (message.files ?? []).flatMap((file) =>
            file.id ? [{ key: file.id, ...(file.name ? { name: file.name } : {}) }] : [],
          ),
        };
      })
      .filter((message) => message !== undefined);
    const newest = fresh.at(-1)?.ts;
    return {
      covered: fresh.map((message) => message.ts),
      messages,
      ...(newest ? { newest } : {}),
      earlier,
    };
  };

  /** Threads are roots with replies; `conversations.history` gives their count and last reply. */
  const threads = async (room: string): Promise<string> => {
    const { channelId } = slackPlaceOf(room);
    const { messages } = await api.channelHistory(channelId, { limit: THREAD_SCAN }, CONTEXT_READ);
    const roots = messages.filter(
      (message): message is SlackListedMessage & { ts: string } =>
        message.ts !== undefined && (message.reply_count ?? 0) > 0,
    );
    const people = await peopleNames(roots);
    const summaries = roots.map(
      (message): ThreadSummary => ({
        id: message.ts,
        time: { at: Number(message.latest_reply ?? message.ts) * 1000, is: "last active" },
        replies: message.reply_count as number,
        first: { label: speaker(message, people).label, text: spokenText(message) },
      }),
    );
    return threadList(summaries, `this channel's newest ${THREAD_SCAN} messages`);
  };

  const history = createPlaceHistory({
    label: deps.label,
    path: deps.path,
    isCursor: (value): value is string => typeof value === "string",
    compare: compareSlackTs,
    isTurnInput: deps.isTurnInput,
    read,
  });
  return { ...history, threads };
}
