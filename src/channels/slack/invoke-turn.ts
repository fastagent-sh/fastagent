/** Resolve Slack file IDs at dequeue, then stream one engine-neutral Agent turn. */
import { type Agent, type AgentEvent, type ImageRef, SESSION_BUSY_CODE } from "../../agent.ts";
import { log } from "../../log.ts";
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

  const missing = lost + attachments.buffered.skipped;
  const missingNote =
    missing > 0
      ? `\n[note: ${missing} file(s) from the earlier discussion are not loaded (deleted, inaccessible, or older than the recent-file cap)]`
      : "";
  const imageManifest = backgroundImages.length
    ? `\n\n[background vision images from earlier discussion — appended after ${images.length} primary image(s):\n${backgroundImages
        .map(({ ref }, index) => `- vision image ${images.length + index + 1}: from ${ref.from}, msg ${ref.messageId}`)
        .join("\n")}\n]`
    : "";
  const allFiles = [
    ...files,
    ...backgroundFiles.map(({ file, ref }) => ({
      ...file,
      name: `${file.name} (from ${ref.from}, msg ${ref.messageId}, earlier discussion)`,
    })),
  ];
  const fileManifest = allFiles.length
    ? `\n\n[attached files — read them with your tools:\n${allFiles
        .map((file) => `- ${file.name} (${file.size} bytes) → ${file.path}`)
        .join("\n")}\n]`
    : "";
  return {
    images: [...images, ...backgroundImages.map(({ image }) => image)].length
      ? [...images, ...backgroundImages.map(({ image }) => image)]
      : undefined,
    promptSuffix: `${missingNote}${imageManifest}${fileManifest}`,
  };
}

export interface SlackBusyRetry {
  delayMs: number;
  maxWaitMs: number;
}

const DEFAULT_BUSY_RETRY: SlackBusyRetry = { delayMs: 5_000, maxWaitMs: 600_000 };

export async function* invokeSlackTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: SlackTurnTransport,
  attachments: SlackTurnAttachments,
  onCompleted?: () => void,
  busyRetry: SlackBusyRetry = DEFAULT_BUSY_RETRY,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedInputs;
  try {
    resolved = await resolveInputs(transport, attachments);
  } catch (error) {
    yield { type: "failed", details: `could not load Slack attachment: ${String(error)}`, retryable: true };
    return;
  }
  const prompt = { text: `${text}${resolved.promptSuffix}${MARKDOWN_INSTRUCTION}`, images: resolved.images };
  const deadline = Date.now() + busyRetry.maxWaitMs;
  for (;;) {
    let retryBusy = false;
    let first = true;
    for await (const event of agent.invoke({ session }, prompt)) {
      if (
        first &&
        event.type === "failed" &&
        event.code === SESSION_BUSY_CODE &&
        Date.now() + busyRetry.delayMs < deadline
      ) {
        retryBusy = true;
        break;
      }
      first = false;
      if (event.type === "completed") onCompleted?.();
      yield event;
    }
    if (!retryBusy) return;
    log.info(`${transport.label} session ${session} is busy — retrying in ${busyRetry.delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, busyRetry.delayMs));
  }
}
