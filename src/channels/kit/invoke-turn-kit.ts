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
import type { Agent, InvokeEvent, InvokeRequest } from "../../protocol.ts";
import { log } from "../../log.ts";
import { eventStream } from "./event-stream.ts";
import { type PortFailure, portJoin } from "../../effect-port.ts";

/**
 * One turn, end to end: prepare the platform inputs, then stream `agent.invoke`. All three chat channels wrote this
 * out, and the copies had already disagreed about the one thing that is actually a per-platform judgement (whether a
 * preparation failure is worth a redelivery) while agreeing on everything that is not.
 *
 * The invoke queues behind whatever runs in the session (a wake-up, an API caller): the channel's own turns never
 * collide, its queue serializes them per session. Its key is the turn's, so a turn run again after a restart is the
 * message it already sent: one that ended is replayed, answer included, and only an `interrupted` one is taken again.
 *
 * A preparation failure is the invoke's `rejected` event: nothing ran. It must never throw out of the stream, since
 * the turn's own settlement path is what tells the user — an exception here would take the reply with it.
 */
export function turnStream<R>(opts: {
  agent: Pick<Agent, "invoke">;
  label: string;
  source: NonNullable<InvokeRequest["source"]>;
  /** Prepare this turn's inputs (download attachments, walk a reply chain, start a thread from its room). */
  resolve: () => Promise<R>;
  /** What the prepared inputs make of the turn: where it runs, what it asks, and the key it is known by. */
  turn: (resolved: R) => Pick<InvokeRequest, "prompt"> & { sessionId: string; idempotencyKey: string };
  /** Whether a failed preparation is worth a platform redelivery. Stated per channel because it IS a
   *  platform question — Slack reads its API error's status, and a transport that cannot tell says
   *  yes, since a retried download is cheap next to an unanswered ask. */
  retryableLoadFailure: (cause: unknown) => boolean;
}): Stream.Stream<InvokeEvent, PortFailure> {
  return Stream.unwrap(
    portJoin(opts.resolve).pipe(
      Effect.map((resolved) => {
        const request: InvokeRequest = { ...opts.turn(resolved), whenBusy: "queue", source: opts.source };
        return eventStream(() => opts.agent.invoke(request), `${opts.label} (session=${request.sessionId})`).pipe(
          Stream.scoped,
        );
      }),
      Effect.catchTag("PortFailure", ({ cause }) =>
        Effect.succeed(
          Stream.succeed<InvokeEvent>({
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
