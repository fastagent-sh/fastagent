import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { rotateSlackConfigToken } from "./config-api.ts";
import type { SlackGroupBehavior } from "./manifest.ts";

export interface SlackOnboardingState {
  version: 1;
  appName: string;
  groupBehavior: SlackGroupBehavior;
  appId?: string;
  /** Set before apps.manifest.create; without an appId it blocks blind duplicate-creation retries. */
  createAttemptedAt?: string;
  clientId?: string;
  /** Kept only while OAuth installation is unfinished, then deleted. */
  clientSecret?: string;
  /** Kept only until it has been staged into .env, then deleted. */
  signingSecret?: string;
  configToken: string;
  configRefreshToken: string;
  configTokenExpiresAt: number;
  teamId?: string;
  teamName?: string;
  installedAt?: string;
}

function slackOnboardingStatePath(stateRoot: string): string {
  return join(stateRoot, "channels", "slack", "onboarding.json");
}

function validState(value: unknown): value is SlackOnboardingState {
  const state = value as Partial<SlackOnboardingState>;
  return (
    typeof state === "object" &&
    state !== null &&
    state.version === 1 &&
    typeof state.appName === "string" &&
    (state.groupBehavior === "context" || state.groupBehavior === "mentions") &&
    typeof state.configToken === "string" &&
    typeof state.configRefreshToken === "string" &&
    typeof state.configTokenExpiresAt === "number"
  );
}

export function readSlackOnboardingState(stateRoot: string): SlackOnboardingState | undefined {
  const file = slackOnboardingStatePath(stateRoot);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read Slack onboarding state ${file}: ${(error as Error).message}`);
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!validState(value)) throw new Error("unexpected shape/version");
    return value;
  } catch (error) {
    throw new Error(`invalid Slack onboarding state ${file}: ${(error as Error).message}`);
  }
}

/** Atomic replacement with owner-only permissions: this file carries a workspace-wide config refresh
 *  token. Synchronous, through the shared writer, like every other piece of state this repo keeps
 *  (kit/state.ts): the file is ~1 KB and its writers are `fastagent add slack` and one config-token
 *  rotation at tunnel startup, so the async spelling bought nothing and cost a fifth set of temp-name
 *  and permission rules to keep true. */
export function writeSlackOnboardingState(stateRoot: string, state: SlackOnboardingState): void {
  writeFileAtomic(slackOnboardingStatePath(stateRoot), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function currentSlackConfigToken(
  stateRoot: string,
  state: SlackOnboardingState,
  options: { now?: number; apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<{ token: string; state: SlackOnboardingState }> {
  const now = options.now ?? Date.now();
  if (state.configTokenExpiresAt > now + 5 * 60_000) return { token: state.configToken, state };
  const rotated = await rotateSlackConfigToken(state.configRefreshToken, options);
  const next: SlackOnboardingState = {
    ...state,
    configToken: rotated.token,
    configRefreshToken: rotated.refreshToken,
    configTokenExpiresAt: rotated.expiresAt,
    teamId: state.teamId ?? rotated.teamId,
  };
  writeSlackOnboardingState(stateRoot, next);
  return { token: next.configToken, state: next };
}
