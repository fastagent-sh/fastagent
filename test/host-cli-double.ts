/**
 * `src/deploy/runner.ts` for a unit test whose subject is what a command asks of a host CLI (fly, railway, aws, docker)
 * and does with the answer, not the process: each CLI is a function the test registers with `hostCli`, and a CLI no test
 * registered is not installed (exit 127), as `spawnRunner` reports one that cannot start. What a CLI prints to a stream
 * the command does not capture goes to this process's stdout or stderr, where a spawned CLI's would have gone. Installed
 * with `vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"))`; host-cli-double.integration.test.ts
 * checks it against `spawnRunner` with a real process.
 */
import { vi } from "vitest";
import type { CliRunner } from "../src/deploy/runner.ts";

type Runner = typeof import("../src/deploy/runner.ts");
const real = await vi.importActual<Runner>("../src/deploy/runner.ts");

export type { CliRunner };
export const readOutput = real.readOutput;

/** One call of a host CLI: its arguments, its standard input, the environment and directory it ran in. */
export interface HostCliCall {
  args: string[];
  input?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** What a host CLI answers a call: its exit code (0 when left out) and what it printed. */
export interface HostCliAnswer {
  code?: number;
  stdout?: string;
  stderr?: string;
}

const clis = new Map<string, (call: HostCliCall) => HostCliAnswer | Promise<HostCliAnswer>>();

/** Install `bin` on the double's machine, answering each call with `answer`. */
export function hostCli(bin: string, answer: (call: HostCliCall) => HostCliAnswer | Promise<HostCliAnswer>): void {
  clis.set(bin, answer);
}

/** Uninstall every CLI a test installed. */
export function resetHostClis(): void {
  clis.clear();
}

/** Install `bin` and record every call in order. */
export function recordHostCli(
  bin: string,
  answer: (call: HostCliCall) => HostCliAnswer | Promise<HostCliAnswer> = () => ({}),
): { calls: HostCliCall[]; cmds: () => string[] } {
  const calls: HostCliCall[] = [];
  hostCli(bin, (call) => {
    calls.push(call);
    return answer(call);
  });
  return { calls, cmds: () => calls.map((call) => call.args.join(" ")) };
}

export function spawnRunner(bin: string, cwd: string, options: { stdoutToStderr?: boolean } = {}): CliRunner {
  return async (args, opts) => {
    const answer = clis.get(bin);
    if (answer === undefined) return { code: 127, stdout: "", stderr: opts?.captureStderr ? "" : undefined };
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const said = await answer({ args, env, cwd, ...(opts?.input ? { input: opts.input } : {}) });
    const stdout = said.stdout ?? "";
    const stderr = said.stderr ?? "";
    if (!opts?.capture && stdout !== "") (options.stdoutToStderr ? process.stderr : process.stdout).write(stdout);
    if (!opts?.captureStderr && stderr !== "") process.stderr.write(stderr);
    return {
      code: said.code ?? 0,
      stdout: opts?.capture ? stdout : "",
      stderr: opts?.captureStderr ? stderr : undefined,
    };
  };
}

/** As `awsRunner` is: the AWS CLI through `spawnRunner`, its pager off. */
export function awsRunner(cwd: string): CliRunner {
  const aws = spawnRunner("aws", cwd);
  return (args, opts) => aws(args, { ...opts, env: { ...opts?.env, AWS_PAGER: "" } });
}
