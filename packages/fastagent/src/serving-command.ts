/**
 * Which command serves this process: `dev` marks it, and everything else (`start`, a deployed box, an embedder) is
 * the default. An agent's code reads it at import through the agent's OWN installed copy of this package, which shares
 * nothing with the CLI's copy but the process environment, so the mark lives there.
 */
import { readOptionalEnv, setProcessEnvVar } from "./process-env.ts";

export const DEV_SERVE_ENV = "FASTAGENT_DEV";

export function markDevServe(env?: NodeJS.ProcessEnv): void {
  if (env === undefined) setProcessEnvVar(DEV_SERVE_ENV, "1");
  else env[DEV_SERVE_ENV] = "1";
}

/** For a command that is never `dev` (`start`), run from a shell or a tool that a `dev` process spawned. */
export function unmarkDevServe(env?: NodeJS.ProcessEnv): void {
  if (env === undefined) setProcessEnvVar(DEV_SERVE_ENV, undefined);
  else delete env[DEV_SERVE_ENV];
}

export function servedByDev(env?: Readonly<Record<string, string | undefined>>): boolean {
  return readOptionalEnv(DEV_SERVE_ENV, env) === "1";
}

/**
 * Who runs an instance, as an open is told: `dev` serves it, or a deployed container (the generated image marks it)
 * runs it. The CLI reads its own process's variables for these (`runsAsIn`); an app's instance is none of them.
 */
export interface RunsAs {
  dev: boolean;
  deployed: boolean;
}

export const NOT_HOSTED: RunsAs = { dev: false, deployed: false };
