/**
 * Logging a deployment in on the deployment itself: `fastagent login --stdio` runs on the box through the host's own
 * owner-authenticated shell, and this terminal renders it (login-relay.ts). The box creates and keeps the credential,
 * so it is the only holder of its grant, and logging in again replaces it there. Nothing is copied from this machine.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { boxLoginCommand } from "../deploy/container.ts";
import type { DeployHost } from "../deploy/hosts.ts";
import type { ResolvedPlacement } from "../paths.ts";
import { relayLogin } from "./login-relay.ts";
import { terminalLoginIO } from "./shared.ts";

/** A running box's owner-authenticated shell, as the host's own CLI opens it. */
export interface BoxShell {
  /** The host CLI, run from the workspace. */
  bin: string;
  /** Its arguments to run `command` (one POSIX shell line) on the box with stdin and stdout attached, no TTY. */
  args(command: string): string[];
  /** Make sure a machine is running to open the shell on (a host that suspends idle machines). */
  wake?(): Promise<void>;
}

export interface BoxLoginRequest {
  host: DeployHost;
  shell: BoxShell;
  placement: ResolvedPlacement;
  /** Skip the provider menu. */
  provider?: string;
  /** Keep a credential the box already holds for `provider` (a redeploy), instead of replacing it. */
  ifMissing?: boolean;
  /** false: never ask; a box without the credential is a failure naming the command to run in a terminal. */
  input: boolean;
}

/**
 * Run the login on the box and report its outcome. Resolves `undefined` once the box reports a credential for the
 * provider (logged in now, or kept), else with the one line saying why not and what to run.
 */
export async function loginOnBox(request: BoxLoginRequest): Promise<string | undefined> {
  const { host, shell, placement, provider } = request;
  const retry = `fastagent login --deployment ${host}`;
  const args = [
    ...(provider ? [provider] : []),
    ...(request.ifMissing ? ["--if-missing"] : []),
    ...(request.input ? [] : ["--no-input"]),
  ];
  let command: string;
  try {
    command = boxLoginCommand(basename(placement.agentDir), args);
  } catch (error) {
    return (error as Error).message;
  }
  await shell.wake?.();
  const child = spawn(shell.bin, shell.args(command), {
    cwd: placement.workspace,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  const result = await relayLogin(child.stdout, child.stdin, terminalLoginIO(), (line) => console.error(line));
  const code = await exited;
  if (spawnError) return `could not run ${shell.bin}: ${spawnError.message}`;
  if (!result) {
    return (
      `the ${host} shell ended without a login result (exit ${code}) — nothing on the box says it is logged in. ` +
      `See the output above, then run \`${retry}\``
    );
  }
  if (result.ok) {
    console.error(
      result.stored
        ? `[fastagent] the deployment already holds its ${result.provider} credential (${result.method}, ${result.path}) — kept`
        : `[fastagent] logged in to ${result.provider} (${result.method}) on the deployment — saved to ${result.path} there`,
    );
    return undefined;
  }
  if (result.reason === "missing") return `not logged in: ${result.message} — run \`${retry}\` in a terminal`;
  if (result.reason === "cancelled") return `login on the deployment cancelled — run \`${retry}\` to log it in`;
  return `login on the deployment failed: ${result.message}`;
}
