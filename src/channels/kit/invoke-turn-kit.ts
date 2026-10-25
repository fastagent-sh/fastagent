/**
 * Shared pieces of the channels' invoke-turn modules (telegram/feishu/slack `invoke-turn.ts`) — the
 * halves that are channel-independent, so a policy or prompt-wording change lands ONCE:
 *
 *   - {@link turnStream}: prepare the turn's inputs → ask the agent, with a preparation failure arriving as the
 *     invoke's `rejected` EVENT rather than a thrown iteration;
 *   - the prompt-suffix wording: {@link attachedFilesManifest}, {@link backgroundImagesManifest},
 *     {@link missingAttachmentsNote}, {@link attributedFileName}.
 *
 * None of it asks what the agent can DO with an attachment. A channel resolves platform resources and
 * states what it found; deciding whether to open a file is the agent's, and one assembled without a
 * file tool answers that it cannot — visibly, at the moment it is asked.
 *
 * Attachment RESOLUTION stays per channel — the platform resource models (Bot API file_ids,
 * message-scoped Feishu keys, Slack file objects) are real differences. The two TIERS' failure
 * policies are not: see {@link loadBackground}.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Agent, AgentError, Attachment, ContentPart, MessageStatus, SessionEvent } from "../../agent-api.ts";
import { stream } from "../../agent-api-stream.ts";
import { log } from "../../log.ts";
import { eventStream } from "./event-stream.ts";
import { type PortFailure, portJoin } from "../../effect-port.ts";

/**
 * What a turn reads, in order: the message's receipt or why there is none, then its session's events through its
 * `done` (agent-api.md §3.1). `unknown`: whether the message was taken is not known, and the same key finds it again.
 */
