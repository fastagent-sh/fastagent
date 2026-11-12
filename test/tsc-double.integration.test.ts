import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as real from "../src/harnesses/pi-durable/tsc.ts";
import { FILES, listing, made, project } from "./build-fixtures.ts";
import * as double from "./tsc-double.ts";

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const ROOTS = ["fastagent.config.ts", "src/tools/lookup.ts", "src/tools/extra.mts"];

const dir = project({
  ...FILES,
  "src/tools/extra.mts": `import type { Shape } from "../../lib/types.ts";
import { shout } from "../../lib/shout.js";
import { plain } from "../../lib/plain.js";
export const extra: Shape = { text: shout(String(plain)) };
export const later = () => import("../../lib/late.ts");
`,
  "lib/types.ts": "export interface Shape { text: string }\n",
  "lib/plain.js": "export const plain = 1;\n",
  "lib/late.ts": "export const late: number = 2;\n",
});

/** What a build reads of a compiler: the project's own sources, its emitted files, and where each emitted module imports from. */
async function seen(compiler: typeof real | typeof double) {
  const tsc = compiler.projectCompiler(dir);
  const sources = (await tsc.files(ROOTS))
    .filter((file) => !file.split(sep).includes("node_modules") && !relative(dir, file).startsWith(".."))
    .map((file) => relative(dir, file))
    .sort();
  const out = mkdtempSync(join(dir, ".out-"));
  const emitted = await tsc.emit(out, ROOTS, false);
  const declared = await tsc.declare(out, "fastagent.config.ts");
  const files = listing(out);
  const imports = Object.fromEntries(
    files
      .filter((file) => /\.[cm]?js$/.test(file))
      .map((file) => [
        file,
        [...readFileSync(join(out, file), "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)]
          .map((match) => match[1])
          .sort(),
      ]),
  );
  return { sources, codes: [emitted.code, declared.code], files, imports };
}

it("reads the same sources and emits the same files, importing the same modules, as tsc", async () => {
  const fromTsc = await seen(real);
  expect(fromTsc.codes).toEqual([0, 0]);
  expect(fromTsc.sources).toContain("lib/types.ts");
  expect(await seen(double)).toEqual(fromTsc);
});
