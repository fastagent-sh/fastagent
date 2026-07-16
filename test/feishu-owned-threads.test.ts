import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedFeishuThreads } from "../src/channels/feishu/owned-threads.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "feishu-owned-"));
  roots.push(root);
  return join(root, "owned-threads.json");
}

describe("managed Feishu/Lark group threads", () => {
  it("persists a root before ACK and recognizes it only in its source chat after restart", () => {
    const path = statePath();
    const first = createOwnedFeishuThreads(path, "[lark]", () => 123);

    first.add("oc_1", "om_root");
    first.add("oc_1", "om_root"); // idempotent

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      om_root: { rootId: "om_root", chatId: "oc_1", createdAt: 123 },
    });
    const restarted = createOwnedFeishuThreads(path, "[lark]");
    expect(restarted.has("oc_1", "om_root")).toBe(true);
    expect(restarted.has("oc_other", "om_root")).toBe(false);
  });

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({ om_root: { rootId: 42, chatId: "oc_1", createdAt: 123 } }));
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    const store = createOwnedFeishuThreads(path, "[feishu]");

    expect(store.has("oc_1", "om_root")).toBe(false);
    expect(warnings.some((message) => message.includes("starting with no managed group threads"))).toBe(true);
  });
});
