import { describe, expect, it } from "vitest";
import { FEISHU_CLOUD, LARK_COMPAT_CLOUD, cloudFor } from "../src/channels/feishu/cloud.ts";
import { defaultFeishuRoute, feishuEnvelope } from "../src/feishu.ts";
import { defaultLarkRoute, larkEnvelope } from "../src/lark.ts";

describe("Feishu-reference cloud profiles", () => {
  it("makes Feishu the full-capability reference", () => {
    expect(FEISHU_CLOUD).toMatchObject({
      kind: "feishu",
      factory: "feishuChannel",
      envPrefix: "FEISHU",
      apiBase: "https://open.feishu.cn",
      capabilities: { appCreation: "scan-to-create", eventConfig: "supported" },
    });
    expect(cloudFor("feishu")).toBe(FEISHU_CLOUD);
  });

  it("models Lark as an explicit degraded compatibility profile", () => {
    expect(LARK_COMPAT_CLOUD).toMatchObject({
      kind: "lark",
      factory: "larkChannel",
      envPrefix: "LARK",
      apiBase: "https://open.larksuite.com",
      capabilities: { appCreation: "guided-console", eventConfig: "probe-with-manual-fallback" },
    });
    expect(cloudFor("lark")).toBe(LARK_COMPAT_CLOUD);
  });

  it("keeps canonical Feishu names and branded Lark aliases at their public boundaries", () => {
    expect(defaultLarkRoute).toBe(defaultFeishuRoute);
    const event = {
      sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hi"}',
      },
    };
    expect(feishuEnvelope(event)).toContain("[feishu:");
    expect(larkEnvelope(event)).toContain("[lark:");
  });
});
