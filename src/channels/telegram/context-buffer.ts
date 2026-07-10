/**
 * Group-context buffer: recent UN-summoned messages per Telegram "place" (chat[:thread]), kept under a
 * char budget and folded into the next answered turn's prompt, so a summoned agent has the discussion
 * it didn't see turn-by-turn. Bucketed by place (not session): an un-summoned message has no route
 * session, and the flush feeds whatever turn answers that place.
 *
 * DURABLE: persisted synchronously before the webhook 200 (Telegram never redelivers an ACKed update,
 * so ACK-then-persist would be a silent-loss window) and reloaded on start. The consume protocol is
 * peek → (turn completes) → commit: peek renders WITHOUT clearing and snapshots exactly which entries
 * it consumed; commit removes only those, by object identity — so a failure or crash before the turn's
 * `completed` leaves them intact for the next summon, and a message that arrives while the turn runs
 * survives for the next answered turn (a whole-bucket delete would lose it).
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

/** Char budget for the per-place buffer — bounds the cost of folding it into a prompt; when exceeded
 *  the OLDEST un-summoned messages are dropped (not a time window: a quiet group keeps its
 *  sparse-but-relevant lines, a busy burst is capped). */
const BUFFER_MAX_CHARS = 4000;

/** One buffered un-summoned message (object identity is the commit key). Besides the sender label and
 *  one-line body, it carries what a LATER summon needs to resolve references into the discussion:
 *  message ids ("reply to the one Alex answered"), and attachment file_ids so "summarize the file from
 *  earlier" can actually open it — an un-summoned attachment otherwise surfaces only as its caption or
 *  a `[document: …]` label, never the bytes. */
export interface BufferEntry {
  sender: string;
  body: string;
  /** The message's id — rendered into the fold so the model can correlate replies. */
  messageId?: number;
  /** The message_id this one replied to, when it was a reply. */
  replyTo?: number;
  /** file_ids of document/voice/video/audio attachments (downloadable on a later summon). */
  fileIds?: string[];
  /** file_ids of photos (usable as vision inputs on a later summon). */
  imageIds?: string[];
}

/** A buffered attachment reference: its file_id plus WHO posted it in WHICH message, so the manifest
 *  can attribute it ("the file Bob sent") the way the fold attributes text. */
export interface BufferedRef {
  id: string;
  from: string;
  msg?: number;
}

/** How many buffered files and images (each, most recent first) a summon pulls in with the folded
 *  discussion — bounds the latency/token cost of "summarize the file from earlier" against a chatty
 *  group posting many attachments between summons. Skipped ones are counted into the prompt note, so
 *  the model never sees an attachment reference it silently cannot open. */
const BUFFER_ATTACH_MAX = 3;

/** One fold line. ALSO the eviction cost basis: the budget must price what the fold actually renders
 *  (sender + body + the msg/reply meta), or the fold would systematically overrun BUFFER_MAX_CHARS. */
