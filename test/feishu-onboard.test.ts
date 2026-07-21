import { describe, expect, it, vi } from "vitest";
import { configureGroupBehavior } from "../src/cli/add-feishu.ts";
import type { FeishuAppScope, FeishuApi } from "../src/channels/feishu/feishu-api.ts";

function fixture(scopes: FeishuAppScope[] = []): {
  api: Pick<FeishuApi, "listAppScopes" | "addAppScopes">;
  addAppScopes: ReturnType<typeof vi.fn>;
  notes: string[];
  opened: string[];
} {
  const addAppScopes = vi.fn(async () => {});
  return {
    api: { listAppScopes: async () => scopes, addAppScopes },
    addAppScopes,
    notes: [],
    opened: [],
  };
}

describe("Feishu/Lark group-behavior onboarding", () => {
  it("adds the sensitive scope to the draft for recommended context-aware groups", async () => {
    const fx = fixture();
    const result = await configureGroupBehavior({
      kind: "feishu",
      appId: "cli_a",
      apiBase: "https://open.feishu.cn",
      api: fx.api,
      behavior: "context",
      explicit: true,
      note: (message) => fx.notes.push(message),
      openUrl: (url) => fx.opened.push(url),
    });

    expect(result).toEqual({ publishReady: false });
    expect(fx.addAppScopes).toHaveBeenCalledWith("cli_a", ["im:message.group_msg"]);
    expect(fx.notes.join("\n")).toMatch(/context-aware \(recommended\).*all group messages/);
    expect(fx.notes.join("\n")).toContain("complete tenant-admin approval before publishing");
    expect(fx.opened).toEqual(["https://open.feishu.cn/app/cli_a/permission"]);
  });

  it("recognizes an already-granted tenant scope as ready to publish without reopening the console", async () => {
    const fx = fixture([{ name: "im:message.group_msg", grantStatus: 1, type: "tenant" }]);
    const result = await configureGroupBehavior({
      kind: "feishu",
      appId: "cli_a",
      apiBase: "https://open.feishu.cn",
      api: fx.api,
      behavior: "context",
      explicit: true,
      note: (message) => fx.notes.push(message),
      openUrl: (url) => fx.opened.push(url),
    });

    expect(result).toEqual({ publishReady: true });
    expect(fx.addAppScopes).not.toHaveBeenCalled();
    expect(fx.notes.at(-1)).toContain("already granted");
    expect(fx.opened).toEqual([]);
  });

  it("keeps mention-only least privilege explicit and blocks publish on a conflicting existing grant", async () => {
    const missing = fixture();
    const missingResult = await configureGroupBehavior({
      kind: "lark",
      appId: "cli_l",
      apiBase: "https://open.larksuite.com",
      api: missing.api,
      behavior: "mentions",
      explicit: true,
      note: (message) => missing.notes.push(message),
      openUrl: (url) => missing.opened.push(url),
    });
    expect(missingResult).toEqual({ publishReady: true });
    expect(missing.notes.join("\n")).toMatch(/mention-only.*bare managed-thread replies.*disabled/);
    expect(missing.addAppScopes).not.toHaveBeenCalled();
    expect(missing.opened).toEqual([]);

    const granted = fixture([{ name: "im:message.group_msg", grantStatus: 1, type: "tenant" }]);
    const grantedResult = await configureGroupBehavior({
      kind: "lark",
      appId: "cli_l",
      apiBase: "https://open.larksuite.com",
      api: granted.api,
      behavior: "mentions",
      explicit: true,
      note: (message) => granted.notes.push(message),
      openUrl: (url) => granted.opened.push(url),
    });
    expect(grantedResult).toEqual({ publishReady: false });
    expect(granted.notes.join("\n")).toContain("already granted");
    expect(granted.notes.join("\n")).toContain("remove it");
    expect(granted.opened).toEqual(["https://open.larksuite.com/app/cli_l/permission"]);
  });

  it("never requests the sensitive scope for a defaulted (non-explicit) context choice", async () => {
    const fx = fixture();
    const result = await configureGroupBehavior({
      kind: "feishu",
      appId: "cli_a",
      apiBase: "https://open.feishu.cn",
      api: fx.api,
      behavior: "context",
      explicit: false,
      note: (message) => fx.notes.push(message),
      openUrl: (url) => fx.opened.push(url),
    });

    expect(result).toEqual({ publishReady: false });
    expect(fx.addAppScopes).not.toHaveBeenCalled();
    expect(fx.notes.join("\n")).toMatch(/defaulted.*--group-behavior context/s);
    expect(fx.opened).toEqual([]);
  });

  it("falls back visibly to manual permission setup when app-config mutation is unavailable", async () => {
    const fx = fixture();
    fx.addAppScopes.mockRejectedValueOnce(new Error("HTTP 404"));
    const result = await configureGroupBehavior({
      kind: "lark",
      appId: "cli_l",
      apiBase: "https://open.larksuite.com",
      api: fx.api,
      behavior: "context",
      explicit: true,
      note: (message) => fx.notes.push(message),
      openUrl: (url) => fx.opened.push(url),
    });

    expect(result).toEqual({ publishReady: false });
    expect(fx.notes.join("\n")).toMatch(/could not add.*add it manually before publishing/);
    expect(fx.opened).toEqual(["https://open.larksuite.com/app/cli_l/permission"]);
  });
});
