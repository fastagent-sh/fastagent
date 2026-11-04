/**
 * The agent's execution environment: pi-durable's local one, with the environment of every process it starts given
 * outright. Its own `inheritEnv` would add this process's whole environment to a command's, and the bash tool asks for
 * it on every call, so it is forced off here.
 */
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

type Exec = NodeExecutionEnv["exec"];

export class InstanceExecutionEnv extends NodeExecutionEnv {
  readonly #processEnv: Readonly<Record<string, string>>;

  constructor(options: { cwd: string; processEnv: Readonly<Record<string, string>> }) {
    super({ cwd: options.cwd });
    this.#processEnv = options.processEnv;
  }

  override exec(command: Parameters<Exec>[0], options: Parameters<Exec>[1], context: Context): ReturnType<Exec> {
    return super.exec(
      command,
      { ...options, inheritEnv: false, env: { ...this.#processEnv, ...options?.env } },
      context,
    );
  }
}
