/**
 * Run one turn (the IO half of canonical Feishu→Agent translation): assemble its inputs — resolve the reply
 * referent (a summon that replies to an earlier message names it only by `parent_id`; the content is
 * NOT in the event, so it is fetched here) and the attachments (vision images inline, files to disk) —
 * and stream `agent.invoke` with the assembled prompt. Split from parse.ts (which is pure) because this
 * half touches the Open API + disk; split from feishu.ts so the factory keeps only wiring and the
 * per-turn lifecycle.
 *
 * Inputs have two tiers. PRIMARY is the summoning message plus the message it explicitly replied to;
 * any load failure there aborts visibly so the Agent never runs without an input the user pointed at.
 * BUFFERED resources come from earlier un-summoned thread/group discussion and degrade per attachment:
 * one expired background file must not block the current ask or hide its still-readable siblings.
 */
import { type Agent, type AgentEvent, type ImageRef, SESSION_BUSY_CODE } from "../../agent.ts";
import { log } from "../../log.ts";
import type { FeishuBufferedRef } from "./context-buffer.ts";
import type { DownloadedFile, FeishuApi } from "./feishu-api.ts";
import { type FeishuMention, parseContent } from "./parse.ts";
import { codePointPrefix } from "../text.ts";

/** Appended to the prompt (not the system prompt): the channel renders the reply in a card, and the
 *  card's markdown element is the natural fit for LLM output — steer away from HTML/plain. */
const MARKDOWN_INSTRUCTION = "\n\n(Format your reply in standard Markdown — it is rendered in a Feishu/Lark card.)";

/** Everything the transport needs to fetch a turn's attachments. */
export interface FeishuTurnTransport {
  api: FeishuApi;
  chatId: string;
  filesDir: string;
  label: string;
}

/** An attachment reference: the resource key inside its CARRYING message (the resource API addresses
 *  bytes by message_id + key, so the pair travels together through the turn record). */
export interface FeishuAttachmentInput {
  msg: string;
  key: string;
  name?: string;
}

/** A turn's primary resources plus background resources folded from the context buffer. */
export interface FeishuTurnAttachments {
  primary: {
    images: FeishuAttachmentInput[];
    files: FeishuAttachmentInput[];
    /** The replied-to message's id, when the summon is a reply. */
    parentId?: string;
  };
  buffered: { files: FeishuBufferedRef[]; images: FeishuBufferedRef[]; skipped: number };
}

/** A turn's inputs, resolved to what agent.invoke consumes: vision images inline, plus a prompt suffix
 *  (the reply-referent block + the downloaded-file manifest) appended after the base text. */
interface ResolvedInputs {
  images: ImageRef[] | undefined;
  promptSuffix: string;
}

/**
 * Resolve a turn's inputs (module header): fetch the reply referent's content, then load every image
 * (vision) and file (disk). Primary failures throw; buffered resources degrade independently.
 */
async function resolveTurnInputs(t: FeishuTurnTransport, attachments: FeishuTurnAttachments): Promise<ResolvedInputs> {
  const images = [...attachments.primary.images];
  const files = [...attachments.primary.files];
  let referentBlock = "";
  if (attachments.primary.parentId !== undefined) {
    const parentId = attachments.primary.parentId;
    const parent = await t.api.getMessage(parentId);
    if (!parent) throw new Error(`replied-to message ${parentId} is not readable`);
    const parsed = parseContent({
      message_type: parent.msg_type ?? "unknown",
      content: parent.body?.content ?? "",
      mentions: parent.mentions as FeishuMention[] | undefined,
    });
    // The referent's own resources join the turn as primary inputs, carried by the PARENT message id.
    for (const key of parsed.imageKeys) images.push({ msg: parentId, key });
    for (const ref of parsed.fileRefs) files.push({ msg: parentId, key: ref.key, name: ref.name });
    // getMessage's sender is `{ id, id_type, sender_type }` — a DIFFERENT shape from the event's
    // sender (`{ sender_id: { open_id } }`), so the label is built here, not via parse.senderLabel.
    const senderId = (parent.sender as { id?: string } | undefined)?.id;
    const from = senderId ? `user ${senderId}` : undefined;
    referentBlock = `\n\n[replied-to message (msg ${parentId}${from ? `, from ${from}` : ""}): ${codePointPrefix(parsed.text, 560) || "(empty)"}]`;
  }

  // Primary first and fail-fast: these are resources the current user explicitly pointed at.
  const imageRefs: ImageRef[] = [];
  for (const ref of images) imageRefs.push(await t.api.fetchImage(ref.msg, ref.key));
  const downloaded: DownloadedFile[] = [];
  for (const ref of files)
    downloaded.push(await t.api.fetchFile(ref.msg, ref.key, ref.name ?? ref.key, t.chatId, t.filesDir));

  // A replied-to buffered message is now primary. Filter by message-scoped identity so it is not
  // downloaded twice or rendered twice in the manifest.
  const primaryImages = new Set(images.map((ref) => `${ref.msg}\u0000${ref.key}`));
  const primaryFiles = new Set(files.map((ref) => `${ref.msg}\u0000${ref.key}`));
  const bufferedImages = attachments.buffered.images.filter(
    (ref) => !primaryImages.has(`${ref.messageId}\u0000${ref.key}`),
  );
  const bufferedFiles = attachments.buffered.files.filter(
    (ref) => !primaryFiles.has(`${ref.messageId}\u0000${ref.key}`),
  );
  const backgroundImages: { image: ImageRef; ref: FeishuBufferedRef }[] = [];
  const backgroundFiles: { file: DownloadedFile; ref: FeishuBufferedRef }[] = [];
  let lost = 0;
  const imageResults = await Promise.allSettled(
    bufferedImages.map(async (ref) => ({ ref, image: await t.api.fetchImage(ref.messageId, ref.key) })),
  );
  for (const result of imageResults) {
    if (result.status === "fulfilled") backgroundImages.push(result.value);
    else {
      lost++;
      log.warn(`${t.label} could not load an earlier (buffered) image: ${String(result.reason)}`);
    }
  }
  const fileResults = await Promise.allSettled(
    bufferedFiles.map(async (ref) => ({
      ref,
      file: await t.api.fetchFile(ref.messageId, ref.key, ref.name ?? ref.key, t.chatId, t.filesDir),
    })),
  );
  for (const result of fileResults) {
    if (result.status === "fulfilled") backgroundFiles.push(result.value);
    else {
      lost++;
      log.warn(`${t.label} could not load an earlier (buffered) attachment: ${String(result.reason)}`);
    }
  }
  const missing = lost + attachments.buffered.skipped;
  const bufferedNote =
    missing > 0
      ? `\n[note: ${missing} attachment(s) from the earlier discussion are not loaded (expired, or older than the most recent few)]`
      : "";
  const backgroundImageManifest = backgroundImages.length
    ? `\n\n[background vision images from earlier discussion — appended after ${imageRefs.length} primary image(s):\n${backgroundImages
        .map(
          ({ ref }, index) => `- vision image ${imageRefs.length + index + 1}: from ${ref.from}, msg ${ref.messageId}`,
        )
        .join("\n")}\n]`
    : "";
  const allFiles = [
    ...downloaded,
    ...backgroundFiles.map(({ file, ref }) => ({
      ...file,
      name: `${file.name} (from ${ref.from}, msg ${ref.messageId}, earlier discussion)`,
    })),
  ];
  const manifest = allFiles.length
    ? `\n\n[attached files — read them with your tools:\n${allFiles.map((file) => `- ${file.name} (${file.size} bytes) → ${file.path}`).join("\n")}\n]`
    : "";
  const allImages = [...imageRefs, ...backgroundImages.map(({ image }) => image)];
  return {
    images: allImages.length ? allImages : undefined,
    promptSuffix: `${referentBlock}${bufferedNote}${backgroundImageManifest}${manifest}`,
  };
}

