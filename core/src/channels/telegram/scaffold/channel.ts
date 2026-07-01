import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";

// A channel = a third-party ADAPTER (telegramChannel: verify + run + reply) wired to YOUR policy.
// fastagent discovers this file under channels/ and serves the routes it returns. Setup:
//   1. @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN
//   2. pick a random TELEGRAM_SECRET_TOKEN (verifies that inbound updates really come from Telegram)
//   3. register the webhook once, pointing Telegram at POST /telegram with that secret:
//        curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
//          -d url=https://your.host/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN
const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // missing → fails at startup (would accept forged updates)
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",       // used to send the agent's reply back to the chat
    // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
    // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
    // full details always go to the server log regardless.
    onError: (failed) => `⚠️ ${failed.details}`,
    // The channel owns transport + format (HTML) + attachments (photo→vision, file→disk) + streaming.
    // `route` (POLICY) is OPTIONAL — omitted, it uses defaultTelegramRoute: private chats always answer,
    // groups only on an @botname / /cmd@botname entity mention or a reply to the bot. Override to
    // customise, reusing the export:
    //   route: (u) => defaultTelegramRoute(u) && { session: `user:${u.message?.from?.id}` },
    //   route: (u) => defaultTelegramRoute(u) && { text: `${telegramEnvelope(u.message!)}\n[extra]` },
  }),
});

export default channel;
