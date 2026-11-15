import { needs } from "@fastagent-sh/fastagent";
import { type FeishuWebSocketChannelOptions, feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";

// fastagent's canonical Feishu adapter (receive + run + reply), configured with YOUR policy. Feishu
// (open.feishu.cn) only; a Lark-international tenant uses `fastagent add lark` instead.
//
// The app receives over a long connection this process opens, so it needs no public URL, in `fastagent dev` and in
// a container alike. Feishu hands each event to one of an app's connections: give a deployment an app of its own
// (`fastagent channels setup feishu --env-file prod.env`) and the container that file's values.
//
// `fastagent channels setup feishu` creates and configures the app (scan-to-create). For a hand-made app, in the
// developer console:
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card). So the Agent
//      hears its group chats, also add `im:message.group_msg` (sensitive), `im:message:readonly`,
//      `im:message.reactions:write_only` and `im:chat.members:read`. What each is for is in the channel guide; the
//      channel warns about any it lacks.
//   3. Events & Callbacks → choose long connection → subscribe to `im.message.receive_v1`.
//   4. create a version and publish the app (a Feishu admin approves it), then add the bot to a chat

const policy: Pick<FeishuWebSocketChannelOptions, "onError" | "route"> = {
  // A chat is one conversation and a thread is another, each with a session of its own, and where the
  // answer goes follows from that.
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // The channel owns transport + format (markdown card) + attachments (image→vision, file→disk) +
  // the live streaming preview. `route` (POLICY) is OPTIONAL — omitted, it uses defaultFeishuRoute:
  // p2p chats always answer; groups answer on @this-bot, plus bare messages in a thread where the
  // Agent takes part and exactly ONE human does. Other group/thread discussion is read from the
  // platform by that place's next answered turn; @other-only messages are discussion, not asks.
  // Override to customise explicit routing, reusing the export:
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { conversation: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { text: `${feishuEnvelope(e)}\n[extra]` },
};

// `needs` declares the env vars this file reads: the instance is refused to serve while one is unset.
export default needs(["FEISHU_APP_ID", "FEISHU_APP_SECRET"], (secrets) =>
  feishuWebSocketChannel({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET, ...policy }),
);
