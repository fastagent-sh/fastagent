import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildProject } from "../../../packages/fastagent/src/harnesses/build.ts";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";
import { made, project, FILES, listing } from "../../fixtures/build-fixtures.ts";

vi.mock("../../../packages/fastagent/src/definition/tsc.ts", () => import("../../doubles/tsc-double.ts"));

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("fastagent build", () => {
  it("writes dist/: the compiled code, its text and resources, and nothing of the machine's", async () => {
    const dir = project(FILES);
    const { dist } = await buildProject(dir);
    expect(listing(dist)).toEqual([
      "AGENTS.md",
      "LICENSE",
      "SYSTEM.md",
      "build.json",
      "fastagent.config.js",
      "index.d.ts",
      "index.js",
      "lib/shout.js",
      "package.json",
      "prompts/review.md",
      "skills/lookup/SKILL.md",
      "src/tools/lookup.js",
      "src/tools/lookup/data.json",
      "src/tools/lookup/note.txt",
    ]);
    expect(JSON.parse(readFileSync(join(dist, "package.json"), "utf8"))).toEqual({
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      type: "module",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      dependencies: { lodash: "^4" },
      peerDependencies: { "@fastagent-sh/fastagent": "^0.29.0", "@earendil-works/pi-durable": "1.5.0" },
    });
  });

  it("refuses what a dev serve refuses, before writing anything", async () => {
    const dir = project({ "src/tools/bad.ts": "throw new Error('boom at import');\n" });
    await expect(buildProject(dir)).rejects.toThrow("src/tools/bad.ts: boom at import");
    expect(readdirSync(dir)).not.toContain("dist");
  });

  it("refuses an invalid static tool export and leaves the previous valid dist/ intact", async () => {
    const dir = project(FILES);
    const { dist } = await buildProject(dir);
    const previousEntry = readFileSync(join(dist, "index.js"), "utf8");
    const previousRecord = readFileSync(join(dist, "build.json"), "utf8");

    writeFileSync(join(dir, "src", "tools", "billing-note.ts"), "export default 42;\n");
    await expect(buildProject(dir)).rejects.toThrow(/src\/tools\/billing-note\.ts:.*must default-export a tool/);
    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(previousEntry);
    expect(readFileSync(join(dist, "build.json"), "utf8")).toBe(previousRecord);
    expect(listing(dist)).not.toContain("src/tools/billing-note.js");
  });

  it("builds a needs(...) tool factory without executing it or requiring its runtime secret", async () => {
    const dir = project({
      ...FILES,
      "src/tools/secret-tool.ts": `import { obj, str } from "@earendil-works/pi-schema";
import { defineTool, needs } from "@fastagent-sh/fastagent";
export default needs(["BILLING_API_KEY"], ({ BILLING_API_KEY }) => {
  if (!BILLING_API_KEY.startsWith("sk_")) {
    throw new Error("malformed BILLING_API_KEY");
  }
  return defineTool({
    name: "secret_tool",
    description: "Uses a secret.",
    parameters: obj({ query: str() }),
    execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });
});
`,
    });
    const prevKey = process.env.BILLING_API_KEY;
    delete process.env.BILLING_API_KEY;
    try {
      const { dist } = await buildProject(dir);
      expect(listing(dist)).toContain("src/tools/secret-tool.js");
    } finally {
      if (prevKey !== undefined) process.env.BILLING_API_KEY = prevKey;
    }
  });

  it("refuses invalid static extension and provider exports before writing dist/", async () => {
    const badExt = project({ "src/extensions/broken.ts": "export default 42;\n" });
    await expect(buildProject(badExt)).rejects.toThrow(/src\/extensions\/broken\.ts:.*must be an extension/);
    expect(readdirSync(badExt)).not.toContain("dist");

    const badProvider = project({ "fastagent.config.ts": "export default { providers: [42] };\n" });
    await expect(buildProject(badProvider)).rejects.toThrow(
      /fastagent\.config\.ts providers\[0\]:.*must be a pi-ai provider/,
    );
    expect(readdirSync(badProvider)).not.toContain("dist");
  });

  it("places optional harness packages (@fastagent-sh/harness-dsh) in dist/ peerDependencies", async () => {
    const dir = project({
      ...FILES,
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "dsh", sandbox: "read-only" };\n',
      "package.json": JSON.stringify({
        name: "@acme/sandboxed-agent",
        version: "1.0.0",
        type: "module",
        dependencies: {
          "@fastagent-sh/fastagent": "^0.35.0",
          "@fastagent-sh/harness-dsh": "^0.35.0",
          lodash: "^4",
        },
      }),
    });
    const { dist } = await buildProject(dir);
    expect(JSON.parse(readFileSync(join(dist, "package.json"), "utf8"))).toMatchObject({
      dependencies: { lodash: "^4" },
      peerDependencies: {
        "@fastagent-sh/fastagent": "^0.35.0",
        "@fastagent-sh/harness-dsh": "^0.35.0",
      },
    });
  });

  it("`fastagent build --json` compiles through the CLI entry and emits dist/", async () => {
    const dir = await agentWorkspace("fa-cli-build-");
    const built = await runInProcess(["-C", dir, "build", "--json"]);
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout)).toMatchObject({
      dist: expect.stringMatching(/\/dist$/),
      name: expect.any(String),
      version: "0.0.0",
      warnings: [],
    });
  });
});
