import { larkWebSocketChannel } from "@fastagent-sh/fastagent/lark";
import { defineChannel } from "@fastagent-sh/fastagent";

// Lark WebSocket long connection: the process connects OUT to the platform, so no public URL,
// Verification Token, Encrypt Key, or --tunnel is needed. In Events & Callbacks choose long
// connection, subscribe im.message.receive_v1, then publish the app version. Keep one process
// running in production: scale-to-zero/App Sleeping would disconnect ingress.
export default defineChannel({
  // The env vars this channel needs. fastagent carries them to a deployed box and refuses to serve
  // while one is unset — a bare process.env read gets neither guarantee.
  secrets: ["LARK_APP_ID", "LARK_APP_SECRET"],
  channel: (secrets) =>
    larkWebSocketChannel({
      appId: secrets.LARK_APP_ID,
      appSecret: secrets.LARK_APP_SECRET,
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
    }),
});
