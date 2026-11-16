/** Resolve Slack file IDs at dequeue, then stream one harness-neutral Agent turn. */
import type { Agent } from "@fastagent-sh/client/agent-api";
import type * as Stream from "effect/Stream";
import type { PromiseFailure } from "@fastagent-sh/client/promise-bridge";
import {
  type ImageAttachment as ImageRef,
  attachedFilesManifest,
  type SteeredTurn,
  turnStream,
  type TurnEvent,
  promptContent,
} from "@fastagent-sh/client/kit/invoke";
import { type DownloadedSlackFile, type SlackApi, SlackApiError } from "./slack-api.ts";

const MARKDOWN_INSTRUCTION =
  "\n\n(Format your reply as standard Markdown. Slack renders it natively. Do not use HTML or Slack control-mention syntax such as <!here>, <!channel>, or <!everyone>.)";

export interface SlackTurnTransport {
  api: SlackApi;
  channelId: string;
  filesDir: string;
  label: string;
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

/** The message's own files: images inline, the rest downloaded and listed. Any failure throws. */
async function resolveInputs(transport: SlackTurnTransport, fileIds: readonly string[]): Promise<ResolvedInputs> {
  const images: ImageRef[] = [];
  const files: DownloadedSlackFile[] = [];
  for (const id of fileIds) {
    const resolved = await resolveFile(transport, id);
    if (resolved.image) images.push(resolved.image);
    if (resolved.file) files.push(resolved.file);
  }
  return { images: images.length ? images : undefined, promptSuffix: attachedFilesManifest(files) };
}

/** One turn: resolve its files, then ask the agent. `key` is the turn's: the message it answers. */
export function slackTurnStream(
  agent: Agent,
  turn: {
    session: () => Promise<string>;
    /** While it runs, the place its `history` tool reads. */
    enter: (sessionId: string) => () => void;
    key: string;
    text: string;
    steer: SteeredTurn;
  },
  transport: SlackTurnTransport,
  fileIds: readonly string[],
): Stream.Stream<TurnEvent, PromiseFailure> {
  return turnStream({
    agent,
    label: transport.label,
    session: turn.session,
    enter: turn.enter,
    resolve: () => resolveInputs(transport, fileIds),
    turn: (resolved) => ({
      idempotencyKey: turn.key,
      content: promptContent(`${turn.text}${resolved.promptSuffix}${MARKDOWN_INSTRUCTION}`, resolved.images),
    }),
    // Slack says which failures are transient; anything else (a deleted file, a missing scope) will
    // fail the same way on redelivery.
    retryableLoadFailure: (cause) =>
      cause instanceof SlackApiError && (cause.status === 0 || cause.status === 429 || cause.status >= 500),
    steer: turn.steer,
  });
}
