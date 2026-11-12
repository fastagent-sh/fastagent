import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const TEST_DIR = new URL(".", import.meta.url).pathname;

/** How long something took (the clock read minus a start). */
const ELAPSED = /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]/;
/** A lower bound: that the code waited. Load only lengthens a wait, so it cannot fail one. */
const LOWER_BOUND = /\.toBeGreaterThan(?:OrEqual)?\(/;

it('no test bounds how long something took (CONTRIBUTING.md, "Test tiers")', () => {
  const found = readdirSync(TEST_DIR)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) =>
      readFileSync(`${TEST_DIR}${file}`, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          ELAPSED.test(line) && !LOWER_BOUND.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
  expect(found).toEqual([]);
});
