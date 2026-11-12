import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageOwners } from "../src/channels/kit/message-owners.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const freshPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), "owners-"));
  roots.push(root);
  return join(root, "owners.json");
};

describe("message owners", () => {
  it("names the conversation a message was recorded for, across a restart", () => {
    const path = freshPath();
    createMessageOwners({ label: "[t]", path }).record("m1", { conversation: "chat#alice", ask: "a1" });
    const reopened = createMessageOwners({ label: "[t]", path });
    expect(reopened.ownerOf("m1")).toEqual({ conversation: "chat#alice", ask: "a1" });
    expect(reopened.ownerOf("other")).toBeUndefined();
  });

  it("keeps the newest messages and drops the oldest", () => {
    const owners = createMessageOwners({ label: "[t]", path: freshPath(), maxMessages: 10 });
    for (let i = 0; i < 11; i++) owners.record(`m${i}`, { conversation: "c" });
    expect(owners.ownerOf("m0")).toBeUndefined();
    expect(owners.ownerOf("m1")).toEqual({ conversation: "c" });
    expect(owners.ownerOf("m10")).toEqual({ conversation: "c" });
  });

  it("starts empty, and says so, when the file has an unexpected shape", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ m1: "chat#alice" }));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(createMessageOwners({ label: "[t]", path }).ownerOf("m1")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unexpected shape"));
  });

  it("keeps a record in memory and says so when the file cannot be written", () => {
    const path = freshPath();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const owners = createMessageOwners({ label: "[t]", path });
    mkdirSync(`${path}.tmp`); // the atomic write now fails
    owners.record("m1", { conversation: "c" });
    expect(owners.ownerOf("m1")).toEqual({ conversation: "c" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not write"));
  });
});
