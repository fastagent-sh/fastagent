import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildProject } from "../../../src/harnesses/pi-durable/build.ts";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";
import { made, project, FILES, listing } from "../../integration/real-toolchain/build-fixtures.ts";

vi.mock("../../../src/harnesses/pi-durable/tsc.ts", () => import("../../doubles/tsc-double.ts"));

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
      "fastagent.config.d.ts",
      "fastagent.config.js",
      "fastagent.schema.json",
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
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./fastagent.schema.json": "./fastagent.schema.json",
      },
      dependencies: { lodash: "^4" },
      peerDependencies: { "@fastagent-sh/fastagent": "^0.29.0", "@earendil-works/pi-durable": "1.5.0" },
    });
  });

  it("refuses what a dev serve refuses, before writing anything", async () => {
    const dir = project({ "src/tools/bad.ts": "throw new Error('boom at import');\n" });
    await expect(buildProject(dir)).rejects.toThrow("src/tools/bad.ts: boom at import");
    expect(readdirSync(dir)).not.toContain("dist");
  });

  it("`fastagent build --json` compiles through the CLI entry and emits dist/", async () => {
    const dir = await agentWorkspace("fa-cli-build-");
    const built = await runInProcess(["build", dir, "--json"]);
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout)).toMatchObject({
      dist: expect.stringMatching(/\/dist$/),
      name: expect.any(String),
      version: "0.0.0",
      warnings: [],
    });
  });
});
