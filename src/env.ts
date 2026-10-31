import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { installProxyFetch } from "./proxy.ts";
import { dotEnvPath, loadEnvValues, parseEnvContent } from "./value-file.ts";

/**
 * Write parsed values into `process.env`, matching Node's `--env-file` / `process.loadEnvFile` precedence on BOTH
 * axes (verified against Node in test/env.test.ts): a real env var wins over the file, and within the file the last
 * occurrence wins ({@link parseEnvContent}).
 */
export function applyEnvValues(values: ReadonlyMap<string, string>): void {
  for (const [key, value] of values) if (!(key in process.env)) process.env[key] = value;
}

/**
 * ENTER an agent directory's runtime environment: its `.env` becomes `process.env`, and this process's outbound fetch
 * follows whatever proxy that (or the ambient environment) declares.
 *
 * ONE function because the two steps are one fact in a fixed order — the proxy can be declared in the `.env`, so it
 * has to be read first, and `installProxyFetch` reads the environment at construction. A command that did only half
 * would send an authored tool, a channel's app-creation flow, or a skill download DIRECT on a machine that has no
 * direct route. Whether a given request then uses the proxy is the dispatcher's decision, not the
 * caller's — see {@link installProxyFetch} on loopback.
 */
export function enterAgentEnv(agentDir: string): void {
  loadDotEnv(agentDir);
  installProxyFetch();
}

/**
 * Load the agent's `.env` ({@link dotEnvPath}) into `process.env` ({@link applyEnvValues}), treating a MISSING file as
 * normal (no .env). Commands want {@link enterAgentEnv}, which is this plus the proxy that `.env` may declare.
 */
export function loadDotEnv(agentDir: string): void {
  const path = dotEnvPath(agentDir);
  applyEnvValues(loadEnvValues(path)); // ONE definition of "a missing value file is normal" (loadEnvValues)
  // A `.env` at the agent's root is the file habit puts there, and nothing reads it.
  const stray = join(agentDir, ".env");
  if (stray === path || !existsSync(stray)) return;
  const misplaced = [...parseEnvContent(readFileSync(stray, "utf8")).keys()];
  if (misplaced.length > 0) {
    log.warn(
      `[fastagent] ${stray} is NOT read — it sets ${misplaced.join(", ")}, and this agent's env lives at ` +
        `${path}; move those values there`,
    );
  }
}
