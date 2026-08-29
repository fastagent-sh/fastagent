import { telegramChannel } from "@fastagent-sh/fastagent/telegram";

// A channel = a third-party ADAPTER (telegramChannel: verify + run + reply) configured with YOUR policy.
// fastagent discovers this file under channels/, mounts POST /telegram, and pipes the agent + state
// home to the adapter — this file holds only policy. Setup:
//   1. @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN
//   2. pick a random TELEGRAM_SECRET_TOKEN (verifies that inbound updates really come from Telegram)
//   3. register the webhook once, pointing Telegram at POST /telegram with that secret:
//        curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
//          -d url=https://your.host/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN
export default telegramChannel({
  secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // missing → fails at startup (would accept forged updates)
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "", // used to send the agent's reply back to the chat
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
  //   route: (u) => defaultTelegramRoute(u, { botUsername: "my_bot" }) && { session: `user:${u.message?.from?.id}` },
  //   route: (u) => defaultTelegramRoute(u, { botUsername: "my_bot" }) && { text: `${telegramEnvelope(u.message!)}\n[extra]` },
});
