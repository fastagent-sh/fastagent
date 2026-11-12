/**
 * The configuration of an instance: the program's defaults, an instance's values over
 * them, the settings checked against the program's schema, each value with its source. What a reader of the resolved
 * configuration does with it is that reader's test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { buildable } from "./cli-run.ts";
import { FIXTURES } from "./probe-package.ts";
import { made, typedSettings } from "./config-fixtures.ts";

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
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

void typedSettings;
