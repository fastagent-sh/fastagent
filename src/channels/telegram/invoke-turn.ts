/**
 * Run one turn (the IO half of Telegram→Agent translation): assemble its inputs — resolve attachments
 * (download files to disk, load vision images) — and stream `agent.invoke` with the assembled prompt.
 * `invokeTurn` is the export; attachment resolution is an internal step. Split from parse.ts (which is
 * pure) because this half touches the Bot API + disk; split from telegram.ts so the factory keeps only
 * wiring and the per-turn lifecycle.
 */
import { type Agent, type AgentEvent, type ImageRef, SESSION_BUSY_CODE } from "../../agent.ts";
import { log } from "../../log.ts";
import type { BufferedRef } from "./context-buffer.ts";
import { type DownloadedFile, resolveFiles, resolveImages } from "./telegram-api.ts";

/** Appended to the prompt (not the system prompt): the channel owns Telegram-HTML formatting. */
const HTML_INSTRUCTION =
  "\n\n(Format your reply in Telegram-supported HTML — <b> <i> <u> <s> <code> <pre> <a href> — not Markdown.)";

/** Everything the transport needs to fetch a turn's attachments. */
export interface TurnTransport {
  api: string;
  botToken: string;
  chatId: number | string;
  filesDir: string;
}

/** A turn's attachment inputs: the summoning message's own file_ids (primary) and the ones folded in
 *  from the un-summoned discussion (buffered). */
export interface TurnAttachments {
  primary: { imageFileIds?: string[]; fileIds?: string[] };
  buffered: { files: BufferedRef[]; images: BufferedRef[]; skipped: number };
}

/** A turn's attachments, resolved to what agent.invoke consumes: vision images inline, plus a prompt
 *  suffix (the file manifest + a missing-attachment note) appended after the prompt, before the HTML hint. */
interface ResolvedAttachments {
  images: ImageRef[] | undefined;
  promptSuffix: string;
}

/**
 * Resolve a turn's attachments: images (vision) inline, files downloaded to disk with their absolute
 * paths listed in a manifest the agent reads with its tools. Two tiers, different failure policies.
 * PRIMARY (this turn's own message) THROWS on any load failure — the caller turns it into a `failed`
 * event, so the agent never runs on inputs the user sent but we failed to load. BACKGROUND (`buffered`,
 * from the un-summoned discussion) degrades PER ATTACHMENT — a warn + a prompt note — rather than
 * failing the ask it merely accompanies: one expired earlier file must neither block the answer nor drag
 * down its still-valid siblings. Parallel (allSettled keeps input order + per-attachment isolation); the
 * note counts EVERY missing one (load failures + cap-skipped) so the model never holds a reference it
 * silently cannot open.
 */
async function resolveTurnAttachments(t: TurnTransport, attachments: TurnAttachments): Promise<ResolvedAttachments> {
  const { api, botToken, chatId, filesDir } = t;
  const { primary, buffered } = attachments;
  const images = await resolveImages(api, botToken, primary.imageFileIds);
  const files = await resolveFiles(api, botToken, primary.fileIds, chatId, filesDir);
  const bufferedImages: ImageRef[] = [];
  const bufferedFiles: { file: DownloadedFile; ref: BufferedRef }[] = [];
  let lost = 0;
  const imageResults = await Promise.allSettled(buffered.images.map((ref) => resolveImages(api, botToken, [ref.id])));
  for (const r of imageResults) {
    if (r.status === "fulfilled") bufferedImages.push(...(r.value ?? []));
    else {
      lost++;
      log.warn(`[telegram] could not load an earlier (buffered) photo: ${String(r.reason)}`);
    }
  }
  const fileResults = await Promise.allSettled(
    buffered.files.map(async (ref) => ({
      ref,
      files: (await resolveFiles(api, botToken, [ref.id], chatId, filesDir)) ?? [],
    })),
  );
  for (const r of fileResults) {
    if (r.status === "fulfilled") {
      for (const file of r.value.files) bufferedFiles.push({ file, ref: r.value.ref });
    } else {
      lost++;
      log.warn(`[telegram] could not load an earlier (buffered) attachment: ${String(r.reason)}`);
    }
  }
  const missing = lost + buffered.skipped;
  const bufferedNote =
    missing > 0
      ? `\n[note: ${missing} attachment(s) from the earlier discussion are not loaded (expired, or older than the most recent few)]`
      : "";
  // PRIMARY first, background after — consistent with "primary wins": what the user pointed at this
  // turn leads. Buffered file entries are attributed like the fold's text lines ("the file Bob sent"
  // resolves); buffered PHOTOS cannot be (ImageRef carries no label), so their attribution stops at
  // the fold's attachment markers (the buffer appends `[photo]` even to captioned lines) — a
  // documented limit.
  const allFiles = [
    ...(files ?? []),
    ...bufferedFiles.map(({ file, ref }) => ({
      ...file,
      name: `${file.name} (from ${ref.from}${ref.msg !== undefined ? `, msg ${ref.msg}` : ""}, earlier discussion)`,
    })),
  ];
  const manifest = allFiles.length
    ? `\n\n[attached files — read them with your tools:\n${allFiles.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
    : "";
  const allImages = [...(images ?? []), ...bufferedImages];
  return { images: allImages.length ? allImages : undefined, promptSuffix: `${bufferedNote}${manifest}` };
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
// free, and the loop exits within one delay of the holder finishing. So the cap is sized to outlast a
// real tool-using wake turn (minutes), not to be short: 10 min. CEILING: a holder that runs longer than
// this still surfaces the busy error to the user — the bound exists so a stuck lease can't hang a chat
// turn forever.
const DEFAULT_BUSY_RETRY: BusyRetry = { delayMs: 5_000, maxWaitMs: 600_000 };

/**
 * Run one turn: resolve its attachments, then stream agent.invoke. A primary-attachment failure surfaces
 * as a `failed` event (never a silent drop). `onCompleted` (if given) fires on the turn's `completed`
 * event — the durable-commit point: only then does the folded discussion provably live in the session,
 * so a failure or crash at ANY earlier point leaves the buffer intact for the next summon (a re-folded
 * block beats lost context). The caller uses it to remove the turn intent AND commit the context buffer,
 * in that order (see the call site) so a crash between the two clears cannot replay a context-stripped turn.
 *
 * BUSY-WAIT: a `failed{code: session_busy}` FIRST event means an external turn (e.g. a self-scheduled
 * wake) holds this session's lease and OUR turn never started — replay-safe. Retry (bounded) instead of
 * yielding it: the user sees the "Thinking…" placeholder while waiting (the mirror of the scheduler
 * deferring a wake INTO a busy session), and only an exhausted wait surfaces the busy failure. Only a
 * FIRST-event busy retries — attachments are already resolved, and a fail-fast reject is the only shape
 * the engine emits it in, so nothing that started is ever re-run.
 */
export async function* invokeTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: TurnTransport,
  attachments: TurnAttachments,
  onCompleted?: () => void,
  busyRetry: BusyRetry = DEFAULT_BUSY_RETRY,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedAttachments;
  try {
    resolved = await resolveTurnAttachments(transport, attachments);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  const prompt = { text: `${text}${resolved.promptSuffix}${HTML_INSTRUCTION}`, images: resolved.images };
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
    log.info(`[telegram] session ${session} is busy (an external turn holds it) — retrying in ${busyRetry.delayMs}ms`);
    await new Promise((r) => setTimeout(r, busyRetry.delayMs));
  }
}
