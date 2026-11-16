/**
 * Run one turn (the IO half of Telegram→Agent translation): assemble its inputs — resolve attachments
 * (download files to disk, load vision images) — and stream `agent.invoke` with the assembled prompt.
 * Split from parse.ts because this half touches the Bot API + disk; split from telegram.ts so the
 * factory keeps only wiring and the per-turn lifecycle.
 */
import type { Agent } from "../../agent-api.ts";
import type * as Stream from "effect/Stream";
import type { PromiseFailure } from "../../promise-bridge.ts";
import {
  type ImageAttachment as ImageRef,
  attachedFilesManifest,
  type SteeredTurn,
  turnStream,
  type TurnEvent,
  promptContent,
} from "../kit/invoke.ts";
import { resolveFiles, resolveImages } from "./telegram-api.ts";

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

/** The summoning message's own attachments, and a replied-to message's. */
export interface TurnAttachments {
  imageFileIds?: string[];
  fileIds?: string[];
}

/** A turn's attachments, resolved to what agent.invoke consumes: vision images inline, plus the downloaded files'
 *  manifest appended after the prompt, before the HTML hint. */
interface ResolvedAttachments {
  images: ImageRef[] | undefined;
  promptSuffix: string;
}

/**
 * Resolve a turn's attachments: images (vision) inline, files downloaded to disk with their absolute paths listed in a
 * manifest the agent reads with its tools. Any load failure throws: the caller turns it into a `rejected` event, so the
 * agent never runs on inputs the user sent but we failed to load.
 */
async function resolveTurnAttachments(t: TurnTransport, attachments: TurnAttachments): Promise<ResolvedAttachments> {
  const { api, botToken, chatId, filesDir } = t;
  const images = await resolveImages(api, botToken, attachments.imageFileIds);
  const files = await resolveFiles(api, botToken, attachments.fileIds, chatId, filesDir);
  return { images: images?.length ? images : undefined, promptSuffix: attachedFilesManifest(files ?? []) };
}

/**
 * Run one turn: resolve its attachments, then ask the agent (invoke-turn-kit — a primary-attachment
 * failure surfaces as a `rejected` event, never a silent drop). `key` is the turn's: the update it answers.
 */
export function telegramTurnStream(
  agent: Agent,
  turn: {
    session: () => Promise<string>;
    /** While it runs, the place its `history` tool reads. */
    enter: (sessionId: string) => () => void;
    key: string;
    text: string;
    steer: SteeredTurn;
  },
  transport: TurnTransport,
  attachments: TurnAttachments,
): Stream.Stream<TurnEvent, PromiseFailure> {
  return turnStream({
    agent,
    label: "[telegram]",
    session: turn.session,
    enter: turn.enter,
    resolve: () => resolveTurnAttachments(transport, attachments),
    turn: (resolved) => ({
      idempotencyKey: turn.key,
      content: promptContent(`${turn.text}${resolved.promptSuffix}${HTML_INSTRUCTION}`, resolved.images),
    }),
    // A Bot API download that failed may simply succeed on the redelivery.
    retryableLoadFailure: () => true,
    steer: turn.steer,
  });
}
