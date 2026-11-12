import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectCompiler } from "../src/harnesses/pi-durable/tsc.ts";

/** A project whose `node_modules/typescript` is `version`, or that has none. */
function projectWith(version?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-tsc-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  if (version !== undefined) {
    const typescript = join(dir, "node_modules", "typescript");
    mkdirSync(join(typescript, "bin"), { recursive: true });
    writeFileSync(
      join(typescript, "package.json"),
      JSON.stringify({ name: "typescript", version, bin: { tsc: "./bin/tsc" } }),
    );
  }
  return dir;
}

describe("the project's compiler", () => {
  it("names the TypeScript it needs when the project's is older, before it runs anything", async () => {
    const dir = projectWith("5.9.2");
    await expect(projectCompiler(dir).files(["a.ts"])).rejects.toThrow(/needs TypeScript 7 or newer; .* has 5\.9\.2/);
  });

  it("says how to install TypeScript when the project has none", async () => {
    const dir = projectWith();
    await expect(projectCompiler(dir).emit(dir, ["a.ts"], true)).rejects.toThrow(
      /compiles with the project's TypeScript, and .* has none: npm install --save-dev typescript/,
    );
  });
});
