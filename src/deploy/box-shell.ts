/**
 * A running box's owner-authenticated shell, as a byte channel: what `fastagent login --deployment` speaks through.
 * Host-neutral: Docker, Fly and Railway open it by running their own CLI (`processShell`); AgentCore opens a
 * WebSocket (`agentcore/shell.ts`). Whoever opens one only writes bytes in and reads bytes out.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** One open session on the box, running one command. */
export interface BoxChannel {
  /** What the command writes to its stdout. Ends when the session does. */
  output: Readable;
  /** The command's stdin. */
  input: Writable;
  /** How the session ended, or why it never opened. */
  closed: Promise<{ opened: true; how: string } | { opened: false; error: string }>;
}

export interface BoxShell {
  /** Run `command` (one POSIX shell line) on the box. Its stderr goes to this process's stderr. */
  open(command: string): Promise<BoxChannel>;
  /** Make sure there is a running machine to open the shell on (a host that suspends idle machines). */
  wake?(): Promise<void>;
  /**
   * The box's storage root, for a shell that does not carry the server's environment (AgentCore's). Unset: the
   * shell sees `FASTAGENT_STORAGE_DIR` as the server does, or the image's default.
   */
  storage?: string;
}

/** A host CLI that runs a command on the box itself: `bin ...args(command)`, run from `cwd`. */
export function processShell(bin: string, args: (command: string) => string[], cwd: string): BoxShell {
  return {
    async open(command) {
      const child = spawn(bin, args(command), { cwd, stdio: ["pipe", "pipe", "inherit"] });
      // The box may exit before reading an answer; its result (or its absence) is what gets reported, not the EPIPE.
      child.stdin.on("error", () => {});
      const closed = new Promise<Awaited<BoxChannel["closed"]>>((resolve) => {
        child.on("error", (error) => resolve({ opened: false, error: `could not run ${bin}: ${error.message}` }));
        child.on("close", (code, signal) =>
          resolve({ opened: true, how: signal ? `signal ${signal}` : `exit ${code}` }),
        );
      });
      return { output: child.stdout, input: child.stdin, closed };
    },
  };
}

/**
 * The command that logs a deployment in, as every message and runbook names it: with the provider when it is known,
 * because the model needs THAT one, and a menu invites another.
 */
export function deploymentLoginCommand(host: string, provider?: string): string {
  return `fastagent login ${provider ? `${provider} ` : ""}--deployment ${host}`;
}

/**
 * The login a host driver runs on the box it just deployed, before any webhook points at it. `run` resolves a gate line,
 * or undefined once the box authenticates; `command` is how a person runs the same login, for the manual route.
 * ONE value, so a driver cannot have the step without its command.
 */
export interface BoxLoginStep<Args extends unknown[] = []> {
  command: string;
  run: (...args: Args) => Promise<string | undefined>;
}
