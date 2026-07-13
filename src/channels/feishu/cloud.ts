/**
 * Feishu is the canonical implementation. Lark international speaks the same protocol but trails the
 * primary cloud in control-plane capabilities, so it binds the Feishu engine through this explicit
 * compatibility profile instead of becoming the engine's naming/design center.
 */
export type FeishuCloudKind = "feishu" | "lark";

export interface FeishuCloudProfile {
  kind: FeishuCloudKind;
  envPrefix: "FEISHU" | "LARK";
  apiBase: string;
  capabilities: {
    appCreation: "scan-to-create" | "guided-console";
  };
}

export const FEISHU_CLOUD: FeishuCloudProfile = {
  kind: "feishu",
  envPrefix: "FEISHU",
  apiBase: "https://open.feishu.cn",
  capabilities: {
    appCreation: "scan-to-create",
  },
};

export const LARK_COMPAT_CLOUD: FeishuCloudProfile = {
  kind: "lark",
  envPrefix: "LARK",
  apiBase: "https://open.larksuite.com",
  capabilities: {
    appCreation: "guided-console",
  },
};

export function cloudFor(kind: FeishuCloudKind): FeishuCloudProfile {
  return kind === "feishu" ? FEISHU_CLOUD : LARK_COMPAT_CLOUD;
}
