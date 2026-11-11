/** What a Telegram bot's setup asks for (channels/setup.ts): its token from BotFather, and for a webhook a secret. */
import { randomBytes } from "node:crypto";
import { type ChannelSetup, SetupRefused, pasteOne } from "../setup.ts";
import { PRIVACY_MODE_EFFECT, PRIVACY_MODE_FIX } from "./privacy.ts";
import { TelegramApiError, callApi } from "./telegram-api.ts";

const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;

export const telegramSetup: ChannelSetup = ({ way }) => {
  // What the token's own `getMe` said about group privacy, for what is left to the person once the token is kept.
  let readsAllGroupMessages: boolean | undefined;
  return {
    finish: () => {
      if (readsAllGroupMessages === true) return [];
      return [
        readsAllGroupMessages === false
          ? `to use the bot in a group, ${PRIVACY_MODE_EFFECT}: ${PRIVACY_MODE_FIX}. It then reads the discussion as ` +
            "context and still answers only when it is mentioned or replied to"
          : "Telegram did not say whether group privacy mode is on: in @BotFather send /mybots, choose this bot, " +
            "Bot Settings → Group Privacy, and turn it off if the bot is to read a group's discussion",
      ];
    },
    values: [
      pasteOne({
        name: "TELEGRAM_BOT_TOKEN",
        label: "Bot token",
        guide: {
          instructions: "Message @BotFather, send /newbot, follow its questions, and copy the token it gives you.",
          url: "https://t.me/BotFather",
        },
        async check(value) {
          if (!TOKEN.test(value)) {
            throw new SetupRefused("That is not a bot token.", {
              fix: "BotFather's token looks like 123456789:AAH…, a number, a colon and a long string.",
            });
          }
          try {
            const me = await callApi("https://api.telegram.org", value, "getMe", {});
            readsAllGroupMessages = me.can_read_all_group_messages;
            return me.username ? `bot @${me.username}` : "bot";
          } catch (error) {
            if (error instanceof TelegramApiError && (error.status === 401 || error.status === 404)) {
              throw new SetupRefused("Telegram does not accept this token.", {
                fix: "Copy it again from BotFather (/mybots → the bot → API Token).",
                why: error.message,
              });
            }
            throw error;
          }
        },
      }),
      // Only a webhook has an inbound request to verify: a polling bot asks Telegram for its updates.
      ...(way === "webhook"
        ? [{ kind: "make" as const, name: "TELEGRAM_SECRET_TOKEN", make: () => randomBytes(24).toString("hex") }]
        : []),
    ],
  };
};
