import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject } from "../../../packages/fastagent/src/harnesses/build.ts";
import { buildDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { DEFINITION_FORMAT } from "../../../packages/fastagent/src/definition/definition.ts";
import { made, project, FILES, listing } from "../../fixtures/build-fixtures.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

beforeAll(() => {
  const tscBin = join(repoRoot, "node_modules/typescript/bin/tsc");
  for (const pkg of ["client", "fastagent"] as const) {
    const pkgDir = join(repoRoot, "packages", pkg);
    if (!existsSync(join(pkgDir, "dist/index.d.ts"))) {
      execFileSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });
    }
  }
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("fastagent build", () => {
  it("exports the definition from the generated entry, its modules running from dist/", async () => {
    const { dist } = await buildProject(project(FILES));
    const built = (await import(join(dist, "index.js"))).default;
    // A built package is what an instance reads, never the author's working copy.
    expect(built).not.toHaveProperty("source");
    expect(built).toMatchObject({
      format: DEFINITION_FORMAT,
      builtWith: expect.any(String),
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      dir: dist,
    });
    expect(built.inputs.secrets).toEqual([]);
    const [tool] = buildDefinition(built, {}).tools;
    const result = await tool?.execute({ text: "hi" }, {} as never, {} as never);
    expect(result?.output).toEqual([{ type: "text", text: "HI kg from the note" }]);
  });

  it("refuses a type error, and emits it anyway with --no-check", async () => {
    const dir = project({ ...FILES, "lib/shout.ts": "export const shout = (text: string): number => text;\n" });
    await expect(buildProject(dir)).rejects.toThrow(/tsc refused the project[\s\S]*lib\/shout\.ts.*TS2322/);
    const { dist } = await buildProject(dir, { check: false });
    expect(listing(dist)).toContain("lib/shout.js");
  });
});
