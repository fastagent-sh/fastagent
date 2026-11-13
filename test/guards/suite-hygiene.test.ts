import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { expect, it } from "vitest";

const TEST_ROOT = new URL("../", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp-")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walkTs(TEST_ROOT);
const lines = files.flatMap((file) => {
  const rel = relative(TEST_ROOT, file);
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ file: rel, at: `${rel}:${i + 1}: ${line.trim()}`, line }));
});
const vitestLines = lines.filter(({ file }) => !file.startsWith("smoke/"));

/** How long something took (the clock read minus a start). */
const ELAPSED = /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]/;
/** A lower bound: that the code waited. Load only lengthens a wait, so it cannot fail one. */
const LOWER_BOUND = /\.toBeGreaterThan(?:OrEqual)?\(/;
/** A fixed name beside a temp directory: in the machine's temp directory, which every test process and run shares. */
const SHARED_TEMP = /join\([A-Za-z_$.]+, "\.\.", (?:"[^"]*"|'[^']*'|`[^`$]*`)\)/;
/** A thrown error asserted without saying which: it passes for any error, the wrong one included. */
const ANY_ERROR = /(?<!\.not)\.toThrow(?:Error)?\(\)/;

const VIRTUAL_FIXTURE_TESTS = new Set(["batches.test.ts", "lookup.test.ts", "weather.test.ts"]);

it('no test bounds how long something took (AGENTS.md, "Tests")', () => {
  expect(vitestLines.filter(({ line }) => ELAPSED.test(line) && !LOWER_BOUND.test(line)).map(({ at }) => at)).toEqual(
    [],
  );
});

it("no test writes a fixed name beside its temp directory, where other tests and runs write it too (besideAgent)", () => {
  expect(vitestLines.filter(({ line }) => SHARED_TEMP.test(line)).map(({ at }) => at)).toEqual([]);
});

it('no test asserts that something fails without saying how (AGENTS.md, "Tests")', () => {
  expect(vitestLines.filter(({ line }) => ANY_ERROR.test(line)).map(({ at }) => at)).toEqual([]);
});

it("every shared *-double.ts and cli-run.ts has a parity integration test", () => {
  const doubles = readdirSync(join(TEST_ROOT, "doubles"))
    .filter((file) => file.endsWith("-double.ts"))
    .map((file) => ({
      double: `test/doubles/${file}`,
      parity: join(TEST_ROOT, "integration", "double-parity", file.replace(/\.ts$/, ".integration.test.ts")),
    }));
  doubles.push({
    double: "test/doubles/cli-run.ts",
    parity: join(TEST_ROOT, "integration", "double-parity", "cli-run-parity.integration.test.ts"),
  });
  const missing = doubles
    .filter(({ parity }) => !existsSync(parity))
    .map(({ double, parity }) => `${double} → ${relative(REPO_ROOT, parity)}`);
  expect(missing).toEqual([]);
});

it("no comment or test references a deleted *.test.ts file", () => {
  const present = new Set(files.map((file) => basename(file)));
  const ghosts: string[] = [];
  for (const { at, line } of lines) {
    for (const match of line.matchAll(/(?<![.\w-])([a-z0-9][a-z0-9-]*(?:\.integration)?\.test\.ts)\b/g)) {
      const name = match[1] as string;
      if (!present.has(name) && !VIRTUAL_FIXTURE_TESTS.has(name)) ghosts.push(`${at} (${name})`);
    }
  }
  expect(ghosts).toEqual([]);
});

it("every top-level CLI command in src/cli/program.ts has at least one CLI test", () => {
  const program = readFileSync(join(REPO_ROOT, "src/cli/program.ts"), "utf8");
  const list = /const specs: readonly CommandSpec\[] = \[([\s\S]*?)];/.exec(program)?.[1] ?? "";
  const commands = list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  expect(commands.length).toBeGreaterThan(15);

  const testCorpus = files
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const uncovered = commands.filter(
    (cmd) =>
      !new RegExp(`(?:runInProcess|run|spawnCli|whileRunning|cliInit|cli)\\(\\s*\\[\\s*"${cmd}"`).test(testCorpus),
  );
  expect(uncovered).toEqual([]);
});

it("CLI unit tests use runInProcess instead of manually spying on process.cwd or console.log", () => {
  const offenders = lines
    .filter(
      ({ file, line }) =>
        file.startsWith("unit/cli/") &&
        /vi\.spyOn\(\s*(?:process\s*,\s*["']cwd["']|console\s*,\s*["']log["'])\s*\)/.test(line),
    )
    .map(({ at }) => at);
  expect(offenders).toEqual([]);
});
