import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function readSlackOnboardingState(stateRoot: string): Promise<SlackOnboardingState | undefined> {
  const file = slackOnboardingStatePath(stateRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
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

/** Atomic replacement with owner-only permissions: this file carries a workspace-wide config refresh token. */
export async function writeSlackOnboardingState(stateRoot: string, state: SlackOnboardingState): Promise<void> {
  const file = slackOnboardingStatePath(stateRoot);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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
  await writeSlackOnboardingState(stateRoot, next);
  return { token: next.configToken, state: next };
}
