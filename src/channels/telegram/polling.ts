/**
 * Telegram long polling: how a bot receives with no public URL. The process asks `getUpdates` for what is new, hands
 * each update to the channel, and confirms it by asking again past its id (Telegram holds what is not confirmed).
 *
 * Failures are told apart by what can be done about them. Before the first answer, anything but a conflict ends the
 * connection: a start that cannot reach Telegram or is refused by it is the operator's to see. After it, a lost network
 * or a 5xx is weather and is retried with a growing wait, while a refused token, a webhook someone set under the poll,
 * and a second process polling the same bot end the connection with their reason, because retrying cannot fix them (and
 * the last would only take turns with the other process).
 */
import type { LongConnection } from "../../channel.ts";
import { log } from "../../log.ts";
import { pause } from "../kit/ingress.ts";
import { TelegramApiError, callApi } from "./telegram-api.ts";
import type { TelegramUpdate } from "./parse.ts";

/** How long Telegram may hold a poll open with nothing to say. */
const LONG_POLL_S = 30;
/** Retry waits for a failure that can pass: doubling from the first, never past the last. */
const RETRY_FIRST_MS = 1_000;
const RETRY_CAP_MS = 30_000;
/** A 409 from another process polling this bot: how often to ask again, and how many answers before giving up. */
const CONFLICT_WAIT_MS = 5_000;
const CONFLICT_RETRIES = 3;

export interface TelegramPollingOptions {
  apiBaseUrl: string;
  botToken: string;
  /** The channel's `accept`: durable before it returns, a throw means the update was not taken. */
  accept(update: TelegramUpdate): void;
  /** Waits in milliseconds, for tests. */
  timing?: { longPollS?: number; retryFirstMs?: number; retryCapMs?: number; conflictWaitMs?: number };
}

const isApiError = (error: unknown): error is TelegramApiError => error instanceof TelegramApiError;

/** Poll until `signal` aborts; `ready` settles after the first answer, `closed` when the poll ends or cannot go on. */
export function pollTelegramUpdates(options: TelegramPollingOptions, signal: AbortSignal): LongConnection {
  const { apiBaseUrl, botToken, accept } = options;
  const longPollS = options.timing?.longPollS ?? LONG_POLL_S;
  const retryFirstMs = options.timing?.retryFirstMs ?? RETRY_FIRST_MS;
  const retryCapMs = options.timing?.retryCapMs ?? RETRY_CAP_MS;
  const conflictWaitMs = options.timing?.conflictWaitMs ?? CONFLICT_WAIT_MS;
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let isReady = false;
  const markReady = (): void => {
    if (isReady) return;
    isReady = true;
    ready.resolve();
  };

  /** `getUpdates` does not work while a webhook is set, so a bot that polls is a bot with none. */
  const takeWebhookAway = async (): Promise<void> => {
    const info = await callApi(apiBaseUrl, botToken, "getWebhookInfo", {}, { signal });
    if (!info.url) return;
    await callApi(apiBaseUrl, botToken, "deleteWebhook", {}, { signal });
    log.info(`[telegram] deleted the bot's webhook (${info.url}) so it can receive by long polling`);
  };

  const run = async (): Promise<void> => {
    await takeWebhookAway();
    let offset: number | undefined;
    let waitMs = retryFirstMs;
    let conflicts = 0;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await callApi(
          apiBaseUrl,
          botToken,
          "getUpdates",
          // The first call answers at once: readiness is "Telegram accepts this token and nobody else polls", which a
          // poll held open for a quiet bot could not say for half a minute.
          { ...(offset === undefined ? {} : { offset }), timeout: isReady ? longPollS : 0 },
          { retries: 0, timeoutMs: (longPollS + 15) * 1000, signal },
        );
      } catch (error) {
        if (signal.aborted) break;
        if (isApiError(error) && error.status === 409) {
          if (/webhook/i.test(error.description)) {
            throw new Error(
              `a webhook was set for this bot while it polls, so another instance receives by webhook (${error.description})`,
            );
          }
          if (++conflicts > CONFLICT_RETRIES) {
            throw new Error(`another process polls this bot (${error.description})`);
          }
          log.warn(
            `[telegram] another process is polling this bot; asking again in ${conflictWaitMs / 1000}s (${conflicts}/${CONFLICT_RETRIES})`,
          );
          await pause(conflictWaitMs, signal);
          continue;
        }
        if (!isReady || (isApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404))) {
          throw error;
        }
        log.warn(`[telegram] getUpdates failed, retrying in ${waitMs / 1000}s: ${String(error)}`);
        await pause(waitMs, signal);
        waitMs = Math.min(waitMs * 2, retryCapMs);
        continue;
      }
      conflicts = 0;
      waitMs = retryFirstMs;
      markReady();
      for (const update of updates) {
        try {
          accept(update);
        } catch (error) {
          // Left unconfirmed it would come back for ever, and every update behind it with it: said, and passed.
          log.error(`[telegram] update ${update.update_id} was not taken, and is skipped: ${String(error)}`);
        }
        offset = update.update_id + 1;
      }
    }
  };

  run().then(
    () => {
      markReady(); // an abort before the first answer: ready settles, and resolving it means cancelled
      closed.resolve();
    },
    (error: unknown) => {
      if (signal.aborted) {
        // A call cut short by the abort is the cancellation, not a failure of the connection.
        markReady();
        closed.resolve();
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!isReady) {
        isReady = true;
        ready.reject(failure);
      }
      closed.reject(failure);
    },
  );
  return { ready: ready.promise, closed: closed.promise };
}
