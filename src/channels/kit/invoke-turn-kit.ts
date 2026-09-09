/**
 * Shared pieces of the channels' invoke-turn modules (telegram/feishu/slack `invoke-turn.ts`) — the
 * halves that are channel-independent, so a retry-policy or prompt-wording change lands ONCE:
 *
 *   - {@link turnStream}: resolve inputs → ask the agent, with a load failure arriving as a `failed`
 *     EVENT rather than a thrown iteration (SPEC MUST 2);
 *   - {@link busyRetryStream}: the busy-retry loop around `agent.invoke`, with the
 *     `onCompleted` durable-commit point;
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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type Agent, type AgentEvent, type Prompt, SESSION_BUSY_CODE, type Scope } from "../../agent.ts";
import { eventStream } from "./event-stream.ts";
import { PortFailure, portJoin } from "../../effect-port.ts";
import { log } from "../../log.ts";

/**
 * One turn, end to end: resolve the platform inputs, then stream `agent.invoke` with the shared
 * busy-wait. All three chat channels wrote this out, and the copies had already disagreed about the
 * one thing that is actually a per-platform judgement (whether a load failure is worth a redelivery)
 * while agreeing on everything that is not.
 *
 * A resolution failure becomes a `failed` EVENT. It must never throw out of the stream: the SPEC
 * forbids it (MUST 2), and the turn's own settlement path is what tells the user — an exception here
 * would take the reply with it.
 */
export function turnStream<R>(opts: {
  agent: Agent;
  label: string;
  /** Resolve this turn's platform inputs (download attachments, walk a reply chain). */
  resolve: () => Promise<R>;
  /** What the resolved inputs make of the turn: where it runs, and what it asks. */
  turn: (resolved: R) => { scope: Scope; prompt: Prompt };
  /** Whether a failed resolution is worth a platform redelivery. Stated per channel because it IS a
   *  platform question — Slack reads its API error's status, and a transport that cannot tell says
   *  yes, since a retried download is cheap next to an unanswered ask. */
  retryableLoadFailure: (cause: unknown) => boolean;
  onCompleted?: () => void;
  busyRetry?: BusyRetry;
}): Stream.Stream<AgentEvent, PortFailure> {
  return Stream.unwrap(
    portJoin(opts.resolve).pipe(
      Effect.map((resolved) => {
        const { scope, prompt } = opts.turn(resolved);
        return busyRetryStream(opts.agent, scope, prompt, {
          label: opts.label,
          ...(opts.onCompleted ? { onCompleted: opts.onCompleted } : {}),
          ...(opts.busyRetry ? { busyRetry: opts.busyRetry } : {}),
        });
      }),
      Effect.catchTag("PortFailure", ({ cause }) =>
        Effect.succeed(
          Stream.succeed<AgentEvent>({
            type: "failed",
            details: `could not load attachment: ${String(cause)}`,
            retryable: opts.retryableLoadFailure(cause),
          }),
        ),
      ),
    ),
  );
}

/** How the busy-wait paces: retry the invoke every `delayMs` while the session's lease is held by an
 *  EXTERNAL turn (a self-scheduled wake, a concurrent embedder invoke), up to `maxWaitMs` total. The
 *  channel's own turns never collide (the turn-queue serializes per session), so a busy reject here is
 *  always an outside holder — wait for it like a queued turn, instead of erroring at the user. */
export interface BusyRetry {
  delayMs: number;
  maxWaitMs: number;
}
// Each retry is a lease-check-level reject (tryAcquire runs before the session is bound) — waiting is nearly
// free, and the loop exits within one delay of the holder finishing. So the cap is sized to outlast a
// real tool-using wake turn (minutes), not to be short: 10 min. CEILING: a holder that runs longer than
// this still surfaces the busy error to the user — the bound exists so a stuck lease can't hang a chat
// turn forever.
export const DEFAULT_BUSY_RETRY: BusyRetry = { delayMs: 5_000, maxWaitMs: 600_000 };

/**
 * Stream one Agent turn with the shared busy-wait. `onCompleted` (if given) fires on the turn's
 * `completed` event — the durable-commit point: the turn now lives in the session. The callback
 * removes its intent before committing the consumed context snapshot. Other endings retain context;
 * the runner separately decides whether an intent is removed (caught execution failure) or retained
 * (interruption). Source pulls remain demand-driven, including while final platform delivery runs.
 *
 * BUSY-WAIT: a `failed{code: session_busy}` FIRST event means an external turn holds this session's
 * lease and OUR turn never started — replay-safe. Retry (bounded) instead of yielding it: the user
 * sees the channel's "Thinking…" placeholder while waiting (the mirror of the scheduler deferring a
 * wake INTO a busy session), and only an exhausted wait surfaces the busy failure. Only a FIRST-event
 * busy retries — a fail-fast reject is the only shape the engine emits it in, so nothing that started
 * is ever re-run.
 */
export function busyRetryStream(
  agent: Agent,
  scope: Scope,
  prompt: Prompt,
  {
    label,
    onCompleted,
    busyRetry = DEFAULT_BUSY_RETRY,
  }: { label: string; onCompleted?: () => void; busyRetry?: BusyRetry },
): Stream.Stream<AgentEvent, PortFailure> {
  return Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (started) => {
      const deadline = started + busyRetry.maxWaitMs;
      const attempt = (): Stream.Stream<AgentEvent, PortFailure> =>
        Stream.suspend(() => {
          let retryBusy = false;
          let first = true;
          return eventStream(() => agent.invoke(scope, prompt), `${label} (session=${scope.session})`).pipe(
            Stream.takeWhileEffect((event) =>
              Effect.gen(function* () {
                if (
                  first &&
                  event.type === "failed" &&
                  event.code === SESSION_BUSY_CODE &&
                  (yield* Clock.currentTimeMillis) + busyRetry.delayMs < deadline
                ) {
                  retryBusy = true;
                  return false;
                }
                first = false;
                return true;
              }),
            ),
            Stream.tap((event) =>
              Effect.try({
                try: () => {
                  if (event.type === "completed") onCompleted?.();
                },
                catch: (cause) => new PortFailure(cause),
              }),
            ),
            Stream.scoped,
            // concat closes the attempt's scope (and its iterator) before the wait or next invoke.
            Stream.concat(
              Stream.suspend(() =>
                retryBusy
                  ? Stream.unwrap(
                      Effect.gen(function* () {
                        log.info(
                          `${label} session ${scope.session} is busy (an external turn holds it) — retrying in ${busyRetry.delayMs}ms`,
                        );
                        yield* Effect.sleep(busyRetry.delayMs);
                        return attempt();
                      }),
                    )
                  : Stream.empty,
              ),
            ),
          );
        });
      return attempt();
    }),
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
 * All three channels wrote this reduce out, once per resource kind, and the log wording had already
 * drifted apart — hence `what`, which is the only part that is the platform's.
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