function bufferLine(e: BufferEntry): string {
  const meta = [
    e.messageId !== undefined ? `msg ${e.messageId}` : undefined,
    e.replyTo !== undefined ? `reply to msg ${e.replyTo}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `${e.sender}${meta ? ` (${meta})` : ""}: ${e.body}`;
}

/**
 * The buffered attachment references a summoned turn pulls in with the fold — most recent
 * BUFFER_ATTACH_MAX of each kind, MINUS the summoning message's own ids: replying to a still-buffered
 * attachment puts its file_id in both sets, and without the filter the same file would download twice
 * and appear in the manifest twice (primary wins — it is what the user pointed at this turn).
 * Cap-skipped ones are COUNTED, not silently dropped: a fold line may show a [document: …] label, but
 * a captioned attachment renders as its caption text alone — without a note, the model holds
 * references it silently cannot open and may pretend it read them.
 */
export function collectAttachments(
  consumed: BufferEntry[],
  primary: { files: Set<string>; images: Set<string> },
): { files: BufferedRef[]; images: BufferedRef[]; skipped: number } {
  const refs = (pick: (e: BufferEntry) => string[] | undefined, exclude: Set<string>): BufferedRef[] => {
    const seen = new Set<string>();
    const out: BufferedRef[] = [];
    for (const e of consumed) {
      for (const id of pick(e) ?? []) {
        if (exclude.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, from: e.sender, msg: e.messageId });
      }
    }
    return out;
  };
  const files = refs((e) => e.fileIds, primary.files);
  const images = refs((e) => e.imageIds, primary.images);
  return {
    files: files.slice(-BUFFER_ATTACH_MAX),
    images: images.slice(-BUFFER_ATTACH_MAX),
    skipped: Math.max(0, files.length - BUFFER_ATTACH_MAX) + Math.max(0, images.length - BUFFER_ATTACH_MAX),
  };
}

export interface ContextBuffer {
  /** Record an un-summoned message. Persists BEFORE returning (pre-ACK: a throw becomes the webhook's
   *  500, and Telegram redelivers once the disk recovers) — staged on a copy and rolled back on a
   *  failed write, so the redelivery does not double-append the entry already in memory. */
  push(placeKey: string, entry: BufferEntry): void;
  /** Render the fold text and snapshot the consumed entries (see the module header's consume protocol). */
  peek(placeKey: string): { text: string; consumed: BufferEntry[] };
  /** Remove exactly `consumed` (by identity) — call on the turn's `completed` event, when the folded
   *  discussion provably lives in the durable session. Consumes entries WHOLE, including ones whose
   *  attachments failed to load or were cap-skipped: their text is in the session (keeping them would
   *  re-fold duplicate text), and the prompt note said what is missing; re-post an attachment to use
   *  it. Post-ACK: a failed write is logged, never thrown (it must not abort the turn's delivery). */
  commit(placeKey: string, consumed: BufferEntry[]): void;
}

/** State files are an IO boundary: valid JSON of the WRONG SHAPE (hand-edited, version drift) must
 *  degrade exactly like a corrupt file — warn + empty — not flow in as trusted data. */
function isBufferEntry(e: unknown): e is BufferEntry {
  const t = e as BufferEntry;
  const strings = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  return (
    typeof t?.sender === "string" &&
    typeof t.body === "string" &&
    (t.messageId === undefined || typeof t.messageId === "number") &&
    (t.replyTo === undefined || typeof t.replyTo === "number") &&
    strings(t.fileIds) &&
    strings(t.imageIds)
  );
}

export function createContextBuffer(path: string): ContextBuffer {
  const load = (): Map<string, BufferEntry[]> => {
    const raw = loadStateFile(path);
    if (raw === undefined) return new Map();
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every((v) => Array.isArray(v) && v.every(isBufferEntry))
    ) {
      return new Map(Object.entries(raw as Record<string, BufferEntry[]>));
    }
    log.warn(`[telegram] unexpected shape in ${path} — starting with an empty buffer`);
    return new Map();
  };
  const buffers = load();
  const persist = (): void => saveStateFile(path, Object.fromEntries(buffers));

  return {
    push(placeKey, entry) {
      const prev = buffers.get(placeKey);
      const buf = prev ? [...prev] : [];
      buf.push(entry);
      let total = buf.reduce((n, e) => n + bufferLine(e).length + 1, 0);
      while (buf.length > 1 && total > BUFFER_MAX_CHARS) {
        const dropped = buf.shift();
        if (dropped) total -= bufferLine(dropped).length + 1;
      }
      buffers.set(placeKey, buf);
      try {
        persist();
      } catch (e) {
        if (prev) buffers.set(placeKey, prev);
        else buffers.delete(placeKey);
        throw e;
      }
    },
    peek(placeKey) {
      const buf = buffers.get(placeKey) ?? [];
      return { text: buf.map(bufferLine).join("\n"), consumed: [...buf] };
    },
    commit(placeKey, consumed) {
      const buf = buffers.get(placeKey);
      if (!buf) return;
      const remaining = buf.filter((e) => !consumed.includes(e));
      if (remaining.length === 0) buffers.delete(placeKey);
      else buffers.set(placeKey, remaining);
      try {
        persist();
      } catch (e) {
        log.error(`[telegram] buffer write failed post-ACK (a restart may re-fold answered discussion): ${String(e)}`);
      }
    },
  };
}
