import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { buildDefinition } from "../src/harnesses/pi-durable/open.ts";
import { made, project, FILES, listing } from "./build-fixtures.ts";

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
});