export type TurnEvent =
  | { type: "accepted"; sessionId: string; message: MessageStatus; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | { type: "unknown"; reason: string }
  | SessionEvent;

/** A turn's text and images as the content of one message. */
export function promptContent(text: string, images: readonly Attachment[] | undefined): ContentPart[] {
  return [{ type: "text", text }, ...(images ?? []).map((image) => ({ type: "image" as const, ...image }))];
}

/**
 * One turn, end to end: the session the turn's place talks in (created and recorded first, place-sessions.ts), the
 * platform inputs prepared, then the message sent and its answer read as it is written (`stream`).
 *
 * The message queues behind whatever runs in the session (a wake-up, a schedule): the channel's own turns never
 * collide, its queue serializes them per place. Its key is the turn's, so a turn run again after a restart is the
 * message it already sent: one that ended is read back, answer included.
 *
 * A failure to prepare is the turn's `rejected` event: nothing was sent. It must never throw out of the stream, since
 * the turn's own settlement path is what tells the user; an exception here would take the reply with it.
 */
export function turnStream<R>(opts: {
  agent: Agent;
  label: string;
  /** The session the turn's place talks in: the one it has, or one created and recorded before anything is sent. */
  session: () => Promise<string>;
  /** While the turn runs, what its session reaches by its id (a thread-reading tool's room); released when it ends. */
  enter?: (sessionId: string) => () => void;
  /** Prepare this turn's inputs (download attachments, walk a reply chain). */
  resolve: () => Promise<R>;
  /** What the prepared inputs make of the turn: what it asks, and the key it is known by. */
  turn: (resolved: R) => { content: ContentPart[]; idempotencyKey: string };
  /** Whether a failed preparation is worth a platform redelivery. Stated per channel because it IS a
   *  platform question — Slack reads its API error's status, and a transport that cannot tell says
   *  yes, since a retried download is cheap next to an unanswered ask. */
  retryableLoadFailure: (cause: unknown) => boolean;
}): Stream.Stream<TurnEvent, PortFailure> {
  return Stream.unwrap(
    portJoin(async () => {
      const sessionId = await opts.session();
      return { sessionId, resolved: await opts.resolve() };
    }).pipe(
      Effect.flatMap(({ sessionId, resolved }) =>
        Effect.gen(function* () {
          const enter = opts.enter;
          if (enter !== undefined)
            yield* Effect.acquireRelease(
              Effect.sync(() => enter(sessionId)),
              (leave) => Effect.sync(leave),
            );
          const result = yield* portJoin(() =>
            stream(opts.agent, { sessionId, ...opts.turn(resolved), whenBusy: "queue" }),
          );
          if (!result.ok) {
            return Stream.succeed<TurnEvent>(
              "error" in result
                ? { type: "rejected", error: result.error }
                : { type: "unknown", reason: result.unknown.reason },
            );
          }
          const { ok: _, events, ...receipt } = result;
          return Stream.concat(
            Stream.succeed<TurnEvent>({ type: "accepted", ...receipt }),
            eventStream(() => events, `${opts.label} (session=${sessionId})`).pipe(Stream.scoped),
          );
        }),
      ),
      Effect.catchTag("PortFailure", ({ cause }) =>
        Effect.succeed(
          Stream.succeed<TurnEvent>({
            type: "rejected",
            error: {
              code: "unavailable",
              message: `could not prepare the turn: ${String(cause)}`,
              retryable: opts.retryableLoadFailure(cause),
            },
          }),
        ),
      ),
    ),
  );
}

/**
 * Load the turn's BACKGROUND refs — what was folded in from earlier un-summoned discussion, not the
 * ask itself. Per-ref degradation is the whole meaning of that tier: one expired file costs a warn
 * and a place in the missing-attachments count ({@link missingAttachmentsNote}), never the answer it
 * merely accompanies, and never its still-readable siblings. Parallel, input order kept.
 *
 * PRIMARY refs are the opposite policy and stay with their channel: a failure there throws, so the
 * agent never runs on an input the user pointed at and we failed to load.
 *
 * Shared by all three channels; `what` is the only part that is the platform's.
 */
export async function loadBackground<R, T>(
  refs: readonly R[],
  load: (ref: R) => Promise<T>,
  opts: { label: string; what: string },
): Promise<{ loaded: { ref: R; value: T }[]; lost: number }> {
  const loaded: { ref: R; value: T }[] = [];
  let lost = 0;
  const results = await Promise.allSettled(refs.map(load));
  for (const [index, result] of results.entries()) {
    const ref = refs[index] as R;
    if (result.status === "fulfilled") loaded.push({ ref, value: result.value });
    else {
      lost++;
      log.warn(`${opts.label} could not load an earlier (buffered) ${opts.what}: ${String(result.reason)}`);
    }
  }
  return { loaded, lost };
}

/** What the attached-files manifest renders per file: display name, byte size, absolute local path. */
export interface ManifestFile {
  name: string;
  size: number;
  path: string;
}

/**
 * The downloaded-file manifest appended to the prompt: name, size, path. Empty input renders nothing.
 *
 * It STATES, it does not instruct. The earlier wording ("read them with your tools") was an
 * assumption about the reader, and an assumption has to be verified — which is where a capability
 * flag threaded through eight files came from. An agent with a file tool decides for itself whether
 * to open one, and how much of it; an agent without one says so. Neither needs this line to have
 * guessed first.
 */
export function attachedFilesManifest(files: readonly ManifestFile[]): string {
  return files.length
    ? `\n\n[attached files:\n${files.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
    : "";
}

/** Decorate a background file's display name with its attribution ("the file Bob sent" resolves),
 *  the way the fold attributes text lines. */
export function attributedFileName(name: string, from: string, msg?: string | number): string {
  return `${name} (from ${from}${msg !== undefined ? `, msg ${msg}` : ""}, earlier discussion)`;
}

/** The manifest attributing background vision images folded in from the earlier discussion — images
 *  carry no per-image label inline, so position ("appended after N primary") is the attribution.
 *  Channels whose image refs carry no attribution (telegram) simply don't render one. */
export function backgroundImagesManifest(
  primaryCount: number,
  refs: readonly { from: string; messageId: string }[],
): string {
  return refs.length
    ? `\n\n[background vision images from earlier discussion — appended after ${primaryCount} primary image(s):\n${refs
        .map((ref, index) => `- vision image ${primaryCount + index + 1}: from ${ref.from}, msg ${ref.messageId}`)
        .join("\n")}\n]`
    : "";
}

/** The prompt note counting EVERY background attachment the turn does not carry (load failures +
 *  cap-skipped) — without it, the model holds fold references it silently cannot open and may
 *  pretend it read them. Neutral wording (platforms differ on WHY: expired file_ids, deleted files). */
export function missingAttachmentsNote(missing: number): string {
  return missing > 0
    ? `\n[note: ${missing} attachment(s) from the earlier discussion are not loaded (no longer available, or older than the most recent few)]`
    : "";
}
