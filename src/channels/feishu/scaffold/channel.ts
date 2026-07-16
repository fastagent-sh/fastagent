import { feishuChannel } from "@fastagent-sh/fastagent/feishu";

// feishuChannel is fastagent's canonical Feishu adapter (verify + run + reply), configured with YOUR
// policy. fastagent discovers this file, mounts POST /feishu, and pipes the agent + state home to it.
// Feishu (open.feishu.cn) only; a Lark-international
// tenant uses `fastagent add lark` instead. Setup (developer console):
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card). To answer bare
//      messages in Agent-managed threads and buffer other unsummoned group/thread context, also add the
//      sensitive `im:message.group_msg` scope (tenant-admin approval) and publish a new version.
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`; copy the Verification Token into
//      .env; RECOMMENDED: set an Encrypt Key there and mirror it in FEISHU_ENCRYPT_KEY
//   4. the event Request URL (https://your.host/feishu) is registered AUTOMATICALLY by
//      `fastagent dev --tunnel` and `fastagent deploy … --run`; to set it by hand in the console,
//      keep the server running while you save (the platform verifies the URL with a challenge)
//   5. create a version and publish the app (a Feishu admin approves it), then add the bot to a chat
// `fastagent add feishu` already did steps 1-3 for you (scan-to-create); this walkthrough is for a
// hand-made app or for auditing what the scan configured.
export default feishuChannel({
  appId: process.env.FEISHU_APP_ID ?? "", // missing → fails at startup (no replies could be sent)
  appSecret: process.env.FEISHU_APP_SECRET ?? "",
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "", // authenticates inbound events
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined, // optional; when set, plaintext events are refused
  // Direct and group chats default to one Agent session/thread per top-level ask. Opt out independently:
  // directMessageSession: "continuous",
  // groupMessageSession: "continuous",
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // The channel owns transport + format (markdown card) + attachments (image→vision, file→disk) +
  // the live streaming preview. `route` (POLICY) is OPTIONAL — omitted, it uses defaultFeishuRoute:
  // p2p chats always answer; groups answer on @this-bot, plus bare continuations in Agent-managed
  // threads. Other human group/thread discussion buffers until that place's next answered turn;
  // @other-only messages in managed threads buffer rather than triggering the Agent.
  // Override to customise explicit routing, reusing the export:
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { session: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { text: `${feishuEnvelope(e)}\n[extra]` },
});
