import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuManagedRoots } from "../src/channels/feishu/managed-roots.ts";
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

describe("managed Feishu/Lark group-thread root cache", () => {
  it("persists a root and recognizes it only in its source chat after restart", () => {
    const path = statePath();
    const first = createFeishuManagedRoots(path, "[lark]", () => 123);

    first.add("oc_1", "om_root");
    first.add("oc_1", "om_root"); // idempotent

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      om_root: { rootId: "om_root", chatId: "oc_1", createdAt: 123 },
    });
    const restarted = createFeishuManagedRoots(path, "[lark]");
    expect(restarted.has("oc_1", "om_root")).toBe(true);
    expect(restarted.has("oc_other", "om_root")).toBe(false);
  });

  it("a failed cache write warns but keeps the root in memory (cache, not source of truth)", () => {
    const root = mkdtempSync(join(tmpdir(), "feishu-owned-"));
    roots.push(root);
    // Block the write at the seam: the state file's parent path is a FILE, so saveStateFile's mkdir
    // throws everywhere (mode bits would be a no-op for root in CI containers).
    const blocker = join(root, "sub");
    const store = createFeishuManagedRoots(join(blocker, "owned-threads.json"), "[feishu]");
    writeFileSync(blocker, "");
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    store.add("oc_1", "om_root");

    expect(store.has("oc_1", "om_root")).toBe(true);
    expect(warnings.some((message) => message.includes("could not persist managed-thread cache"))).toBe(true);
  });

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({ om_root: { rootId: 42, chatId: "oc_1", createdAt: 123 } }));
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    const store = createFeishuManagedRoots(path, "[feishu]");

    expect(store.has("oc_1", "om_root")).toBe(false);
    expect(warnings.some((message) => message.includes("starting with no managed group threads"))).toBe(true);
  });
});
