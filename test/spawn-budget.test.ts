import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// A process-spawning call site in a test costs ~0.5-1s of CPU per execution (a cold CLI start), and the suite is
// CPU-bound: wall time ~ CPU / cores. The suite was trimmed to its process contracts twice before and grew back both
// times, because nothing noticed the creep. This is that notice: a ratchet on the number of call sites per file.
//
//  - Over budget: the test almost certainly asserts what a COMMAND decides, which `runInProcess` (test/cli-run.ts)
//    answers without a process. Use it. If the test is about the process itself (a pipe, a signal, a command that
//    outlives its caller), raise the file's number here, in the same change, and say why in the PR.
//  - Under budget: lower the number, so the room that was freed cannot be spent on something else.
//
// It counts call sites, not executions, from the source text: `run(` (the cli-run.ts spawn helper) in files that
// import it, `whileRunning(`, `killWhileLingering(`, and a direct spawn/exec of `process.execPath`, `sh` or `node`.
// A deterministic measure of the cause, not a timing of the effect, which varies with the runner.
const BUDGET: Record<string, number> = {
  "ai-start.test.ts": 1,
  "auth-view.test.ts": 1,
  "auth.test.ts": 1,
  "authoring.test.ts": 1,
  "box-login.test.ts": 1,
  "cli-deploy.test.ts": 5,
  "cli-invoke.test.ts": 1,
  "cli-kernel.test.ts": 5,
  "cli-login.test.ts": 8,
  "cli-run-parity.test.ts": 1,
  "cli-schedules.test.ts": 1,
  "cli.test.ts": 10,
  "deployment-start.test.ts": 3,
  "deployment-workspace.test.ts": 1,
  "environment.test.ts": 2,
  "parked-message.test.ts": 1,
  "scheduler-effects.test.ts": 2,
  "ticket.test.ts": 2,
  "turn-runner.test.ts": 1,
};

const CALL_SITES = [
  /(?<![.\w])(whileRunning|killWhileLingering)\(/g,
  /\b(spawn|spawnSync|execFile|execFileSync|execSync|exec)\(\s*(process\.execPath|"sh"|"node")/g,
];
const RUN_HELPER = /(?<![.\w])run\(/g;

function callSites(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const imported = /import\s*\{[^}]*\brun\b[^}]*\}\s*from\s*"\.\/cli-run\.ts"/.test(code);
  const count = (pattern: RegExp) => [...code.matchAll(pattern)].length;
  return CALL_SITES.reduce((sum, pattern) => sum + count(pattern), imported ? count(RUN_HELPER) : 0);
}

it("the number of process-spawning call sites in each test file does not grow, and room freed is not kept", () => {
  const dir = import.meta.dirname;
  const actual: Record<string, number> = {};
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".test.ts") && file !== "spawn-budget.test.ts")) {
    const sites = callSites(readFileSync(join(dir, name), "utf8"));
    if (sites > 0) actual[name] = sites;
  }
  expect(actual, "per-file spawn call sites; see the comment at the top of this file").toEqual(BUDGET);
});
