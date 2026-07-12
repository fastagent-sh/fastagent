/** `@fastagent-sh/fastagent/feishu` — the Feishu (open.feishu.cn) bot channel subpath export, kept off
 *  the root surface. Same engine as `@fastagent-sh/fastagent/lark`; the kind picks the cloud. */
export {
  feishuChannel,
  defaultLarkRoute,
  larkEnvelope,
  type LarkChannelOptions,
  type LarkMessageEvent,
  type LarkMessage,
  type LarkRoute,
  type LarkFailure,
} from "./channels/lark/lark.ts";
