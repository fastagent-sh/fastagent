/**
 * Which command serves this process: `dev` marks it, and everything else (`start`, a deployed box, an embedder) is
 * the default. A channel file reads it at import through the agent's OWN installed copy of this package, which shares
 * nothing with the CLI's copy but the process environment, so the mark lives there.
 */
export const DEV_SERVE_ENV = "FASTAGENT_DEV";

export function markDevServe(env: NodeJS.ProcessEnv = process.env): void {
  env[DEV_SERVE_ENV] = "1";
}

export function servedByDev(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEV_SERVE_ENV] === "1";
}
