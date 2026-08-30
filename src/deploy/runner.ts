/**
 * The host-CLI dispatcher seam, shared by every `deploy <host> --run` driver (fly/run.ts, railway/run.ts).
 * WHAT it does — run a CLI, optionally capture stdout or feed stdin — is identical across hosts; only the
 * binary and the command sequence differ. Tests inject a fake recorder; production spawns the real CLI.
 */
import { spawn } from "node:child_process";
import { log } from "../log.ts";

interface RunResult {
  code: number;
  /** Captured stdout (for `--json` queries); empty when the command streamed to the terminal. */
  stdout: string;
  /** Captured stderr — ONLY when `captureStderr` was set (a caller that must CLASSIFY a failure, e.g.
   *  "not found" vs "denied"); otherwise undefined and stderr streams to the terminal as always. */
  stderr?: string;
}

/** Run `bin args`: `capture` collects stdout (for `--json` queries), else the command streams to the
 *  terminal (create/deploy) and stdout is empty; `input` is fed to stdin (secrets over stdin, never argv).
 *  `env` adds child-only environment values — Docker Compose interpolates secrets from it without putting
 *  values in argv or mutating the long-lived CLI process. */
export type CliRunner = (
  args: string[],
  opts?: { capture?: boolean; captureStderr?: boolean; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * Production {@link CliRunner}: spawn `bin` in `cwd` (the workspace, so a build/upload context is the
 * agent). stderr is always inherited to the terminal; stdout is inherited unless `capture`. A spawn
 * ENOENT (the CLI not on PATH) resolves to code 127 so the caller can gate with an install hint.
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
        // A host CLI that rejects before reading (bad auth, a refused command) closes stdin under us:
        // the write then emits `error` on a stream with no listener, which Node turns into an uncaught
        // exception — crashing the deploy and losing the gate message the exit code was about to carry.
        // HELD, not dropped: the exit code says it only when the CLI exits non-zero (see below).
        child.stdin?.on("error", (error) => (stdinError ??= error));
        child.stdin?.end(opts.input);
      }
      child.on("close", (code) => {
        // A CLI that exits 0 having refused part of its stdin took TRUNCATED input — an auth seed runs
        // well past the 64KB pipe buffer, so "success" here would deploy a half-written secret and say
        // nothing. The exit code is what callers read, so the failure has to reach them as one.
        const truncated = stdinError !== undefined && (code ?? 1) === 0;
        if (truncated) {
          // `error`, not `warn`: this line is the ONLY evidence of the failure — the caller's gate says
          // "see the output above", and above it the host CLI printed success. A log level that mutes
          // it (CI often sets `error`) leaves a stopped deploy with no diagnosable cause.
          log.error(`[fastagent] ${bin} exited 0 without reading all of its input — ${stdinError?.message}`);
        }
        res({ code: truncated ? 1 : (code ?? 1), stdout: out, stderr: opts?.captureStderr ? err : undefined });
      });
      child.on("error", () => res({ code: 127, stdout: "", stderr: opts?.captureStderr ? "" : undefined })); // ENOENT
    });
}
