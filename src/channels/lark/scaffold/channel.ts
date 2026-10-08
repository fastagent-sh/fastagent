import {
  type LarkChannelOptions,
  larkChannel,
  larkIngress,
  larkWebSocketChannel,
} from "@fastagent-sh/fastagent/lark";
import { defineChannel } from "@fastagent-sh/fastagent";

// The branded Lark adapter over fastagent's canonical Feishu engine (verify + run + reply), configured
// with YOUR policy. Lark international (open.larksuite.com) only; a Feishu tenant uses `fastagent add
// feishu` instead.
//
// How it receives is LARK_INGRESS (webhook | websocket). Unset, `fastagent dev` connects OUT by
// WebSocket (no public URL, no tunnel), and everything else — `fastagent start`, every deployment —
// receives by webhook at POST /lark, which `deploy --run` prepares the app for (if Lark refuses its
// config API, set the Request URL in the console once). One app delivers to
// one place at a time: a deploy moves it to the deployment, `dev --tunnel` moves it back.
//
// `fastagent add lark` guides the console setup and validates the credentials. In the developer
// console:
//   1. create a custom app → enable the BOT capability → copy App ID / App Secret into .env
//   2. Permissions: add `im:message.p2p_msg:readonly` (direct messages), `im:message.group_at_msg:readonly`
//      (group @mentions), `im:message:send_as_bot` (reply), `im:resource` (attachments), and the
//      card scope ("Create and update card" — the live preview streams through a card). So the Agent
//      hears its group chats, also add `im:message.group_msg` (sensitive), `im:message:readonly` and
//      `im:chat.members:read`; for webhook, `application:application:patch` lets fastagent set the
//      Request URL. What each is for is in the channel guide; the channel warns about any it lacks.
//   3. Events & Callbacks → subscribe to `im.message.receive_v1`. For webhook, copy the Verification
//      Token into .env (RECOMMENDED: set an Encrypt Key there and mirror it in LARK_ENCRYPT_KEY).
//   4. create a version and publish the app (a tenant admin approves it), then add the bot to a chat

// Your policy, the same whichever way the channel receives.
const policy: Pick<LarkChannelOptions, "onError" | "route"> = {
  // No session modes: a chat is one session and a thread is another, and where the answer goes follows
  // from that (docs/design/participant-model.md).
  // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
  // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
  // full details always go to the server log regardless.
  onError: (failed) => `⚠️ ${failed.details}`,
  // The channel owns transport + format (markdown card) + attachments (image→vision, file→disk) +
  // the live streaming preview. `route` (POLICY) is OPTIONAL — omitted, it uses defaultLarkRoute:
  // p2p chats always answer; groups answer on @this-bot, plus bare messages in a thread where the
  // Agent takes part and exactly ONE human does. Other group/thread discussion is read from the
  // platform by that place's next answered turn; @other-only messages are discussion, not asks.
  // Override to customise explicit routing, reusing the export:
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { session: `user:${e.sender?.sender_id?.open_id}` },
  //   route: (e) => defaultLarkRoute(e, { botOpenId: "ou_xxx" }) && { text: `${larkEnvelope(e)}\n[extra]` },
};

// `secrets`: the env vars this channel needs. fastagent carries them to a deployed box and refuses to
// serve while one is unset. LARK_ENCRYPT_KEY is optional, so it is read, not declared.
export default larkIngress() === "webhook"
  ? defineChannel({
      secrets: ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_VERIFICATION_TOKEN"],
      channel: (secrets) =>
        larkChannel({
          appId: secrets.LARK_APP_ID,
          appSecret: secrets.LARK_APP_SECRET,
          verificationToken: secrets.LARK_VERIFICATION_TOKEN, // authenticates inbound events
          encryptKey: process.env.LARK_ENCRYPT_KEY || undefined, // when set, plaintext events are refused
          ...policy,
        }),
    })
  : defineChannel({
      secrets: ["LARK_APP_ID", "LARK_APP_SECRET"],
      channel: (secrets) =>
        larkWebSocketChannel({ appId: secrets.LARK_APP_ID, appSecret: secrets.LARK_APP_SECRET, ...policy }),
    });
