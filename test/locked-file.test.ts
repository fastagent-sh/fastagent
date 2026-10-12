import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withLockedFile } from "../src/locked-file.ts";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("re-enters a lock in its active call chain without creating the file", async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-lock-reenter-"));
  const path = join(dir, "context.json");
  const result = await withLockedFile(
    path,
    async () => ({
      result: await withLockedFile(path, async (text) => ({ result: text }), { create: false }),
    }),
    { create: false },
  );
  expect(result).toBeUndefined();
  await expect(readFile(path, "utf8")).rejects.toThrow(/ENOENT/);
});

it("a later callback inheriting a released lock waits for the next owner's lock", async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-lock-later-"));
  const path = join(dir, "context.json");
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let pending!: Promise<string | undefined>;
  let ran = false;
  await withLockedFile(path, async () => {
    pending = ready.then(() =>
      withLockedFile(path, async (text) => {
        ran = true;
        return { result: text };
      }),
    );
    return { result: undefined, next: "first" };
  });
  await withLockedFile(path, async () => {
    resume();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ran).toBe(false);
    return { result: undefined, next: "second" };
  });
  expect(await pending).toBe("second");
});
