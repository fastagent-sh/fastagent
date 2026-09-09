import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../src/runtime.ts";

describe("detectRuntime", () => {
  const freshDir = () => mkdtemp(join(tmpdir(), "fa-rt-"));

  it("reads bun from packageManager or a lockfile, node otherwise, and tracks hasLockfile", async () => {
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
    expect(detectRuntime(dir, {})).toEqual({ runtime: "node", hasLockfile: false });

    const bun = await freshDir();
    await writeFile(join(bun, "bun.lock"), ""); // a lockfile alone → oven/bun:1
    expect(detectRuntime(bun, {})).toEqual({ runtime: "bun", bunVersion: undefined, hasLockfile: true });

    const node = await freshDir();
    await writeFile(join(node, "package-lock.json"), "{}");
    expect(detectRuntime(node, { packageManager: "npm@10" })).toEqual({ runtime: "node", hasLockfile: true });
  });
});
