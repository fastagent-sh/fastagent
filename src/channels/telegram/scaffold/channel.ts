import { byIngress, needs } from "@fastagent-sh/fastagent";
import {
  type TelegramChannelOptions,
  telegramChannel,
  telegramPollingChannel,
} from "@fastagent-sh/fastagent/telegram";

// A channel = a third-party ADAPTER (telegramChannel: verify + run + reply) configured with YOUR policy.
// fastagent registers this file from src/channels/ and hands the adapter the agent, its sessions and a directory of
// its own; this file holds only policy.
//
// How it receives is the instance's choice, `channels.telegram.ingress` in its fastagent.json (webhook | connection).
// Unset, `fastagent dev` polls Telegram (no public URL, no tunnel), and everything else — `fastagent start`, every
// deployment — receives by webhook at POST /telegram, the way a host that wakes on a request is reached. A bot is
// polled by ONE process or reached by one webhook: polling takes the bot's webhook away first.
//
// Setup: @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN. For webhook, also pick a random
// TELEGRAM_SECRET_TOKEN (verifies that inbound updates really come from Telegram); the instance sets the webhook
// itself when it serves at a public URL (`http.publicUrl`), or by hand:
//   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
//     -d url=https://your.host/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN

// Your policy, the same whichever way the channel receives.
const policy: Pick<TelegramChannelOptions, "onError" | "route" | "botUsername"> = {
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

// Each way's `needs` declares the env vars it reads: an instance is asked only for its way's, and refused to serve
// while a required one is unset.
export default byIngress({
  webhook: needs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"], (secrets) =>
    telegramChannel({
      botToken: secrets.TELEGRAM_BOT_TOKEN, // used to send the agent's reply back to the chat
      secretToken: secrets.TELEGRAM_SECRET_TOKEN, // verifies inbound updates really come from Telegram
      ...policy,
    }),
  ),
  connection: needs(["TELEGRAM_BOT_TOKEN"], (secrets) =>
    telegramPollingChannel({ botToken: secrets.TELEGRAM_BOT_TOKEN, ...policy }),
  ),
});
