/**
 * `fastagent build`: a source project compiled into `dist/`, the package an app or a host opens. Projects sit under
 * test/fixtures so their imports resolve this repository's packages, TypeScript included, as an installed agent's do.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { buildDefinition } from "../src/harnesses/pi-durable/open.ts";
import { ROOT, made, project, FILES, listing } from "./build-fixtures.ts";

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
      format: 1,
      builtWith: expect.any(String),
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      dir: dist,
    });
    expect(built.inputs.secrets).toEqual([
      { name: "LOOKUP_KEY", description: "the lookup service", optional: false, declaredIn: ["context.json"] },
    ]);
    const [tool] = buildDefinition(built, { LOOKUP_KEY: "k" }).tools;
    const result = await tool?.execute({ text: "hi" }, {} as never, {} as never);
    expect(result?.output).toEqual([{ type: "text", text: "HI kg from the note" }]);
  });

  it("refuses a type error, and emits it anyway with --no-check", async () => {
    const dir = project({ ...FILES, "lib/shout.ts": "export const shout = (text: string): number => text;\n" });
    await expect(buildProject(dir)).rejects.toThrow(/tsc refused the project[\s\S]*lib\/shout\.ts.*TS2322/);
    const { dist } = await buildProject(dir, { check: false });
    expect(listing(dist)).toContain("lib/shout.js");
  });

  it("refuses source outside the project, with or without the type check, and writes nothing beside it", async () => {
    const outside = join(ROOT, `.tmp-shared-${process.pid}`);
    made.push(outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "shout.ts"), "export const shout = (text: string): string => text;\n");
    const dir = project({
      "src/tools/far.ts": `import { shout } from ${JSON.stringify(join(outside, "shout.ts"))};\nexport default shout;\n`,
    });
    for (const check of [true, false]) {
      await expect(buildProject(dir, { check })).rejects.toThrow(/imports source from outside .*shout\.ts/);
      expect(readdirSync(outside)).toEqual(["shout.ts"]);
      expect(readdirSync(dir)).not.toContain("dist");
    }
  });

  it("builds a project that links a workspace package, whose declarations emit nothing", async () => {
    const shared = join(ROOT, `.tmp-workspace-${process.pid}`);
    made.push(shared);
    mkdirSync(join(shared, "dist"), { recursive: true });
    writeFileSync(
      join(shared, "package.json"),
      JSON.stringify({ name: "@acme/shared", type: "module", exports: { ".": "./dist/index.js" } }),
    );
    writeFileSync(join(shared, "dist/index.js"), "export const unit = 'kg';\n");
    writeFileSync(join(shared, "dist/index.d.ts"), "export declare const unit: string;\n");
    const dir = project({
      ...FILES,
      "src/tools/unit.ts": `import { unit } from "@acme/shared";\nexport default { name: "unit", value: unit };\n`,
    });
    mkdirSync(join(dir, "node_modules/@acme"), { recursive: true });
    symlinkSync(shared, join(dir, "node_modules/@acme/shared"));
    const { dist } = await buildProject(dir);
    expect(listing(dist)).toContain("src/tools/unit.js");
    expect(readdirSync(join(shared, "dist"))).toEqual(["index.d.ts", "index.js"]);
  });

  it("leaves the dist/ before it as it was when a build fails", async () => {
    const dir = project(FILES);
    const { dist } = await buildProject(dir);
    const before = listing(dist);
    writeFileSync(join(dir, "lib/shout.ts"), "export const shout = (text: string): number => text;\n");
    await expect(buildProject(dir)).rejects.toThrow(/tsc refused the project/);
    expect(listing(dist)).toEqual(before);
    expect(readdirSync(join(dir, ".fastagent"))).toEqual([]);
  });

  it("refuses syntax a dev serve could not run, as Node's type stripping would", async () => {
    const dir = project({ "src/tools/level.ts": "export enum Level { Low }\nexport default {};\n" });
    await expect(buildProject(dir)).rejects.toThrow(/TS1294/);
  });

  it("packs all of dist/ and no secret file: npm pack holds what the build wrote, none of it a .env", async () => {
    const { dist } = await buildProject(project(FILES));
    const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json"], { cwd: dist });
    const [{ files }] = JSON.parse(stdout) as [{ files: { path: string }[] }];
    const packed = files.map((file) => file.path).sort();
    expect(packed).toEqual(listing(dist));
    expect(packed.filter((file) => /(^|\/)(\.env|\.secrets)/.test(file))).toEqual([]);
  });
});
