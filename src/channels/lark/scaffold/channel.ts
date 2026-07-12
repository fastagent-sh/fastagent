import { larkChannel } from "@fastagent-sh/fastagent/lark";

// A channel = a third-party ADAPTER (larkChannel: verify + run + reply) configured with YOUR policy.
// fastagent discovers this file under channels/, mounts POST /lark, and pipes the agent + state home
// to the adapter — this file holds only policy. Lark international (open.larksuite.com) only; a
// Feishu tenant uses `fastagent add feishu` instead. Setup (developer console):
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card)
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`; copy the Verification Token into
//      .env; RECOMMENDED: set an Encrypt Key there and mirror it in LARK_ENCRYPT_KEY
//   4. set the event Request URL (https://your.host/lark) BY HAND in the console with the server
//      running — the platform verifies the URL with a challenge this channel answers. (`dev --tunnel`
//      attempts auto-registration, but the intl cloud does not expose the config API yet.)
//   5. create a version and publish the app (a tenant admin approves it), then add the bot to a chat
export default larkChannel({
  appId: process.env.LARK_APP_ID ?? "", // missing → fails at startup (no replies could be sent)
  appSecret: process.env.LARK_APP_SECRET ?? "",
  verificationToken: process.env.LARK_VERIFICATION_TOKEN ?? "", // authenticates inbound events
  encryptKey: process.env.LARK_ENCRYPT_KEY || undefined, // optional; when set, plaintext events are refused
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // The channel owns transport + format (markdown card) + attachments (image→vision, file→disk) +
  // the live streaming preview. `route` (POLICY) is OPTIONAL — omitted, it uses defaultLarkRoute:
  // p2p chats always answer, groups only on an @mention of this bot (matched by open_id, resolved at
  // startup). Override to customise, reusing the export:
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { session: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { text: `${larkEnvelope(e)}\n[extra]` },
});
