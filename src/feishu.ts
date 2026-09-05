/** `@fastagent-sh/fastagent/feishu` — the canonical Feishu (open.feishu.cn) bot-channel surface. */
export {
  feishuChannel,
  feishuWebSocketChannel,
  defaultFeishuRoute,
  feishuEnvelope,
  type FeishuChannelOptions,
  type FeishuWebSocketChannelOptions,
  type FeishuMessageEvent,
  type FeishuMessage,
  type FeishuRoute,
  type FeishuFailure,
} from "./channels/feishu/feishu.ts";
export { feishuTransport, type FeishuTransport } from "./channels/feishu/shared-api.ts";
