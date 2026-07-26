import { larkChannel } from "@fastagent-sh/fastagent/lark";

// larkChannel is the branded compatibility adapter over fastagent's canonical Feishu engine, configured
// with YOUR policy. fastagent discovers this file, mounts POST /lark, and pipes the agent + state home
// to the adapter. Lark international (open.larksuite.com) only; a
// Feishu tenant uses `fastagent add feishu` instead. Setup (developer console):
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card). To answer bare
//      messages in threads the Agent takes part in, and buffer other unsummoned group/thread context, also add the
//      sensitive `im:message.group_msg` scope (tenant-admin approval) and publish a new version. Add a
//      message-read scope (e.g. `im:message:readonly`) too, so a thread's opening ask can carry the
//      message it quotes; without it that quote degrades to a marker in the prompt.
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`; copy the Verification Token into
//      .env; RECOMMENDED: set an Encrypt Key there and mirror it in LARK_ENCRYPT_KEY
//   4. run `fastagent dev --tunnel`: it attempts to switch Subscription mode to webhook + register
//      the URL automatically. If this app returns a config-API 404, do both BY HAND in the console
//      with the server running (the platform verifies https://your.host/lark with a challenge).
//   5. create a version and publish the app (a tenant admin approves it), then add the bot to a chat
export default larkChannel({
  appId: process.env.LARK_APP_ID ?? "", // missing → fails at startup (no replies could be sent)
  appSecret: process.env.LARK_APP_SECRET ?? "",
  verificationToken: process.env.LARK_VERIFICATION_TOKEN ?? "", // authenticates inbound events
  encryptKey: process.env.LARK_ENCRYPT_KEY || undefined, // optional; when set, plaintext events are refused
  // No session modes: a chat is one session and a thread is another, and where the answer goes follows
  // from that (docs/design/participant-model.md).
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // The channel owns transport + format (markdown card) + attachments (image→vision, file→disk) +
  // the live streaming preview. `route` (POLICY) is OPTIONAL — omitted, it uses defaultLarkRoute:
  // p2p chats always answer; groups answer on @this-bot, plus bare messages in a thread where the
  // Agent takes part and exactly ONE human does. Other human group/thread discussion buffers until
  // that place's next answered turn; @other-only messages buffer rather than triggering the Agent.
  // Override to customise explicit routing, reusing the export:
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { session: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { text: `${larkEnvelope(e)}\n[extra]` },
});
