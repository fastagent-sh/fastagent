/**
 * The configuration of an instance (agent-artifact.md §3.2, §4.2): the program's defaults, an instance's values over
 * them, the settings checked against the program's schema, each value with its source. What a reader of the resolved
 * configuration does with it is that reader's test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, int, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { instanceConfigSchema, resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { type AgentDefinition, defineDefinition } from "../src/harnesses/pi-durable/definition.ts";
import { openAgent, openServing } from "../src/harnesses/pi-durable/serve.ts";
import { buildDefinitionShape, loadDevProject, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { pickedModelLine } from "../src/cli/shared.ts";
import { buildable, runInProcess } from "./cli-run.ts";
import { FIXTURES } from "./probe-package.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const SETTINGS = obj({ repo: str(), digestChannel: opt(str()), retries: opt(int({ minimum: 0 })) });

const program = (config: object) =>
  defineDefinition({
    format: 1,
    builtWith: "0.0.0",
    name: "reviewer",
    version: "1.0.0",
    dir: "/program",
    config,
    registry: { tools: [], extensions: [], channels: [], schedules: [] },
  });

const reviewer = program({
  settings: SETTINGS,
  defaults: {
    model: "openai/gpt-5.5",
    thinkingLevel: "high",
    http: { port: 8787, api: true },
    settings: { digestChannel: "#general" },
  },
});

const instance = (values: unknown) => ({ values, label: "fastagent.json" });

describe("resolveConfig", () => {
  it("is the program's defaults, each from the program, when no instance gives any", () => {
    const config = resolveConfig(program({ defaults: { model: "a/b", http: { port: 9000 } } }));
    expect(config).toMatchObject({ model: "a/b", http: { port: 9000 }, settings: {} });
    expect(config.sources).toEqual({ model: "program default", "http.port": "program default" });
  });

  it("lets an instance say its own description and starters, starters over the program's, each with its source", () => {
    const base = program({ defaults: { starters: ["Review this PR"] } });
    expect(resolveConfig(base)).toMatchObject({ starters: ["Review this PR"] });
    expect(resolveConfig(base)).not.toHaveProperty("description");
    const config = resolveConfig(base, instance({ description: "Reviews our monorepo.", starters: ["Review #1"] }));
    expect(config).toMatchObject({ description: "Reviews our monorepo.", starters: ["Review #1"] });
    expect(config.sources).toMatchObject({ description: "fastagent.json", starters: "fastagent.json" });
    expect(() => resolveConfig(base, instance({ starters: Array(7).fill("hi") }))).toThrow("/starters");
    expect(() => resolveConfig(base, instance({ description: "  " }))).toThrow("/description");
  });

  it("puts an instance over the defaults key by key: objects merge, so a port leaves api alone", () => {
    const config = resolveConfig(
      reviewer,
      instance({ model: "anthropic/claude-x", http: { port: 9000 }, settings: { repo: "acme/api" } }),
    );
    expect(config).toMatchObject({
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      http: { port: 9000, api: true },
      settings: { repo: "acme/api", digestChannel: "#general" },
    });
    expect(config.sources).toEqual({
      model: "fastagent.json",
      thinkingLevel: "program default",
      "http.port": "fastagent.json",
      "http.api": "program default",
      "settings.repo": "fastagent.json",
      "settings.digestChannel": "program default",
    });
  });

  it("replaces an array whole rather than merging it", () => {
    const tagged = program({
      settings: obj({ tags: opt({ type: "array", items: { type: "string" } } as never) }),
      defaults: { settings: { tags: ["a", "b"] } },
    });
    expect(resolveConfig(tagged, instance({ settings: { tags: ["c"] } })).settings).toEqual({ tags: ["c"] });
  });

  it.each([
    ["a key the shape does not have", { modle: "a/b" }, "fastagent.json: /modle unknown field"],
    ["a port out of range", { http: { port: 70000 } }, "/http/port expected <= 65535"],
    ["a model that is not provider/modelId", { model: "nomodel" }, '/model must be "provider/modelId"'],
    ["a setting the program does not declare", { settings: { team: "x" } }, "/settings/team unknown field"],
    ["a setting of the wrong type", { settings: { repo: 7 } }, "/settings/repo"],
    ["instructions that are not a list of paths", { instructions: "./AGENTS.md" }, "/instructions"],
    ["a skills list with an empty path", { skills: [""] }, "/skills/0"],
    ["a prompts list naming one directory twice", { prompts: ["./p", "./p"] }, "/prompts"],
  ])("refuses %s, naming the file and the path", (_what, values, message) => {
    expect(() => resolveConfig(reviewer, instance({ settings: { repo: "r" }, ...values }))).toThrow(message);
  });

  it("refuses a configuration that is not an object", () => {
    expect(() => resolveConfig(reviewer, instance([]))).toThrow("fastagent.json: (the value)");
  });

  it("refuses a required setting no one gave, naming it, and accepts it once the instance does", () => {
    expect(() => resolveConfig(reviewer)).toThrow("the settings of reviewer: /repo missing");
    expect(() => resolveConfig(reviewer, instance({ settings: {} }))).toThrow("/repo missing");
    expect(resolveConfig(reviewer, instance({ settings: { repo: "r" } })).settings).toMatchObject({ repo: "r" });
  });

  it("gives a program with no settings schema none to set", () => {
    expect(() => resolveConfig(program({}), instance({ settings: { x: 1 } }))).toThrow("/settings/x unknown field");
  });
});

describe("instanceConfigSchema", () => {
  it("accepts what resolves and refuses what does not, with the settings partial", () => {
    const check = compile(instanceConfigSchema(SETTINGS));
    expect(check.check({ $schema: "./x.json", model: "a/b", settings: { repo: "r" } })).toBe(true);
    expect(check.check({ settings: {} })).toBe(true);
    expect(check.check({ settings: { repo: 1 } })).toBe(false);
    expect(check.check({ http: { port: -1 } })).toBe(false);
  });

  it("describes the content an instance adds: a repository or a directory, by name", () => {
    const check = compile(instanceConfigSchema(undefined));
    expect(
      check.check({ content: { app: { github: "a/b", ref: "main" }, data: { path: "/srv/data", description: "d" } } }),
    ).toBe(true);
    for (const content of [{ x: {} }, { x: { github: "a/b", path: "/x" } }, { x: { path: "/x", ref: "main" } }]) {
      expect(check.check({ content }), JSON.stringify(content)).toBe(false);
    }
    // The program's defaults are not where content goes: it is context.json's, or an instance's.
    expect(() => resolveConfig(program({ defaults: { content: { x: { path: "/x" } } } }))).toThrow(
      /\/content unknown field/,
    );
  });

  it("describes the MCP servers an instance adds, which the program's defaults do not carry", () => {
    const check = compile(instanceConfigSchema(undefined));
    expect(check.check({ mcpServers: { notes: { type: "http", url: "https://notes.example.com/mcp" } } })).toBe(true);
    expect(check.check({ mcpServers: [] })).toBe(false);
    expect(() => resolveConfig(program({ defaults: { mcpServers: {} } }))).toThrow(/\/mcpServers unknown field/);
  });

  it("refuses an instance's MCP server that is not one, naming the file, and accepts it once it is", () => {
    const given = (mcpServers: unknown) => () =>
      resolveConfig(reviewer, instance({ settings: { repo: "r" }, mcpServers }));
    expect(given({ x: { type: "http", url: "http://outside.example/mcp" } })).toThrow(
      /fastagent\.json: MCP endpoints require HTTPS/,
    );
    expect(given({ x: { command: "node", args: ["$" + "{input:token}"] } })).toThrow(
      /fastagent\.json: x supports only/,
    );
    expect(given({ x__y: { command: "node" } })).toThrow(/fastagent\.json: server names must be/);
    expect(given({ x: { command: "node" } })).not.toThrow();
  });

  it("describes the text an instance adds, which the program's defaults do not carry", () => {
    const check = compile(instanceConfigSchema(undefined));
    expect(check.check({ instructions: ["./AGENTS.md"], skills: ["./skills"], prompts: ["./prompts"] })).toBe(true);
    // Relative to the instance's file, which a program's defaults have none of.
    for (const key of ["instructions", "skills", "prompts"]) {
      expect(() => resolveConfig(program({ defaults: { [key]: ["./x"] } }))).toThrow(
        new RegExp(`/${key} unknown field`),
      );
    }
  });

  it("refuses a bad content entry in an instance's file by naming it and the file, not as a schema path", () => {
    const refused = (content: unknown, directory?: string) =>
      resolveConfig(reviewer, {
        values: { settings: { repo: "r" }, content },
        label: "fastagent.json",
        ...(directory === undefined ? {} : { directory }),
      });
    expect(() => refused({ x: { description: "d" } })).toThrow('fastagent.json: content "x" needs "github" or "path"');
    expect(() => refused({ x: { path: "rel" } })).toThrow(/content "x": "path" must be absolute here/);
    expect(refused({ x: { path: "rel" } }, "/etc/me").sources["content.x.path"]).toBe("fastagent.json");
  });
});

describe("a project's configuration", () => {
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(FIXTURES, ".tmp-config-"));
    made.push(dir);
    writeFileSync(join(dir, "fastagent.config.ts"), "export default {};\n");
    for (const [name, text] of Object.entries({ "SYSTEM.md": "x\n", ...files })) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  // A literal, as the scaffold writes it: only pi-schema is imported, so the build reads no FastAgent source.
  const CONFIG = `import { obj, opt, str } from "@earendil-works/pi-schema";
export default {
  settings: obj({ repo: str(), digestChannel: opt(str()) }),
  defaults: { model: "openai/gpt-5.5", settings: { digestChannel: "#general" } },
};
`;

  it("refuses a configuration whose defaults break its own shape, at load and so at build", async () => {
    const dir = project({ "fastagent.config.ts": `export default { defaults: { http: { port: "x" } } };\n` });
    await expect(loadSourceDefinition(dir)).rejects.toThrow("fastagent.config.ts defaults: /http/port");
    const settings = project({ "fastagent.config.ts": `export default { settings: { type: "string" } };\n` });
    await expect(loadSourceDefinition(settings)).rejects.toThrow('"settings" must be an object schema');
  });

  it("refuses a `__proto__` key instead of merging it into Object.prototype", () => {
    const definition = program({ settings: obj({ extra: opt(map(unknown())) }) });
    const hostile = JSON.parse('{"settings":{"extra":{"__proto__":{"polluted":"yes"}}}}');
    expect(() => resolveConfig(definition, { values: hostile, label: "fastagent.json" })).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts the line the model picker tells a person to keep, pasted as it is printed", async () => {
    const dir = project({ "fastagent.config.ts": `export default { ${pickedModelLine("openai/gpt-5.5")} };\n` });
    expect((await loadSourceDefinition(dir)).config.defaults?.model).toBe("openai/gpt-5.5");
  });

  it("is reported by `info --json` with the source of each value, `fastagent.json` at the root over the defaults", async () => {
    const dir = project({
      "fastagent.config.ts": CONFIG,
      "fastagent.json": JSON.stringify({ http: { port: 9001 }, settings: { repo: "acme/api" } }),
    });
    await buildable(dir);
    const result = await runInProcess(["info", dir, "--json"]);
    expect(result.code).toBe(0);
    const { config } = JSON.parse(result.stdout) as { config: Record<string, { value: unknown; source: string }> };
    expect(config).toEqual({
      model: { value: "openai/gpt-5.5", source: "program default" },
      "http.port": { value: 9001, source: join(dir, "fastagent.json") },
      "settings.digestChannel": { value: "#general", source: "program default" },
      "settings.repo": { value: "acme/api", source: join(dir, "fastagent.json") },
    });
    const flagged = JSON.parse((await runInProcess(["info", dir, "--json", "--model", "openai/gpt-4o"])).stdout);
    expect(flagged.config.model).toEqual({ value: "openai/gpt-4o", source: "--model" });
  });

  it("refuses a dev instance that lacks a required setting, naming it", async () => {
    const dir = project({ "fastagent.config.ts": CONFIG });
    await buildable(dir);
    const result = await runInProcess(["info", dir, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the settings of");
    expect(result.stderr).toContain("/repo missing");
  });

  it("reaches the code that asks for it: `needs` hands a module the resolved settings, beside its secrets", async () => {
    const dir = project({
      "fastagent.config.ts": CONFIG,
      "fastagent.json": JSON.stringify({ settings: { repo: "acme/api" } }),
      "src/tools/repo.ts": `import { needs } from "@fastagent-sh/fastagent";
export default needs([], (_secrets, settings: { repo: string; digestChannel?: string }) => ({
  name: "repo",
  description: "the repository",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ output: [{ type: "text", text: settings.repo + " " + settings.digestChannel }] }),
}));
`,
    });
    await buildable(dir);
    const { definition, instance } = await loadDevProject(dir);
    const opened = await openServing(definition, {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      ...(instance === undefined ? {} : { config: instance }),
      storage: "memory",
    });
    try {
      const [tool] = opened.code.tools;
      expect((await tool?.execute({}, {} as never, {} as never))?.output).toEqual([
        { type: "text", text: "acme/api #general" },
      ]);
    } finally {
      await opened.agent.close();
    }
    // A build that only reads the shape (`models`, `login`) has the program's default settings, and no more.
    const shaped = buildDefinitionShape(definition, {});
    expect((await shaped.tools[0]?.execute({}, {} as never, {} as never))?.output).toEqual([
      { type: "text", text: "undefined #general" },
    ]);
  });

  it("is opened by `openAgent` from an object or an absolute path, and refuses a relative one", async () => {
    const dir = project({ "fastagent.config.ts": CONFIG });
    await buildable(dir);
    const { dist } = await buildProject(dir);
    const { loadBuiltDefinition } = await import("../src/harnesses/pi-durable/built.ts");
    const definition = await loadBuiltDefinition(dist);
    const root = mkdtempSync(join(tmpdir(), "fa-config-open-"));
    made.push(root);
    await expect(openAgent(definition, { root })).rejects.toThrow("/repo missing");
    await expect(openAgent(definition, { root, config: "fastagent.json" })).rejects.toThrow(
      "config must be an absolute path",
    );
    writeFileSync(join(root, "instance.json"), JSON.stringify({ settings: { repo: "acme/api" } }));
    const agent = await openAgent(definition, { root, config: join(root, "instance.json"), offline: true });
    await agent.close();
    const second = await openAgent(definition, { root, config: { settings: { repo: "acme/web" } }, offline: true });
    await second.close();
    await expect(openAgent(definition, { root, config: join(root, "missing.json") })).rejects.toThrow(
      "cannot read the instance configuration",
    );
  });

  it("`openAgent` given a root and no config reads the fastagent.json there, and nothing else is read or made", async () => {
    const dir = project({ "fastagent.config.ts": CONFIG });
    await buildable(dir);
    const { dist } = await buildProject(dir);
    const { loadBuiltDefinition } = await import("../src/harnesses/pi-durable/built.ts");
    const definition = await loadBuiltDefinition(dist);
    const root = mkdtempSync(join(tmpdir(), "fa-config-root-"));
    made.push(root);
    const file = join(root, "fastagent.json");
    // No file is the program's defaults, and opening makes none.
    await expect(openAgent(definition, { root, offline: true })).rejects.toThrow("/repo missing");
    expect(existsSync(file)).toBe(false);
    // An open that succeeds without a file makes none either: a program that needs no settings.
    const plain = project({ "fastagent.config.ts": "export default {};\n" });
    await buildable(plain);
    const plainDefinition = await loadBuiltDefinition((await buildProject(plain)).dist);
    await (await openAgent(plainDefinition, { root, offline: true })).close();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ settings: { repo: "acme/api" } }));
    await (await openAgent(definition, { root, offline: true })).close();
    // A config that is given is used as it is, and the file is not read.
    writeFileSync(file, "{ not json");
    await (await openAgent(definition, { root, config: { settings: { repo: "acme/web" } }, offline: true })).close();
    await expect(openAgent(definition, { root, offline: true })).rejects.toThrow(`${file} is not JSON`);
    // Only the root form: a workdir's fastagent.json is another instance's (the development one).
    writeFileSync(file, JSON.stringify({ settings: { repo: "acme/api" } }));
    const stateDir = join(root, "state");
    await expect(openAgent(definition, { workdir: root, stateDir, offline: true })).rejects.toThrow("/repo missing");
  });

  it("publishes the JSON Schema of an instance's file beside the package, settings included", async () => {
    const dir = project({ "fastagent.config.ts": CONFIG });
    await buildable(dir);
    const { dist } = await buildProject(dir);
    const schema = JSON.parse((await import("node:fs")).readFileSync(join(dist, "fastagent.schema.json"), "utf8"));
    expect(schema.properties.settings.properties).toHaveProperty("repo");
    expect(schema.properties.settings.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("a built package's types", () => {
  it("types the definition by the program's settings, which tsc checks an embedder's config against", async () => {
    const dir = mkdtempSync(join(FIXTURES, ".tmp-config-types-"));
    made.push(dir);
    writeFileSync(join(dir, "package.json"), '{"name":"typed","type":"module"}');
    writeFileSync(
      join(dir, "fastagent.config.ts"),
      `import { obj, opt, str } from "@earendil-works/pi-schema";
export default { settings: obj({ repo: str(), digestChannel: opt(str()) }), defaults: {} };
`,
    );
    await buildable(dir);
    const { dist } = await buildProject(dir);
    const declaration = readFileSync(join(dist, "index.d.ts"), "utf8");
    expect(declaration).toContain("AgentDefinition<SettingsOf<typeof config>>");
    expect(readFileSync(join(dist, "fastagent.config.d.ts"), "utf8")).toContain("repo: string");
    const plain = mkdtempSync(join(FIXTURES, ".tmp-config-plain-"));
    made.push(plain);
    writeFileSync(join(plain, "package.json"), '{"name":"plain","type":"module"}');
    await buildable(plain);
    expect(readFileSync(join((await buildProject(plain)).dist, "index.d.ts"), "utf8")).toContain(
      "declare const definition: AgentDefinition;",
    );
  });
});

// Checked by `tsc`, which runs over the tests: a definition typed by its settings types an embedder's `config`.
declare const typed: AgentDefinition<{ repo: string; digestChannel?: string }>;
const typedSettings = () => [
  openAgent(typed, { root: "/instance", config: { settings: { repo: "acme/api" } } }),
  // @ts-expect-error a setting the program does not declare
  openAgent(typed, { root: "/instance", config: { settings: { repoo: "acme/api" } } }),
  // @ts-expect-error a setting of the wrong type
  openAgent(typed, { root: "/instance", config: { settings: { repo: 7 } } }),
];

void typedSettings;
