import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveExtensions } from "../src/engines/pi/live-extensions.ts";

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-live-ext-"));
  await mkdir(join(dir, "extensions", "notify", "node_modules", "dep"), { recursive: true });
  await mkdir(join(dir, "extensions", ".git"), { recursive: true });
  await writeFile(join(dir, "extensions", "notify", "index.ts"), "export default () => {};\n");
  return dir;
}

describe("engines/pi/live-extensions", () => {
  it("a new generation for the extensions' own code; none for node_modules or a dot directory", async () => {
    const dir = await agentDir();
    const live = liveExtensions(dir, async () => []);
    const generation = async () => (await live.paths()).generation;
    const first = await generation();
    // Every reader asks before it loads, so what is walked must not grow with an extension's dependencies.
    await writeFile(join(dir, "extensions", "notify", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await writeFile(join(dir, "extensions", ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(await generation()).toBe(first);
    await writeFile(join(dir, "extensions", "notify", "helper.ts"), "export const x = 1;\n");
    expect(await generation()).toBe(first + 1);
  });

  it("hands out the generation its list belongs to, not one a concurrent reader moved on to", async () => {
    // A lists, an extension is added meanwhile, B drops the cache and moves the generation on: A's list predates the
    // addition, so filing it under B's generation would pin a catalog without the new extension.
    const dir = await agentDir();
    let release = () => {};
    let calls = 0;
    const live = liveExtensions(dir, async () => {
      if (calls++ === 1) await new Promise<void>((resolve) => (release = resolve));
      return [`list ${calls}`];
    });
    const before = (await live.paths()).generation;
    const a = live.paths(); // parked inside its list
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "extensions", "added.ts"), "export default () => {};\n");
    const b = await live.paths();
    expect(b.generation).toBe(before + 1);
    release();
    expect((await a).generation).toBe(before);
  });
});
