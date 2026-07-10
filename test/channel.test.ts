import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../src/index.ts";
import { loadChannels } from "../src/index.ts";
import { discoverChannelFiles } from "../src/engines/pi/channel.ts";

// loadChannels only forwards the ctx to the factory; these factories ignore it.
const fakeCtx = { agent: {} as Agent, stateRoot: "/unused-in-tests" };
const freshDir = () => mkdtemp(join(tmpdir(), "fa-chan-"));

describe("loadChannels (filesystem discovery)", () => {
  it("discovers channels/* and merges their routes; missing channels/ is empty", async () => {
    const dir = await freshDir();
    expect(await loadChannels(dir, fakeCtx)).toEqual({ routes: {}, collisions: [], failures: [] }); // no channels/ yet

    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "github.mjs"),
      `export default (agent) => ({ "POST /webhook": () => new Response(null, { status: 202 }) });`,
    );
    await writeFile(
      join(dir, "channels", "stripe.mjs"),
      `export default (agent) => ({ "POST /stripe": () => new Response(null, { status: 202 }) });`,
    );
    await writeFile(join(dir, "channels", "disabled.mjs.disabled"), `throw new Error("must not import");`);
    const { routes, collisions, failures } = await loadChannels(dir, fakeCtx);
    expect(Object.keys(routes).sort()).toEqual(["POST /stripe", "POST /webhook"]);
    expect(collisions).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("ISOLATES a channel that throws on import — reports it in failures, still mounts the others (G2)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "boom.mjs"),
      `throw new Error("bad top-level init");\nexport default () => ({});`,
    );
    await writeFile(
      join(dir, "channels", "ok.mjs"),
      `export default () => ({ "POST /ok": () => new Response(null, { status: 202 }) });`,
    );
    const { routes, failures } = await loadChannels(dir, fakeCtx);
    expect(Object.keys(routes)).toEqual(["POST /ok"]); // collect sibling results for one complete report
    expect(failures).toHaveLength(1);
    expect(failures[0]!.label).toBe("channels/boom.mjs");
    expect(failures[0]!.message).toMatch(/bad top-level init/);
  });

  it("collects a channel factory failure (missing env) while validating siblings", async () => {
    // The loader returns every per-file result; the serving composition reports them and fails startup.
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "needsenv.mjs"),
      `export default () => { throw new Error("TELEGRAM_SECRET_TOKEN required"); };`,
    );
    await writeFile(
      join(dir, "channels", "ok.mjs"),
      `export default () => ({ "POST /ok": () => new Response(null, { status: 202 }) });`,
    );
    const { routes, failures } = await loadChannels(dir, fakeCtx);
    expect(Object.keys(routes)).toEqual(["POST /ok"]); // the healthy channel still mounts
    expect(failures.map((f) => f.label)).toEqual(["channels/needsenv.mjs"]);
    expect(failures[0]!.message).toMatch(/TELEGRAM_SECRET_TOKEN/);
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
    const { routes, collisions } = await loadChannels(dir, fakeCtx);
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
    const { routes, collisions } = await loadChannels(dir, fakeCtx);
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
    const { routes, collisions } = await loadChannels(dir, fakeCtx);
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
    const { routes } = await loadChannels(dir, fakeCtx);
    expect(Object.keys(routes)).toEqual(["POST /webhook"]); // followed

    // escaping symlink (channels → an external dir): channels would live outside the agent and a deploy
    // copying the dir would not include them (dev/deployed diverge) → rejected.
    const esc = await freshDir();
    const ext = await freshDir();
    await mkdir(join(ext, "ch"));
    await symlink(join(ext, "ch"), join(esc, "channels"));
    await expect(loadChannels(esc, fakeCtx)).rejects.toThrow(/outside the workspace/);
  });

  it("rejects a relative stateRoot at the mount boundary (the contract says absolute — fail visibly)", async () => {
    const dir = await freshDir();
    await expect(loadChannels(dir, { agent: {} as Agent, stateRoot: "rel/state" })).rejects.toThrow(
      /stateRoot must be absolute/,
    );
  });

  it("isolates (surfaces, not fatal) a channel file that does not default-export a function", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "bad.mjs"), `export const notDefault = 1;`);
    const { routes, failures } = await loadChannels(dir, fakeCtx);
    expect(routes).toEqual({}); // not mounted…
    expect(failures[0]!.message).toMatch(/must default-export \(ctx\) => Routes/); // …but surfaced, never silent
  });

  it("surfaces an async factory with a Promise-specific message (and no unhandled rejection)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    // Rejects after the (microtask) tick — the guard must mark it handled, not leave it unhandled.
    await writeFile(
      join(dir, "channels", "async.mjs"),
      `export default async () => { throw new Error("setup boom"); };`,
    );
    const { failures } = await loadChannels(dir, fakeCtx); // isolated; the Promise is marked handled — no unhandled rejection
    expect(failures[0]!.message).toMatch(/not a Promise|async factory is not supported/);
  });

  it("rejects any non-async return that yields no routes (null, primitive, array, Map, {})", async () => {
    // The invariant is 'an enabled channel file contributes >=1 route'. Each invalid shape is reported;
    // the serving composition treats the resulting failure as fatal.
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
      const { routes, failures } = await loadChannels(dir, fakeCtx);
      expect(routes).toEqual({}); // nothing mounted
      expect(failures[0]!.message).toMatch(/must return a Routes object|declared no routes/);
    }
  });

  it("rejects a route whose value is not a handler function", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "channels"));
    await writeFile(join(dir, "channels", "bad.mjs"), `export default () => ({ "POST /webhook": 42 });`);
    const { failures } = await loadChannels(dir, fakeCtx);
    expect(failures[0]!.message).toMatch(/must map to a handler function/);
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
      const { routes, failures } = await loadChannels(dir, fakeCtx);
      expect(routes).toEqual({}); // no partial mount
      expect(failures[0]!.message).toMatch(/is not a valid route key/);
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
    await writeFile(join(dir, "channels", "slack.ts.disabled"), "not imported\n");
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
