/** `@fastagent-sh/fastagent/telegram` — the Telegram bot channel subpath export, kept off the root surface. */
export {
  telegramChannel,
  defaultTelegramRoute,
  telegramEnvelope,
  telegramStop,
  type TelegramChannelOptions,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramRoute,
  type TelegramFailure,
} from "./channels/telegram/telegram.ts";
export {
  telegramTransport,
  type TelegramSendTarget,
  type TelegramSent,
  type TelegramTransport,
} from "./channels/telegram/shared-api.ts";
