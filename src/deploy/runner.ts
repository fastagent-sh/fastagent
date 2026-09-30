/** The host-CLI dispatcher seam, shared by every `deploy <host> --run` driver (fly/run.ts, railway/run.ts). */
import { spawn } from "node:child_process";
import { log } from "../log.ts";

interface RunResult {
  code: number;
  /** Captured stdout (for `--json` queries); empty when the command streamed to the terminal. */
  stdout: string;
  /**
   * Captured stderr — ONLY when `captureStderr` was set (a caller that must CLASSIFY a failure, e.g. "not found" vs
   * "denied").
   */
  stderr?: string;
}

/**
 * Run `bin args`: `capture` collects stdout (for `--json` queries), else the command streams to the terminal
 * (create/deploy) and stdout is empty.
 */
export type CliRunner = (
  args: string[],
  opts?: { capture?: boolean; captureStderr?: boolean; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * A read-only host-CLI query (`… list --json`), reduced to the question the next step asks of it — or the gate for an
 * answer we cannot act on. A failed command and unreadable output both stop the run: read as "nothing there", either
 * one would send the next step to create what already exists.
 */
export async function readOutput<T>(
  run: CliRunner,
  bin: string,
  args: string[],
  read: (stdout: string) => T,
): Promise<{ value: T } | { gate: string }> {
  // The command as RUN, not a restatement of it.
  const cmd = `${bin} ${args.join(" ")}`;
  const result = await run(args, { capture: true });
  if (result.code !== 0) return { gate: `\`${cmd}\` failed — see the ${bin} output above; fix and re-run` };
  try {
    return { value: read(result.stdout) };
  } catch (error) {
    // The one place a parse failure is allowed to stop being an exception.
    return {
      gate:
        `\`${cmd}\` was unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
        `run it yourself and check the ${bin} CLI version; fix and re-run`,
    };
  }
}

/**
 * Production {@link CliRunner}: spawn `bin` in `cwd` (the workspace, so a build/upload context is the agent). stderr
 * is always inherited to the terminal.
 */
export function spawnRunner(bin: string, cwd: string): CliRunner {
  return (args, opts) =>
    new Promise((res) => {
      const child = spawn(bin, args, {
        cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        stdio: [
          opts?.input ? "pipe" : "inherit",
          opts?.capture ? "pipe" : "inherit",
          opts?.captureStderr ? "pipe" : "inherit",
        ],
      });
      let out = "";
      let err = "";
      let stdinError: Error | undefined;
      child.stdout?.on("data", (d) => (out += String(d)));
      child.stderr?.on("data", (d) => (err += String(d)));
      if (opts?.input) {
        // A host CLI that rejects before reading (bad auth, a refused command) closes stdin under us.
        child.stdin?.on("error", (error) => (stdinError ??= error));
        child.stdin?.end(opts.input);
      }
      child.on("close", (code) => {
        // A CLI that exits 0 having refused part of its stdin took TRUNCATED input.
        const truncated = stdinError !== undefined && (code ?? 1) === 0;
        if (truncated) {
          // `error`, not `warn`: this line is the ONLY evidence of the failure — the caller's gate says "see the
          // output above", and above it the host CLI printed success.
          log.error(`[fastagent] ${bin} exited 0 without reading all of its input — ${stdinError?.message}`);
        }
        res({ code: truncated ? 1 : (code ?? 1), stdout: out, stderr: opts?.captureStderr ? err : undefined });
      });
      child.on("error", () => res({ code: 127, stdout: "", stderr: opts?.captureStderr ? "" : undefined })); // ENOENT
    });
}

/**
 * The AWS CLI, as every command here runs it: with its pager off. Given a terminal, AWS CLI v2 pipes any output it
 * prints through `less`, so `deploy agentcore --run` stopped at `(END)` after `ecr create-repository` until someone
 * pressed `q`. ONE runner rather than a `--no-cli-pager` at each call: a call site that forgets is how that hang ships.
 */
export function awsRunner(cwd: string): CliRunner {
  const aws = spawnRunner("aws", cwd);
  return (args, opts) => aws(args, { ...opts, env: { ...opts?.env, AWS_PAGER: "" } });
}
