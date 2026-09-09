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
