import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../src/index.ts";
import { loadChannels } from "../src/index.ts";

const fakeAgent = {} as Agent; // loadChannels only forwards it to the factory; these factories ignore it
const freshDir = () => mkdtemp(join(tmpdir(), "fa-chan-"));

describe("loadChannels (filesystem discovery)", () => {
  it("discovers channels/* and merges their routes; missing channels/ is empty", async () => {
    const dir = await freshDir();
    expect(await loadChannels(dir, fakeAgent)).toEqual({ routes: {}, collisions: [] }); // no channels/ yet

    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "github.mjs"),
      `export default (agent) => ({ "POST /webhook": () => new Response(null, { status: 202 }) });`,
    );
    await writeFile(
      join(dir, "channels", "stripe.mjs"),
      `export default (agent) => ({ "POST /stripe": () => new Response(null, { status: 202 }) });`,
    );
    const { routes, collisions } = await loadChannels(dir, fakeAgent);
    expect(Object.keys(routes).sort()).toEqual(["POST /stripe", "POST /webhook"]);
    expect(collisions).toEqual([]);
  });

  it("surfaces a route collision (first file wins; the duplicate is dropped, never silent)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    // a.mjs sorts before b.mjs → a wins "POST /webhook"; b's duplicate is dropped + surfaced.
    await writeFile(
      join(dir, "channels", "a.mjs"),
      `export default () => ({ "POST /webhook": () => new Response("a") });`,
    );
    await writeFile(
      join(dir, "channels", "b.mjs"),
      `export default () => ({ "POST /webhook": () => new Response("b") });`,
    );
    const { routes, collisions } = await loadChannels(dir, fakeAgent);
    expect(Object.keys(routes)).toEqual(["POST /webhook"]);
    const res = await routes["POST /webhook"]!(new Request("http://x/webhook"));
    expect(await res.text()).toBe("a");
    expect(collisions).toEqual([{ route: "POST /webhook", source: "channels/b.mjs" }]);
  });

  it("fails visibly when a channel file does not default-export a function", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "bad.mjs"), `export const notDefault = 1;`);
    await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/must default-export \(agent\) => Routes/);
  });

  it("rejects an async factory (the contract is synchronous; a Promise would mount zero routes)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "async.mjs"),
      `export default async () => ({ "POST /webhook": () => new Response("x") });`,
    );
    await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/must return Routes synchronously/);
  });
});
