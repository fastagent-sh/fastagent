/** Lark-international compatibility adapter. */
import type { ChannelModule, LongConnectionChannelModule } from "../../channel.ts";
import { LARK_COMPAT_CLOUD } from "../feishu/cloud.ts";
import {
  type FeishuChannelOptions,
  type FeishuFailure,
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  type FeishuWebSocketChannelOptions,
  buildFeishuChannel,
  buildFeishuWebSocketChannel,
  defaultFeishuRoute,
} from "../feishu/feishu.ts";
import { cloudEnvelope } from "../feishu/parse.ts";

export type LarkChannelOptions = FeishuChannelOptions;
export type LarkWebSocketChannelOptions = FeishuWebSocketChannelOptions;
export type LarkFailure = FeishuFailure;
export type LarkMessage = FeishuMessage;
export type LarkMessageEvent = FeishuMessageEvent;
export type LarkRoute = FeishuRoute;

export const defaultLarkRoute: typeof defaultFeishuRoute = defaultFeishuRoute;

export function larkEnvelope(event: LarkMessageEvent): string {
  return cloudEnvelope(event, "lark");
}

export function larkChannel(opts: LarkChannelOptions): ChannelModule {
  return buildFeishuChannel(LARK_COMPAT_CLOUD, opts, larkChannel.name);
}

export function larkWebSocketChannel(opts: LarkWebSocketChannelOptions): LongConnectionChannelModule {
  return buildFeishuWebSocketChannel(LARK_COMPAT_CLOUD, opts, larkWebSocketChannel.name);
}
