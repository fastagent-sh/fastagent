/**
 * What a turn learns about its place (a chat, or a thread in one) beyond its own ask — and the fold that renders it,
 * shared by every channel whose platform can be read (docs/design/place-history.md).
 *
 * Two sources fill a turn's discussion: the context buffer (`context-buffer.ts`), for a platform with no history read,
 * and the place's own history, read from the platform when the turn runs. The turn runner sees only
 * {@link DiscussionSource}.
 */
import { BUFFER_LINE_MAX_CHARS, BUFFER_MAX_CHARS } from "./context-buffer.ts";
import { truncateCodePointPrefix } from "./text.ts";

/**
 * Where a turn's discussion comes from. `peek` snapshots what this turn folds; `commit` runs when the turn's answer
 * is recorded, so a failure or crash before then leaves the discussion to be folded again.
 */
export interface DiscussionSource<E> {
  /** Never rejects: a source that cannot read says so in `text`, and the turn proceeds without it. */
  peek(key: string): { text: string; consumed: E[] } | Promise<{ text: string; consumed: E[] }>;
  commit(key: string, consumed: E[]): void;
}

/** One message of a place, as the fold renders it. */
export interface PlaceMessage {
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** "self": this agent, outside its own turn answers (a schedule's digest, a post from another chat). */
  from: { kind: "human" | "self" | "bot"; label: string };
  text: string;
  replyTo?: string;
  images: { key: string }[];
  files: { key: string; name?: string }[];
}

/**
 * Per-message bound for the agent's own post. A digest runs to thousands of characters; the line bound would keep its
 * title only. It stays inside the budget, so later discussion still pushes it out.
 */
const PLACE_OWN_MAX_CHARS = 2000;

function line(message: PlaceMessage): string {
  const own = message.from.kind === "self";
  const body = truncateCodePointPrefix(
    message.text.replace(/\s+/g, " ").trim(),
    own ? PLACE_OWN_MAX_CHARS : BUFFER_LINE_MAX_CHARS,
    own ? " … (truncated)" : "…",
  );
  const meta = [`msg ${message.id}`, message.replyTo ? `reply to msg ${message.replyTo}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `${message.from.label} (${meta}): ${body}`;
}

/**
 * Render `messages` (oldest first) newest-first into the buffer's budget (the same bound, whichever the source). What the budget leaves out, and what the read never
 * reached (`earlier`), is said in a line, never dropped silently.
 */
export function foldPlace(
  messages: readonly PlaceMessage[],
  earlier: boolean,
): { text: string; folded: PlaceMessage[] } {
  const lines: string[] = [];
  const folded: PlaceMessage[] = [];
  let used = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as PlaceMessage;
    const rendered = line(message);
    if (cut > 0 || used + rendered.length + 1 > BUFFER_MAX_CHARS) {
      cut++;
      continue;
    }
    used += rendered.length + 1;
    lines.unshift(rendered);
    folded.unshift(message);
  }
  if (cut > 0 || earlier) {
    lines.unshift(
      cut > 0
        ? `(${cut}${earlier ? "+" : ""} earlier message${cut === 1 && !earlier ? "" : "s"} here not shown)`
        : "(earlier messages here not shown)",
    );
  }
  return { text: folded.length > 0 || cut > 0 ? lines.join("\n") : "", folded };
}
