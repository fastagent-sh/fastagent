/** Resolve Slack file IDs at dequeue, then stream one engine-neutral Agent turn. */
import type { Agent, AgentEvent, ImageRef } from "../../agent.ts";
import type * as Stream from "effect/Stream";
import type { PortFailure } from "../../effect-port.ts";
import {
  type BusyRetry,
  DEFAULT_BUSY_RETRY,
  attachedFilesManifest,
  attributedFileName,
  backgroundImagesManifest,
  loadBackground,
  missingAttachmentsNote,
  turnStream,
} from "../kit/invoke-turn-kit.ts";
import type { SlackBufferedFileRef } from "./context-buffer.ts";
import { type DownloadedSlackFile, type SlackApi, SlackApiError } from "./slack-api.ts";

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
  if (info.mimetype?.toLowerCase().startsWith("image/")) return { image: await transport.api.fetchImage(info) };
  return { file: await transport.api.fetchFile(info, transport.channelId, transport.filesDir) };
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
  const background = await loadBackground(attachments.buffered.files, (ref) => resolveFile(transport, ref.id), {
    label: transport.label,
    what: "Slack file",
  });
  for (const { ref, value } of background.loaded) {
    if (value.image) backgroundImages.push({ image: value.image, ref });
    if (value.file) backgroundFiles.push({ file: value.file, ref });
  }

  const missingNote = missingAttachmentsNote(background.lost + attachments.buffered.skipped);
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

export function slackTurnStream(
  agent: Agent,
  session: string,
  text: string,
  transport: SlackTurnTransport,
  attachments: SlackTurnAttachments,
  onCompleted?: () => void,
  busyRetry: BusyRetry = DEFAULT_BUSY_RETRY,
): Stream.Stream<AgentEvent, PortFailure> {
  return turnStream({
    agent,
    label: transport.label,
    busyRetry,
    ...(onCompleted ? { onCompleted } : {}),
    resolve: () => resolveInputs(transport, attachments),
    turn: (resolved) => ({
      scope: { session },
      prompt: { text: `${text}${resolved.promptSuffix}${MARKDOWN_INSTRUCTION}`, images: resolved.images },
    }),
    // Slack says which failures are transient; anything else (a deleted file, a missing scope) will
    // fail the same way on redelivery.
    retryableLoadFailure: (cause) =>
      cause instanceof SlackApiError && (cause.status === 0 || cause.status === 429 || cause.status >= 500),
  });
}
