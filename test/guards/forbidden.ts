/**
 * What a test tier forbids (AGENTS.md, "Tests"), installed by its setup file. A forbidden call throws where it
 * is made, and is also recorded and failed after the test: product code may catch the throw (`src/git.ts` reads a spawn
 * that fails as "no git"), and work a test leaves running can make the call after the test has ended.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterAll, afterEach } from "vitest";
import { CHILD_REFUSALS, refuseConnectionsOffTheMachine } from "./network-guard.ts";

const refused: string[] = [];

function refuse(what: string): Error {
  const where = (new Error().stack ?? "")
    .split("\n")
    .filter((line) => /\/(src|test)\//.test(line) && !line.includes("test/guards/forbidden.ts"))
    .slice(0, 3)
    .join("\n");
  const error = new Error(`${what}\n${where}`);
  refused.push(error.message);
  return error;
}

/** What was refused since the last test, here and in the child processes it started, cleared. */
export function takeRefused(): string[] {
  const file = process.env[CHILD_REFUSALS];
  if (file !== undefined && existsSync(file)) {
    for (const what of readFileSync(file, "utf8").split("\0").filter(Boolean))
      refused.push(`in a child process: ${what}`);
    rmSync(file, { force: true });
  }
  return refused.splice(0);
}

function failIfRefused(): void {
  const found = takeRefused();
  if (found.length === 0) return;
  throw new Error(`this test did what its tier forbids (AGENTS.md, "Tests"):\n\n${found.join("\n\n")}`);
}

afterEach(failIfRefused);
afterAll(failIfRefused);

/**
 * No connection leaves the machine: a test that needs a server serves one on loopback. The child processes a test starts
 * refuse the same through `child-network-guard.ts`, which `test/setup.ts` hands them in NODE_OPTIONS; what they refused is
 * written to `REFUSALS` and fails the test here.
 */
export function forbidNetwork(): void {
  refuseConnectionsOffTheMachine(refuse);
}

/** The test runs in this process: no child process, whoever starts it. */
export function forbidProcesses(): void {
  const prototype = (childProcess.ChildProcess as unknown as { prototype: { spawn: (options: unknown) => unknown } })
    .prototype;
  prototype.spawn = (options: unknown) => {
    const { file, args = [] } = options as { file?: string; args?: string[] };
    throw refuse(`a child process: ${[file, ...args.slice(1)].join(" ").slice(0, 200)}`);
  };
  for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
    (childProcess as Record<string, unknown>)[name] = (file: string) => {
      throw refuse(`a child process: ${String(file).slice(0, 200)} (${name})`);
    };
  }
  syncBuiltinESMExports();
}
