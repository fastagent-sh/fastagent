/** `@fastagent-sh/fastagent/lark` — the Lark-international compatibility surface over the canonical
 *  Feishu engine. Feishu tenants use `@fastagent-sh/fastagent/feishu`. */
export {
  larkChannel,
  larkWebSocketChannel,
  defaultLarkRoute,
  larkEnvelope,
  type LarkChannelOptions,
  type LarkWebSocketChannelOptions,
  type LarkMessageEvent,
  type LarkMessage,
  type LarkRoute,
  type LarkFailure,
} from "./channels/lark/lark.ts";
export { larkTransport, type FeishuTransport as LarkTransport } from "./channels/feishu/shared-api.ts";
