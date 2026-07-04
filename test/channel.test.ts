import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../src/index.ts";
import { loadChannels } from "../src/index.ts";
import { discoverChannelFiles } from "../src/engines/pi/channel.ts";

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

  it("detects a method-overlap collision (any-method vs specific, same path)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    // a.mjs (sorts first) mounts any-method /webhook; b's POST /webhook would be shadowed by it.
    await writeFile(join(dir, "channels", "a.mjs"), `export default () => ({ "/webhook": () => new Response("a") });`);
    await writeFile(
      join(dir, "channels", "b.mjs"),
      `export default () => ({ "POST /webhook": () => new Response("b") });`,
    );
    const { routes, collisions } = await loadChannels(dir, fakeAgent);
    expect(Object.keys(routes)).toEqual(["/webhook"]); // a wins; b dropped, not silently shadowed
    expect(collisions).toEqual([{ route: "POST /webhook", source: "channels/b.mjs" }]);
  });

  it("allows two channels on one path with distinct methods (both reachable)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "get.mjs"), `export default () => ({ "GET /x": () => new Response("g") });`);
    await writeFile(
      join(dir, "channels", "post.mjs"),
      `export default () => ({ "POST /x": () => new Response("p") });`,
    );
    const { routes, collisions } = await loadChannels(dir, fakeAgent);
    expect(Object.keys(routes).sort()).toEqual(["GET /x", "POST /x"]);
    expect(collisions).toEqual([]);
  });

  it("follows an IN-workspace symlinked channels/, but rejects one that ESCAPES the workspace", async () => {
    // in-workspace symlink (channels → ./real-channels): self-contained → followed
    const dir = await freshDir();
    await mkdir(join(dir, "real-channels"));
    await writeFile(
      join(dir, "real-channels", "github.mjs"),
      `export default () => ({ "POST /webhook": () => new Response("x") });`,
    );
    await symlink(join(dir, "real-channels"), join(dir, "channels"));
    const { routes } = await loadChannels(dir, fakeAgent);
    expect(Object.keys(routes)).toEqual(["POST /webhook"]); // followed

    // escaping symlink (channels → an external dir): channels would live outside the agent and a deploy
    // copying the dir would not include them (dev/deployed diverge) → rejected.
    const esc = await freshDir();
    const ext = await freshDir();
    await mkdir(join(ext, "ch"));
    await symlink(join(ext, "ch"), join(esc, "channels"));
    await expect(loadChannels(esc, fakeAgent)).rejects.toThrow(/outside the workspace/);
  });

  it("fails visibly when a channel file does not default-export a function", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "bad.mjs"), `export const notDefault = 1;`);
    await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/must default-export \(agent\) => Routes/);
  });

  it("rejects an async factory with a Promise-specific error (and no unhandled rejection)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    // Rejects after the (microtask) tick — the guard must mark it handled, not leave it unhandled.
    await writeFile(
      join(dir, "channels", "async.mjs"),
      `export default async () => { throw new Error("setup boom"); };`,
    );
    await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/not a Promise|async factory is not supported/);
  });

  it("rejects any non-async return that yields no routes (null, primitive, array, Map, {})", async () => {
    // The invariant is 'a channel file contributes >=1 route'. Each otherwise throws unwrapped or
    // silently mounts zero routes → falls back to /invoke.
    for (const [name, body] of [
      ["nullish", `export default () => null;`],
      ["number", `export default () => 42;`],
      ["array", `export default () => [];`],
      ["map", `export default () => new Map([["POST /webhook", () => new Response("x")]]);`],
      ["empty", `export default () => ({});`],
    ] as const) {
      const dir = await freshDir();
      await mkdir(join(dir, "channels"));
      await writeFile(join(dir, "channels", `${name}.mjs`), body);
      await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/must return a Routes object|declared no routes/);
    }
  });

  it("rejects a route whose value is not a handler function", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "bad.mjs"), `export default () => ({ "POST /webhook": 42 });`);
    await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/must map to a handler function/);
  });

  it("rejects a malformed route key (a handler array's numeric key, or a missing leading slash)", async () => {
    // Both pass the value-is-a-function + >=1-entry checks but mount at an unreachable path.
    for (const body of [
      `export default () => [() => new Response("x")];`, // array → key "0"
      `export default () => ({ "webhook": () => new Response("x") });`, // missing leading /
    ]) {
      const dir = await freshDir();
      await mkdir(join(dir, "channels"));
      await writeFile(join(dir, "channels", "bad.mjs"), body);
      await expect(loadChannels(dir, fakeAgent)).rejects.toThrow(/is not a valid route key/);
    }
  });
});

describe("discoverChannelFiles (the `fastagent info` authoring view)", () => {
  it("lists channel basenames (sorted, no import); empty when there is no channels/", async () => {
    const dir = await freshDir();
    expect(await discoverChannelFiles(dir)).toEqual([]);
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "telegram.ts"), "export default () => ({});\n");
    await writeFile(join(dir, "channels", "github.ts"), "export default () => ({});\n");
    expect(await discoverChannelFiles(dir)).toEqual(["github", "telegram"]);
  });

  it("enforces containment on its OWN path: rejects a channels/ symlink escaping the workspace", async () => {
    // info goes through this, not loadChannels — the boundary guard must hold here independently.
    const dir = await freshDir();
    const ext = await freshDir();
    await mkdir(join(ext, "ch"));
    await symlink(join(ext, "ch"), join(dir, "channels"));
    await expect(discoverChannelFiles(dir)).rejects.toThrow(/outside the workspace/);
  });
});
