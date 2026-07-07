import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../src/runtime.ts";

describe("detectRuntime", () => {
  const freshDir = () => mkdtemp(join(tmpdir(), "fa-rt-"));

  it("is bun via packageManager, with the version — and strips corepack's +hash (invalid Docker tag)", async () => {
    const dir = await freshDir();
    expect(detectRuntime(dir, { packageManager: "bun@1.3.13" })).toMatchObject({
      runtime: "bun",
      bunVersion: "1.3.13",
    });
    // corepack format: FROM oven/bun:<version> must not carry the +sha256 suffix.
    expect(detectRuntime(dir, { packageManager: "bun@1.3.13+sha256.deadbeef" })).toMatchObject({
      runtime: "bun",
      bunVersion: "1.3.13",
    });
  });

  it("is bun via a bun lockfile even without packageManager (version undefined → oven/bun:1)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "bun.lock"), "");
    expect(detectRuntime(dir, {})).toEqual({ runtime: "bun", bunVersion: undefined, hasLockfile: true });
  });

  it("is node otherwise; hasLockfile tracks package-lock.json", async () => {
    const dir = await freshDir();
    expect(detectRuntime(dir, {})).toEqual({ runtime: "node", hasLockfile: false });
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(detectRuntime(dir, { packageManager: "npm@10" })).toEqual({ runtime: "node", hasLockfile: true });
  });
});
