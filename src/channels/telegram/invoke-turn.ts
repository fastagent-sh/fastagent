/**
 * Run one turn (the IO half of Telegram→Agent translation): assemble its inputs — resolve attachments
 * (download files to disk, load vision images) — and stream `agent.invoke` with the assembled prompt.
 * `invokeTurn` is the export; attachment resolution is an internal step. Split from parse.ts (which is
 * pure) because this half touches the Bot API + disk; split from telegram.ts so the factory keeps only
 * wiring and the per-turn lifecycle.
 */
import type { Agent, AgentEvent, ImageRef } from "../../agent.ts";
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

/**
 * Run one turn: resolve its attachments, then stream agent.invoke. A primary-attachment failure surfaces
 * as a `failed` event (never a silent drop). `onCompleted` (if given) fires on the turn's `completed`
 * event — the durable-commit point: only then does the folded discussion provably live in the session,
 * so a failure or crash at ANY earlier point leaves the buffer intact for the next summon (a re-folded
 * block beats lost context). The caller uses it to remove the turn intent AND commit the context buffer,
 * in that order (see the call site) so a crash between the two clears cannot replay a context-stripped turn.
 */
export async function* invokeTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: TurnTransport,
  attachments: TurnAttachments,
  onCompleted?: () => void,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedAttachments;
  try {
    resolved = await resolveTurnAttachments(transport, attachments);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  for await (const e of agent.invoke(
    { session },
    { text: `${text}${resolved.promptSuffix}${HTML_INSTRUCTION}`, images: resolved.images },
  )) {
    if (e.type === "completed") onCompleted?.(); // the turn is durably in the session — commit point
    yield e;
  }
}
