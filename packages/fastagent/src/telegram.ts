/** `@fastagent-sh/fastagent/telegram` — the Telegram bot channel, kept off the root surface. */
export {
  telegram,
  telegramChannel,
  defaultTelegramRoute,
  telegramEnvelope,
  telegramStop,
  type TelegramOptions,
  type TelegramChannelOptions,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramRoute,
  type TelegramFailure,
} from "./channels/telegram/telegram.ts";
