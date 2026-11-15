import { needs } from "@fastagent-sh/fastagent";
import { type TelegramPollingChannelOptions, telegramPollingChannel } from "@fastagent-sh/fastagent/telegram";

// A channel = a third-party ADAPTER (telegramPollingChannel: receive + run + reply) configured with YOUR policy.
// fastagent registers this file from src/channels/ and hands the adapter the agent, its sessions and a directory of
// its own; this file holds only policy.
//
// The bot polls Telegram for its updates, so it needs no public URL, in `fastagent dev` and in a container alike. A
// bot is polled by ONE process: run one instance per bot, and give a deployment a bot of its own.
//
// Setup: @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN (`fastagent channels setup telegram` asks
// for it and checks it).

const policy: Pick<TelegramPollingChannelOptions, "onError" | "route" | "botUsername"> = {
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // Your bot's @username. Optional — resolved via getMe when omitted — but set it if you pass a `route`
  // below: the channel needs its own copy to recognise a `/stop` addressed to it.
  // botUsername: "your_bot",
  // The channel owns transport + format (HTML) + attachments (photo→vision, file→disk) + streaming.
  // `route` (POLICY) is OPTIONAL — omitted, it uses defaultTelegramRoute: private chats always answer,
  // groups only on a reply to THIS bot, an @mention of it, or a `/stop` addressed to it. Override to
  // customise, reusing the export — but pass your bot's identity BOTH here and as `botUsername` above
  // (the omitted default gets it from the channel; a bare `defaultTelegramRoute(u)` answers only
  // private chats):
  //   route: (u) => defaultTelegramRoute(u, { botUsername: "my_bot" }) && { conversation: `user:${u.message?.from?.id}` },
  //   route: (u) => defaultTelegramRoute(u, { botUsername: "my_bot" }) && { text: `${telegramEnvelope(u.message!)}\n[extra]` },
};

// `needs` declares the env vars this file reads: the instance is refused to serve while one is unset.
export default needs(["TELEGRAM_BOT_TOKEN"], (secrets) =>
  telegramPollingChannel({ botToken: secrets.TELEGRAM_BOT_TOKEN, ...policy }),
);
