/**
 * The acknowledgement a turn waiting behind a running one puts on its asker's message: 👀 while it waits, 👌 when it is
 * answered. A bot holds one reaction per message, so setting the second replaces the first. ✅ is not among the emoji
 * Telegram lets a bot react with.
 */
import { log } from "../../log.ts";
import { DROPPABLE_FRAME } from "../kit/transport.ts";
import { NO_ACK, type TurnAck } from "../kit/turn-runner.ts";
import { callApi } from "./telegram-api.ts";

const WAITING = "👀";
const ANSWERED = "👌";

/** The message to mark: where the asker said it, not where the answer goes (a route may send it elsewhere). */
export interface AskedMessage {
  chatId: number | string;
  messageId: number;
}

const react = (api: string, botToken: string, ask: AskedMessage, emoji: string | undefined) =>
  callApi(
    api,
    botToken,
    "setMessageReaction",
    {
      chat_id: ask.chatId,
      message_id: ask.messageId,
      reaction: emoji === undefined ? [] : [{ type: "emoji", emoji }],
      // Decoration: never worth waiting out a rate limit, which would hold the turn's end (kit/transport.ts).
    },
    DROPPABLE_FRAME,
  );

/** Mark the asker's message now; every later step is best effort, since an acknowledgement must never fail its turn. */
export async function acknowledgeTelegramAsk(api: string, botToken: string, ask: AskedMessage): Promise<TurnAck> {
  try {
    await react(api, botToken, ask, WAITING);
  } catch (error) {
    log.warn(`[telegram] could not mark message ${ask.messageId} as received: ${String(error)}`);
    return NO_ACK;
  }
  const settle = (emoji: string | undefined) => async (): Promise<void> => {
    await react(api, botToken, ask, emoji).catch((error) =>
      log.warn(`[telegram] could not settle the reaction on message ${ask.messageId}: ${String(error)}`),
    );
  };
  return { complete: settle(ANSWERED), remove: settle(undefined) };
}
