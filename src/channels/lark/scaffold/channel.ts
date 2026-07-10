import { larkChannel } from "@fastagent-sh/fastagent/lark";

// A channel = a third-party ADAPTER (larkChannel: verify + run + reply) configured with YOUR policy.
// fastagent discovers this file under channels/, mounts POST /lark, and pipes the agent + state home
// to the adapter — this file holds only policy. Setup (Feishu/Lark developer console):
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card)
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`; copy the Verification Token into
//      .env; RECOMMENDED: set an Encrypt Key there and mirror it in LARK_ENCRYPT_KEY
//   4. set the event Request URL to https://your.host/lark — the server must be RUNNING when you
//      save (the console sends a url_verification challenge this channel answers). For local dev,
//      `fastagent dev --tunnel` prints the public URL to paste.
//   5. create a version and publish the app (a Feishu admin approves it), then add the bot to a chat
export default larkChannel({
  appId: process.env.LARK_APP_ID ?? "", // missing → fails at startup (no replies could be sent)
  appSecret: process.env.LARK_APP_SECRET ?? "",
  verificationToken: process.env.LARK_VERIFICATION_TOKEN ?? "", // authenticates inbound events
  encryptKey: process.env.LARK_ENCRYPT_KEY || undefined, // optional; when set, plaintext events are refused
  // Lark international (larksuite.com) tenants: uncomment the next line.
  // baseUrl: "https://open.larksuite.com",
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
