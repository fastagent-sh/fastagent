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
 * The published version under probe: the workflow's input when it carries one, else this checkout's
 * (after a release, the version just published). Read HERE rather than per probe, because the
 * registry install and the container image must resolve the same one — a dispatch that pins a version
 * for one of them and not the other would report on two different artifacts.
 *
 * `||`, never `??`: an optional `workflow_dispatch` input left blank — and EVERY `schedule` run —
 * arrives as an empty string, which `??` would keep. That installs `@fastagent-sh/fastagent@` (npm
 * resolves the empty range to `latest`) and then asserts the CLI reports `""`, so the nightly path
 * would fail every night while never once probing this checkout.
 */
export async function liveVersion(): Promise<string> {
  return process.env.FASTAGENT_LIVE_VERSION || (await fastagentVersion());
}
