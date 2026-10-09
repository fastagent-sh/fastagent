import {
  type FeishuChannelOptions,
  feishuChannel,
  feishuIngress,
  feishuWebSocketChannel,
} from "@fastagent-sh/fastagent/feishu";
import { defineChannel } from "@fastagent-sh/fastagent";

// fastagent's canonical Feishu adapter (verify + run + reply), configured with YOUR policy. Feishu
// (open.feishu.cn) only; a Lark-international tenant uses `fastagent add lark` instead.
//
// How it receives is FEISHU_INGRESS (webhook | websocket). Unset, `fastagent dev` connects OUT by
// WebSocket (no public URL, no tunnel), and everything else — `fastagent start`, every deployment —
// receives by webhook at POST /feishu. Dev reads .secrets/.env; production reads
// .secrets/production/.env. Interactive `deploy --run` creates a separate production app.
//
// `fastagent add feishu` creates and configures the app (scan-to-create). For a hand-made app, in the
// developer console:
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card). So the Agent
//      hears its group chats, also add `im:message.group_msg` (sensitive), `im:message:readonly` and
//      `im:chat.members:read`; for webhook, `application:application:patch` lets fastagent set the
//      Request URL. What each is for is in the channel guide; the channel warns about any it lacks.
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`. For webhook, copy the Verification
//      Token into .env (RECOMMENDED: set an Encrypt Key there and mirror it in FEISHU_ENCRYPT_KEY).
//   4. create a version and publish the app (a Feishu admin approves it), then add the bot to a chat

// Your policy, the same whichever way the channel receives.
const policy: Pick<FeishuChannelOptions, "onError" | "route"> = {
  // No session modes: a chat is one session and a thread is another, and where the answer goes follows
  // from that (docs/design/participant-model.md).
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
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { session: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultFeishuRoute(e, { botOpenId: "ou_xxx" }) && { text: `${feishuEnvelope(e)}\n[extra]` },
};

// `secrets`: the env vars this channel needs. fastagent carries them to a deployed box and refuses to
// serve while one is unset. FEISHU_ENCRYPT_KEY is optional, so it is read, not declared.
export default feishuIngress() === "webhook"
  ? defineChannel({
      secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
      channel: (secrets) =>
        feishuChannel({
          appId: secrets.FEISHU_APP_ID,
          appSecret: secrets.FEISHU_APP_SECRET,
          verificationToken: secrets.FEISHU_VERIFICATION_TOKEN, // authenticates inbound events
          encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined, // when set, plaintext events are refused
          ...policy,
        }),
    })
  : defineChannel({
      secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      channel: (secrets) =>
        feishuWebSocketChannel({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET, ...policy }),
    });