/** How the busy-wait paces: retry the invoke every `delayMs` while the session's lease is held by an
 *  EXTERNAL turn (a self-scheduled wake, a concurrent embedder invoke), up to `maxWaitMs` total. The
 *  channel's own turns never collide (the turn-queue serializes per session), so a busy reject here is
 *  always an outside holder — wait for it like a queued turn, instead of erroring at the user. */
export interface BusyRetry {
  delayMs: number;
  maxWaitMs: number;
}
// Each retry is a lease-check-level reject (tryAcquire runs before harness assembly) — waiting is nearly
// free, and the loop exits within one delay of the holder finishing. The cap is sized to outlast a real
// tool-using wake turn (minutes); a holder that runs longer still surfaces the busy error to the user.
const DEFAULT_BUSY_RETRY: BusyRetry = { delayMs: 5_000, maxWaitMs: 600_000 };

/**
 * Run one turn: resolve its inputs, then stream agent.invoke. A primary-input failure surfaces as a
 * `failed` event (never a silent drop). `onCompleted` (if given) fires on the `completed` event — the
 * durable-commit point; the caller uses it to remove the turn intent (turn-store L1) at the earliest
 * moment the turn provably lives in the session.
 *
 * BUSY-WAIT: a `failed{code: session_busy}` FIRST event means an external turn holds this session's
 * lease and OUR turn never started — replay-safe. Retry (bounded) instead of yielding it: the user sees
 * the "Thinking…" preview while waiting, and only an exhausted wait surfaces the busy failure. Only a
 * FIRST-event busy retries — inputs are already resolved, and a fail-fast reject is the only shape the
 * engine emits it in, so nothing that started is ever re-run.
 */
export async function* invokeFeishuTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: FeishuTurnTransport,
  attachments: FeishuTurnAttachments,
  onCompleted?: () => void,
  busyRetry: BusyRetry = DEFAULT_BUSY_RETRY,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedInputs;
  try {
    resolved = await resolveTurnInputs(transport, attachments);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  const prompt = { text: `${text}${resolved.promptSuffix}${MARKDOWN_INSTRUCTION}`, images: resolved.images };
  const deadline = Date.now() + busyRetry.maxWaitMs;
  for (;;) {
    let retryBusy = false;
    let first = true;
    for await (const e of agent.invoke({ session }, prompt)) {
      if (first && e.type === "failed" && e.code === SESSION_BUSY_CODE && Date.now() + busyRetry.delayMs < deadline) {
        retryBusy = true; // fail-fast reject — the stream ends after this event; wait and re-invoke
        break;
      }
      first = false;
      if (e.type === "completed") onCompleted?.(); // the turn is durably in the session — commit point
      yield e;
    }
    if (!retryBusy) return;
    log.info(
      `${transport.label} session ${session} is busy (an external turn holds it) — retrying in ${busyRetry.delayMs}ms`,
    );
    await new Promise((r) => setTimeout(r, busyRetry.delayMs));
  }
}
