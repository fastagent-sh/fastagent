/** Resolve Slack file IDs at dequeue, then stream one engine-neutral Agent turn. */
import type { Agent, AgentEvent, ImageRef } from "../../agent.ts";
import { log } from "../../log.ts";
import {
  type BusyRetry,
  DEFAULT_BUSY_RETRY,
  attachedFilesManifest,
  attributedFileName,
  backgroundImagesManifest,
  missingAttachmentsNote,
  streamTurnWithBusyRetry,
} from "../invoke-turn-kit.ts";
import type { SlackBufferedFileRef } from "./context-buffer.ts";
import type { DownloadedSlackFile, SlackApi } from "./slack-api.ts";

const MARKDOWN_INSTRUCTION =
  "\n\n(Format your reply as standard Markdown. Slack renders it natively. Do not use HTML or Slack control-mention syntax such as <!here>, <!channel>, or <!everyone>.)";

export interface SlackTurnTransport {
  api: SlackApi;
  channelId: string;
  filesDir: string;
  label: string;
}

export interface SlackTurnAttachments {
  primaryFileIds: string[];
  buffered: { files: SlackBufferedFileRef[]; skipped: number };
}

interface ResolvedInputs {
  images: ImageRef[] | undefined;
  promptSuffix: string;
}

async function resolveFile(
  transport: SlackTurnTransport,
  fileId: string,
): Promise<{ image?: ImageRef; file?: DownloadedSlackFile }> {
  const info = await transport.api.fileInfo(fileId);
  return info.mimetype?.toLowerCase().startsWith("image/")
    ? { image: await transport.api.fetchImage(info) }
    : { file: await transport.api.fetchFile(info, transport.channelId, transport.filesDir) };
}

async function resolveInputs(
  transport: SlackTurnTransport,
  attachments: SlackTurnAttachments,
): Promise<ResolvedInputs> {
  const images: ImageRef[] = [];
  const files: DownloadedSlackFile[] = [];
  for (const id of attachments.primaryFileIds) {
    const resolved = await resolveFile(transport, id);
    if (resolved.image) images.push(resolved.image);
    if (resolved.file) files.push(resolved.file);
  }

  const backgroundImages: { image: ImageRef; ref: SlackBufferedFileRef }[] = [];
  const backgroundFiles: { file: DownloadedSlackFile; ref: SlackBufferedFileRef }[] = [];
  let lost = 0;
  const results = await Promise.allSettled(
    attachments.buffered.files.map(async (ref) => ({ ref, resolved: await resolveFile(transport, ref.id) })),
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { ref, resolved } = result.value;
      if (resolved.image) backgroundImages.push({ image: resolved.image, ref });
      if (resolved.file) backgroundFiles.push({ file: resolved.file, ref });
    } else {
      lost++;
      log.warn(`${transport.label} could not load an earlier (buffered) Slack file: ${String(result.reason)}`);
    }
  }

  const missingNote = missingAttachmentsNote(lost + attachments.buffered.skipped);
  const imageManifest = backgroundImagesManifest(
    images.length,
    backgroundImages.map(({ ref }) => ref),
  );
  const allFiles = [
    ...files,
    ...backgroundFiles.map(({ file, ref }) => ({
      ...file,
      name: attributedFileName(file.name, ref.from, ref.messageId),
    })),
  ];
  const allImages = [...images, ...backgroundImages.map(({ image }) => image)];
  return {
    images: allImages.length ? allImages : undefined,
    promptSuffix: `${missingNote}${imageManifest}${attachedFilesManifest(allFiles)}`,
  };
}

export async function* invokeSlackTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: SlackTurnTransport,
  attachments: SlackTurnAttachments,
  onCompleted?: () => void,
  busyRetry: BusyRetry = DEFAULT_BUSY_RETRY,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedInputs;
  try {
    resolved = await resolveInputs(transport, attachments);
  } catch (error) {
    yield { type: "failed", details: `could not load Slack attachment: ${String(error)}`, retryable: true };
    return;
  }
  const prompt = { text: `${text}${resolved.promptSuffix}${MARKDOWN_INSTRUCTION}`, images: resolved.images };
  yield* streamTurnWithBusyRetry(agent, session, prompt, { label: transport.label, onCompleted, busyRetry });
}
