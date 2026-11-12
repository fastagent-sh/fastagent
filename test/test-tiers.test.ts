import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const TEST_DIR = new URL(".", import.meta.url).pathname;

/** How long something took (the clock read minus a start). */
const ELAPSED = /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]/;
/** A lower bound: that the code waited. Load only lengthens a wait, so it cannot fail one. */
const LOWER_BOUND = /\.toBeGreaterThan(?:OrEqual)?\(/;
/** A fixed name beside a temp directory: in the machine's temp directory, which every test process and run shares. */
const SHARED_TEMP = /join\([A-Za-z_$.]+, "\.\.", (?:"[^"]*"|'[^']*'|`[^`$]*`)\)/;

const lines = readdirSync(TEST_DIR)
  .filter((file) => file.endsWith(".ts"))
  .flatMap((file) =>
    readFileSync(`${TEST_DIR}${file}`, "utf8")
      .split("\n")
      .map((line, i) => ({ at: `${file}:${i + 1}: ${line.trim()}`, line })),
  );

it('no test bounds how long something took (CONTRIBUTING.md, "Test tiers")', () => {
  expect(lines.filter(({ line }) => ELAPSED.test(line) && !LOWER_BOUND.test(line)).map(({ at }) => at)).toEqual([]);
});

it("no test writes a fixed name beside its temp directory, where other tests and runs write it too (besideAgent)", () => {
  expect(lines.filter(({ line }) => SHARED_TEMP.test(line)).map(({ at }) => at)).toEqual([]);
});
