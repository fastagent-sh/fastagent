/** `@fastagent-sh/fastagent/lark` — the Lark-international compatibility surface over the canonical
 *  Feishu engine. Feishu tenants use `@fastagent-sh/fastagent/feishu`. */
export {
  larkChannel,
  defaultLarkRoute,
  larkEnvelope,
  type LarkChannelOptions,
  type LarkMessageEvent,
  type LarkMessage,
  type LarkReplyPolicy,
  type LarkRoute,
  type LarkFailure,
} from "./channels/lark/lark.ts";
