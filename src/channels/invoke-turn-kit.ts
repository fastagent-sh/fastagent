/**
 * Shared pieces of the channels' invoke-turn modules (telegram/feishu/slack `invoke-turn.ts`) — the
 * halves that are channel-independent, so a retry-policy or prompt-wording change lands ONCE:
 *
 *   - {@link streamTurnWithBusyRetry}: the busy-retry loop around `agent.invoke`, with the
 *     `onCompleted` durable-commit point;
 *   - the prompt-suffix wording: {@link attachedFilesManifest}, {@link backgroundImagesManifest},
 *     {@link missingAttachmentsNote}, {@link attributedFileName}.
 *
 * Attachment RESOLUTION stays per channel — the platform resource models (Bot API file_ids,
 * message-scoped Feishu keys, Slack file objects) are real differences.
 */
import { type Agent, type AgentEvent, type Prompt, SESSION_BUSY_CODE } from "../agent.ts";
import { log } from "../log.ts";

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
export const DEFAULT_BUSY_RETRY: BusyRetry = { delayMs: 5_000, maxWaitMs: 600_000 };

/**
 * Stream one Agent turn with the shared busy-wait. `onCompleted` (if given) fires on the turn's
 * `completed` event — the durable-commit point: only then does the turn provably live in the session,
 * so a failure or crash at ANY earlier point leaves the caller's pre-ACK state (turn intent, context
 * buffer) intact for replay/the next summon. The caller uses it to remove the turn intent AND commit
 * the context buffer, in that order, so a crash between the two clears cannot replay a
 * context-stripped turn.
 *
 * BUSY-WAIT: a `failed{code: session_busy}` FIRST event means an external turn holds this session's
 * lease and OUR turn never started — replay-safe. Retry (bounded) instead of yielding it: the user
 * sees the channel's "Thinking…" placeholder while waiting (the mirror of the scheduler deferring a
 * wake INTO a busy session), and only an exhausted wait surfaces the busy failure. Only a FIRST-event
 * busy retries — a fail-fast reject is the only shape the engine emits it in, so nothing that started
 * is ever re-run.
 */
export async function* streamTurnWithBusyRetry(
  agent: Agent,
  session: string,
  prompt: Prompt,
  options: { label: string; onCompleted?: () => void; busyRetry?: BusyRetry },
): AsyncIterable<AgentEvent> {
  const { label, onCompleted, busyRetry = DEFAULT_BUSY_RETRY } = options;
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
    log.info(`${label} session ${session} is busy (an external turn holds it) — retrying in ${busyRetry.delayMs}ms`);
    await new Promise((r) => setTimeout(r, busyRetry.delayMs));
  }
}

/** What the attached-files manifest renders per file: display name, byte size, absolute local path. */
export interface ManifestFile {
  name: string;
  size: number;
  path: string;
}

/** The downloaded-file manifest appended to the prompt — the agent reads the paths with its tools.
 *  Empty input renders nothing. */
export function attachedFilesManifest(files: readonly ManifestFile[]): string {
  return files.length
    ? `\n\n[attached files — read them with your tools:\n${files.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
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
