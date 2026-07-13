/**
 * Lark-international compatibility adapter. Feishu is the canonical protocol/runtime implementation;
 * this module binds it to Lark's cloud profile and exposes natural Lark-branded public names. Lark's
 * weaker control-plane capabilities live in onboarding/registration, not in a fork of the turn engine.
 */
import type { ChannelModule } from "../../host/node.ts";
import { LARK_COMPAT_CLOUD } from "../feishu/cloud.ts";
import {
  type FeishuChannelOptions,
  type FeishuFailure,
  type FeishuMessage,
  type FeishuMessageEvent,
  type FeishuRoute,
  buildFeishuChannel,
  defaultFeishuRoute,
} from "../feishu/feishu.ts";
import { cloudEnvelope } from "../feishu/parse.ts";

export type LarkChannelOptions = FeishuChannelOptions;
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
