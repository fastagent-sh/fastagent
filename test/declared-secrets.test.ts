import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allSecrets, describeSecrets, missingSecrets } from "../src/declared-secrets.ts";
import { gateSecrets } from "../src/secrets-gate.ts";
import { defineChannel, defineSchedule, defineTool, z } from "../src/index.ts";
import { inspectChannels, loadChannels } from "../src/channels/discover.ts";
import { loadTools } from "../src/engines/pi/tool.ts";
import { resolveAgentTools } from "../src/engines/pi/create.ts";
import { loadSchedules } from "../src/schedule/discover.ts";
import { resolveAgentAssembly } from "../src/engines/pi/open.ts";

/** An agent dir (nested layout, so `resolveAgentAssembly` reads it as the agent). */
async function agent(files: Record<string, string>): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), "fa-declared-"));
  const dir = join(host, "fastagent");
  await mkdir(join(dir, "tools"), { recursive: true });
  await mkdir(join(dir, "schedules"), { recursive: true });
  await mkdir(join(dir, "channels"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai/gpt-4o-mini" };\n`);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("declared secrets: the rule", () => {
  it("reports only names with no value, grouped by the file to open", () => {
    const declared = [
      { name: "X_API_KEY", source: "tools/x-post.ts" },
      { name: "X_API_SECRET", source: "tools/x-post.ts" },
      { name: "SLACK_TOKEN", source: "schedules/digest.ts" },
    ];
    const env = { X_API_KEY: "k", X_API_SECRET: "" }; // empty counts as missing (an unset .env line)
    expect(missingSecrets(declared, env).map((s) => s.name)).toEqual(["X_API_SECRET", "SLACK_TOKEN"]);
    expect(describeSecrets(declared)).toBe(
      "X_API_KEY, X_API_SECRET (tools/x-post.ts); SLACK_TOKEN (schedules/digest.ts)",
    );
  });

  it("gates the OWNER about to run, and only that owner", () => {
    // The three policies the gate owns, at their smallest: subset by owner, the refusal's wording,
    // and (below, in the loader cases) reporting load failures before it throws.
    const declared = new Map([
      ["x-post", [{ name: "X_API_KEY", source: "tools/x-post.ts" }]],
      ["digest", [{ name: "SLACK_TOKEN", source: "schedules/digest.ts" }]],
    ]);
    const env = { SLACK_TOKEN: "t" };
    expect(() => gateSecrets({ declared, failures: [], env })).toThrow(/X_API_KEY \(tools\/x-post\.ts\)/);
    expect(() => gateSecrets({ declared, failures: [], owner: "digest", env })).not.toThrow();
    expect(() => gateSecrets({ declared, failures: [], owner: "x-post", env })).toThrow(/X_API_KEY/);
    // An owner nobody declared for is not a refusal: it declared nothing, so nothing gates it.
    expect(() => gateSecrets({ declared, failures: [], owner: "unknown", env })).not.toThrow();
  });

  it("reports load failures before refusing, so a broken file is never hidden by a missing value", () => {
    const said: string[] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation((message: string) => void said.push(message));
    try {
      expect(() =>
        gateSecrets({
          declared: new Map([["needy", [{ name: "FA_TEST_UNSET", source: "tools/needy.ts" }]]]),
          failures: [{ label: "tools/broken.ts", file: "/x/tools/broken.ts", message: "boom" }],
          env: {},
        }),
      ).toThrow(/FA_TEST_UNSET/);
      expect(said.join("\n")).toMatch(/tools\/broken\.ts failed to load/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("declared secrets: where they are declared", () => {
  it("defineTool carries the declaration to the loader, attributed to the file", async () => {
    const dir = await agent({
      "tools/x-post.mjs": `export default { name: "x-post", description: "p", parameters: {},
         secrets: ["X_API_KEY"], execute: async () => ({ content: [] }) };\n`,
    });
    expect([...(await loadTools(dir)).secrets]).toEqual([
      ["x-post", [{ name: "X_API_KEY", source: "tools/x-post.mjs" }]],
    ]);
    // A programmatic tool declares the same way, so config.tools is not a hole in the list.
    const configured = defineTool({
      name: "gh",
      description: "gh",
      input: z.object({}),
      secrets: ["GH_TOKEN"],
      execute: () => "ok",
    });
    const resolved = await resolveAgentTools({ tools: [configured] }, dir, dir);
    // BY TOOL, so a caller running one of them (`fastagent tool`) can ask for just that one.
    expect([...resolved.toolSecrets]).toEqual([
      ["x-post", [{ name: "X_API_KEY", source: "tools/x-post.mjs" }]],
      ["gh", [{ name: "GH_TOKEN", source: 'config.tools "gh"' }]], // the ENTRY, not just the list
    ]);
    expect(allSecrets(resolved.toolSecrets)).toEqual([
      { name: "X_API_KEY", source: "tools/x-post.mjs" },
      { name: "GH_TOKEN", source: 'config.tools "gh"' },
    ]);
  });

  it("defineSchedule declares too; a malformed declaration is a load failure, never dropped", async () => {
    const dir = await agent({
      "schedules/digest.mjs": `export default { cron: "0 9 * * *", prompt: "d", secrets: ["SLACK_TOKEN"] };\n`,
      "schedules/bad.mjs": `export default { cron: "0 9 * * *", prompt: "d", secrets: "SLACK_TOKEN" };\n`,
      "tools/bad.mjs": `export default { name: "b", description: "b", parameters: {}, secrets: "X", execute: async () => ({}) };\n`,
    });
    const loaded = await loadSchedules(dir);
    expect([...loaded.secrets]).toEqual([["digest", [{ name: "SLACK_TOKEN", source: "schedules/digest.mjs" }]]]);
    expect(loaded.failures.map((f) => f.label)).toEqual(["schedules/bad.mjs"]);
    expect((await loadTools(dir)).failures.map((f) => f.message)).toEqual([
      "tools/bad.mjs: secrets must be an array of env-var names",
    ]);
  });
});

describe("declared secrets: the values reach the code that declared them", () => {
  it("a tool reads its own declaration through ctx.secrets, fresh per call", async () => {
    const tool = defineTool({
      name: "post",
      description: "post",
      input: z.object({}),
      secrets: ["FA_TEST_POST_KEY"],
      // Typed from the declaration: FA_TEST_POST_KEY is a known key here, a typo would not compile.
      execute: (_input, ctx) => ctx.secrets.FA_TEST_POST_KEY,
    });
    process.env.FA_TEST_POST_KEY = "k1";
    try {
      expect((await tool.execute("c1", {})).details).toBe("k1");
      process.env.FA_TEST_POST_KEY = "k2"; // rotated between calls, no restart
      expect((await tool.execute("c2", {})).details).toBe("k2");
    } finally {
      delete process.env.FA_TEST_POST_KEY;
    }
  });

  it("a channel declares through defineChannel, keeping its module form", async () => {
    process.env.FA_TEST_BOT_TOKEN = "t0ken";
    try {
      const routeChannel = defineChannel({
        secrets: ["FA_TEST_BOT_TOKEN"],
        channel: (secrets) => () => ({ "POST /x": () => new Response(secrets.FA_TEST_BOT_TOKEN) }),
      });
      // Still a plain function (the route-channel module form) — the declaration rides as a property.
      expect(typeof routeChannel).toBe("function");
      expect(routeChannel.secrets).toEqual(["FA_TEST_BOT_TOKEN"]);
      const dir = await agent({});
      await writeFile(
        join(dir, "channels", "custom.mjs"),
        `export default Object.assign((ctx) => ({ "POST /x": () => new Response("ok") }), { secrets: ["FA_TEST_BOT_TOKEN"] });\n`,
      );
      // A CUSTOM channel's credentials exist nowhere else — this is the only way deploy learns them.
      const inspected = await inspectChannels(dir);
      expect([...inspected.secrets]).toEqual([
        ["custom", [{ name: "FA_TEST_BOT_TOKEN", source: "channels/custom.mjs" }]],
      ]);
    } finally {
      delete process.env.FA_TEST_BOT_TOKEN;
    }
  });

  it("a schedule builds its prompt from the values it declared", async () => {
    process.env.FA_TEST_DIGEST = "#ops";
    try {
      const schedule = defineSchedule({
        cron: "0 9 * * *",
        secrets: ["FA_TEST_DIGEST"],
        prompt: (secrets) => `Post the digest to ${secrets.FA_TEST_DIGEST}`,
      });
      expect(schedule.prompt).toBe("Post the digest to #ops"); // resolved at load: consumers see one shape
      expect(schedule.secrets).toEqual(["FA_TEST_DIGEST"]);
    } finally {
      delete process.env.FA_TEST_DIGEST;
    }
  });
});

describe("declared secrets: only what actually runs", () => {
  it("drops the declaration of a discovered tool that is shadowed and never mounted", async () => {
    // `tools/read.ts` loses its name to the coding tool `read`, so its body never executes — gating a
    // start on a secret it declared would refuse to serve for a tool nobody can call.
    const dir = await agent({
      "tools/read.mjs": `export default { name: "read", description: "r", parameters: {},
         secrets: ["FA_TEST_SHADOWED"], execute: async () => ({ content: [] }) };\n`,
    });
    const resolved = await resolveAgentTools({}, dir, dir);
    expect(resolved.toolCollisions.map((c) => c.name)).toContain("read");
    expect(allSecrets(resolved.toolSecrets)).toEqual([]);
  });

  it("drops the declaration of a config.tools entry shadowed by a coding tool", async () => {
    // Same rule as a shadowed `tools/` file, and the reason it needs its own case: config.tools are
    // dropped by a DIFFERENT branch (name already taken by a pi coding tool), which once bypassed
    // the mounted-only filter and refused to start for a tool nobody could call.
    const dir = await agent({});
    const shadowed = defineTool({
      name: "read",
      description: "shadowed by the coding tool",
      input: z.object({}),
      secrets: ["FA_TEST_CONFIG_SHADOWED"],
      execute: () => "ok",
    });
    const resolved = await resolveAgentTools({ tools: [shadowed] }, dir, dir);
    expect(resolved.toolCollisions).toContainEqual({ name: "read", source: "config.tools" });
    expect(allSecrets(resolved.toolSecrets)).toEqual([]);
  });

  it("a channel with a malformed declaration is ONE file's failure, not the whole directory", async () => {
    const dir = await agent({});
    await writeFile(
      join(dir, "channels", "bad.mjs"),
      `export default Object.assign(() => ({}), { secrets: "FOO" });\n`,
    );
    await writeFile(
      join(dir, "channels", "ok.mjs"),
      `export default () => ({ "POST /ok": () => new Response("ok") });\n`,
    );
    const agentStub = { invoke: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }) };
    const loaded = await loadChannels(dir, { agent: agentStub as never, stateRoot: dir });
    expect(loaded.failures.map((f) => f.message)).toEqual([
      "channels/bad.mjs: secrets must be an array of env-var names",
    ]);
    expect(Object.keys(loaded.routes)).toEqual(["POST /ok"]); // the good one still mounted
  });

  it("a missing channel credential does not swallow the malformed file beside it", async () => {
    // The assertion throws out of loadChannels, so a file failure collected on the way would be
    // invisible until the operator fixed the environment and ran again. Both are reported.
    const dir = await agent({});
    await writeFile(
      join(dir, "channels", "bad.mjs"),
      `export default Object.assign(() => ({}), { secrets: "FOO" });\n`,
    );
    await writeFile(
      join(dir, "channels", "needy.mjs"),
      `export default Object.assign(() => ({ "POST /n": () => new Response("n") }), { secrets: ["FA_TEST_CH_TOKEN"] });\n`,
    );
    delete process.env.FA_TEST_CH_TOKEN;
    const said: string[] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation((message: string) => void said.push(message));
    try {
      await expect(loadChannels(dir, { agent: {} as never, stateRoot: dir })).rejects.toThrow(
        /FA_TEST_CH_TOKEN \(channels\/needy\.mjs\)/,
      );
      expect(said.join("\n")).toMatch(/channels\/bad\.mjs: secrets must be an array of env-var names/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("declared secrets: the serving guarantee", () => {
  it("a missing tool credential does not swallow the broken tool file beside it", async () => {
    // The assertion throws out of the opener, while the CLI prints `toolFailures` only after it gets
    // an assembly back — so without reporting first, a broken tools/*.ts would stay invisible until
    // the author fixed the environment and ran again. Same order `loadChannels` establishes.
    const dir = await agent({
      "tools/broken.mjs": `throw new Error("boom at import");\n`,
      "tools/needy.mjs": `export default { name: "needy", description: "n", parameters: {},
         secrets: ["FA_TEST_NEEDY_KEY"], execute: async () => ({ content: [] }) };\n`,
    });
    delete process.env.FA_TEST_NEEDY_KEY;
    const said: string[] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation((message: string) => void said.push(message));
    try {
      await expect(resolveAgentAssembly(dir)).rejects.toThrow(/FA_TEST_NEEDY_KEY \(tools\/needy\.mjs\)/);
      expect(said.join("\n")).toMatch(/tools\/broken\.mjs failed to load/);
    } finally {
      warn.mockRestore();
    }
  });

  it("the agent opener refuses to assemble while a declared value is unset, naming the file", async () => {
    const dir = await agent({
      "tools/x-post.mjs": `export default { name: "x-post", description: "p", parameters: {},
         secrets: ["FA_TEST_X_API_KEY"], execute: async () => ({ content: [] }) };\n`,
    });
    delete process.env.FA_TEST_X_API_KEY;
    await expect(resolveAgentAssembly(dir)).rejects.toThrow(/FA_TEST_X_API_KEY \(tools\/x-post\.mjs\)/);
    process.env.FA_TEST_X_API_KEY = "k";
    try {
      // Same definition, value present: the assembly proceeds and reports what it asserted.
      const assembly = await resolveAgentAssembly(dir);
      expect(allSecrets(assembly.toolSecrets)).toEqual([{ name: "FA_TEST_X_API_KEY", source: "tools/x-post.mjs" }]);
    } finally {
      delete process.env.FA_TEST_X_API_KEY;
    }
  });
});
