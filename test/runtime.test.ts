import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belowFloor, detectRuntime, unsupportedRuntime } from "../src/runtime.ts";

it("a version below the floor is below it, part by part; one that names no version is not judged", () => {
  const verdicts = ["0.9", "1.3.14", "1.4", "1.4.0", "1.4.2", "1.10.0", "2.0.0", "canary"].map((v) =>
    belowFloor(v, "1.4.0"),
  );
  expect(verdicts).toEqual([true, true, false, false, false, false, false, false]);
});

it("refuses Node below 24.15.0 and Bun below 1.4.0, judging Bun by its own version, not the Node it reports", () => {
  expect(unsupportedRuntime({ node: "22.19.0" })).toBe("fastagent needs Node 24.15.0 or later; this is 22.19.0");
  expect(unsupportedRuntime({ node: "24.14.1" })).toMatch(/needs Node 24\.15\.0/);
  expect(unsupportedRuntime({ node: "24.15.0" })).toBeUndefined();
  expect(unsupportedRuntime({ node: "26.1.0" })).toBeUndefined();
  expect(unsupportedRuntime({ node: "24.3.0", bun: "1.3.14" })).toBe(
    "fastagent needs Bun 1.4.0 or later; this is 1.3.14",
  );
  expect(unsupportedRuntime({ node: "24.3.0", bun: "1.4.0" })).toBeUndefined();
});

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
