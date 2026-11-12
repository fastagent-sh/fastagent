/**
 * The configuration of an instance (agent-artifact.md §3.2, §4.2): the program's defaults, an instance's values over
 * them, the settings checked against the program's schema, each value with its source. What a reader of the resolved
 * configuration does with it is that reader's test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import type { AgentDefinition } from "../src/harnesses/pi-durable/definition.ts";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";
import { buildable } from "./cli-run.ts";
import { FIXTURES } from "./probe-package.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
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
