/**
 * Terminal status reporting for remote sessions: emits OSC 7501 Program Status sequences (understood by modern
 * terminals) and optionally notifies cmux when running inside a cmux workspace.
 */
import { spawn } from "node:child_process";
import { type ProgramStatus, formatProgramStatus } from "@earendil-works/pi-tui";
import { hostEnv } from "./host-env.ts";

export interface TerminalStatusOptions {
  write?: (sequence: string) => void;
  notifyCmux?: (state: ProgramStatus["state"], message?: string) => void;
  env?: NodeJS.ProcessEnv;
}

function defaultWrite(sequence: string): void {
  if (process.stdout.isTTY) process.stdout.write(sequence);
}

function isCmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SOCKET_PATH);
}

function defaultCmuxNotify(state: ProgramStatus["state"], message?: string): void {
  if (state !== "done" && state !== "error") return;
  const title = state === "error" ? "FastAgent error" : "FastAgent done";
  const body = message || (state === "error" ? "Remote run failed" : "Remote turn completed");
  try {
    const child = spawn("cmux", ["notify", "--title", title, "--body", body], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // cmux CLI may not be in PATH even when env vars are inherited.
  }
}

export class TerminalStatusReporter {
  private readonly write: (sequence: string) => void;
  private readonly notifyCmux: (state: ProgramStatus["state"], message?: string) => void;
  private readonly cmuxEnabled: boolean;
  private lastKey?: string | undefined;

  constructor(options: TerminalStatusOptions = {}) {
    const env = options.env ?? hostEnv();
    this.write = options.write ?? defaultWrite;
    this.cmuxEnabled = options.notifyCmux !== undefined || isCmuxEnv(env);
    this.notifyCmux = options.notifyCmux ?? defaultCmuxNotify;
  }

  report(state: ProgramStatus["state"], message?: string): void {
    const key = `${state}:${message ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.write(
      formatProgramStatus({
        state,
        app: "fastagent",
        ...(message ? { message } : {}),
      }),
    );
    if (this.cmuxEnabled && (state === "done" || state === "error")) {
      this.notifyCmux(state, message);
    }
  }

  clear(): void {
    this.report("clear");
    this.lastKey = undefined;
  }
}
