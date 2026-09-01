/**
 * Live probes fail loudly on missing configuration instead of skipping: `npm run test:live` is an
 * explicit opt-in, so an unset variable is a broken run, not an absent capability. (A platform that
 * is genuinely DOWN is a different case — that belongs in the probe that talks to it.)
 */
import { fastagentVersion } from "../../src/version.ts";
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`live probes need ${name} (${hint})`);
  return value;
}

/**
 * The published version under probe, read the same way by every probe: `FASTAGENT_LIVE_VERSION` when
 * it carries one — CI resolves the registry's current `latest` to an exact version ONCE and exports it
 * (.github/workflows/live.yml), so the registry install and the container image cannot report on two
 * artifacts — else this checkout's version, which is what a local run means.
 *
 * `||`, never `??`: an exported-but-empty variable is not a pin, and `??` would keep it. That installs
 * `@fastagent-sh/fastagent@` (npm resolves the empty range to `latest`) and then asserts the CLI
 * reports `""` — a probe that fails without ever naming the version it meant to check.
 */
export async function liveVersion(): Promise<string> {
  return process.env.FASTAGENT_LIVE_VERSION || (await fastagentVersion());
}
