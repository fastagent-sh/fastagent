import { randomBytes } from "node:crypto";
import { createSlackApp, exchangeSlackOAuthCode, SlackConfigApiError, updateSlackAppManifest } from "./config-api.ts";
import { buildSlackManifest, slackBotScopes, type SlackGroupBehavior } from "./manifest.ts";
import { currentSlackConfigToken, type SlackOnboardingState, writeSlackOnboardingState } from "./onboarding-state.ts";

export interface SlackOnboardIO {
  note(message: string): void;
  openUrl(url: string): void;
  /** Wait for the one OAuth redirect. Implementations must validate only the path; core validates state. */
  waitForOAuth(): Promise<{ code?: string; state?: string; error?: string }>;
  /** Stage runtime-only credentials into the gitignored .env. */
  writeRuntimeSecrets(values: { botToken?: string; signingSecret?: string }): Promise<void>;
}

export interface SlackOnboardInput {
  stateRoot: string;
  state: SlackOnboardingState;
  requestUrl: string;
  redirectUrl: string;
}

/** Create/resume one internal Slack app and complete its workspace OAuth installation. */
export async function onboardSlackApp(
  input: SlackOnboardInput,
  io: SlackOnboardIO,
  deps: {
    createApp?: typeof createSlackApp;
    updateManifest?: typeof updateSlackAppManifest;
    exchangeCode?: typeof exchangeSlackOAuthCode;
  } = {},
): Promise<SlackOnboardingState> {
  let state = input.state;
  const current = await currentSlackConfigToken(input.stateRoot, state);
  state = current.state;
  const manifest = buildSlackManifest({
    name: state.appName,
    groupBehavior: state.groupBehavior,
    requestUrl: input.requestUrl,
    redirectUrl: input.redirectUrl,
  });

  if (!state.appId) {
    if (state.createAttemptedAt) {
      throw new Error(
        `a Slack app creation request started at ${state.createAttemptedAt}, but no app ID was returned. ` +
          "Inspect https://api.slack.com/apps before retrying; if an app exists, delete that incomplete app first, then remove the local Slack onboarding state and re-run",
      );
    }
    io.note("Creating the internal Slack app from its FastAgent manifest…");
    // Record BEFORE the non-idempotent API call. A transport/internal failure may have created the app;
    // refusing a blind retry is safer than silently producing duplicates.
    state = { ...state, createAttemptedAt: new Date().toISOString() };
    await writeSlackOnboardingState(input.stateRoot, state);
    let created: Awaited<ReturnType<typeof createSlackApp>>;
    try {
      created = await (deps.createApp ?? createSlackApp)(current.token, manifest);
    } catch (error) {
      const ambiguous =
        !(error instanceof SlackConfigApiError) ||
        ["fatal_error", "internal_error", "request_timeout", "service_unavailable", "failed_creating_app"].includes(
          error.code,
        );
      if (!ambiguous) {
        state = { ...state, createAttemptedAt: undefined };
        await writeSlackOnboardingState(input.stateRoot, state);
      }
      throw error;
    }
    state = {
      ...state,
      appId: created.appId,
      createAttemptedAt: undefined,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      signingSecret: created.signingSecret,
    };
    // Irreversible boundary first: a cancellation or .env write failure can resume without creating a duplicate.
    await writeSlackOnboardingState(input.stateRoot, state);
    io.note(`Created Slack app ${created.appId}; credentials captured locally.`);
  } else {
    if (!state.clientId || !state.clientSecret) {
      throw new Error(
        `Slack app ${state.appId} exists but OAuth client credentials are no longer available — ` +
          "the app appears already installed; set SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET in .env or remove the app and onboarding state to start over",
      );
    }
    io.note(`Resuming Slack app ${state.appId}; refreshing its temporary setup URLs…`);
    await (deps.updateManifest ?? updateSlackAppManifest)(current.token, state.appId, manifest);
  }

  if (state.signingSecret) {
    await io.writeRuntimeSecrets({ signingSecret: state.signingSecret });
    state = { ...state, signingSecret: undefined };
    await writeSlackOnboardingState(input.stateRoot, state);
  }
  if (!state.appId || !state.clientId || !state.clientSecret) {
    throw new Error("Slack onboarding state lost app OAuth credentials before installation");
  }

  const oauthState = randomBytes(24).toString("hex");
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", state.clientId);
  authorize.searchParams.set("scope", slackBotScopes(state.groupBehavior).join(","));
  authorize.searchParams.set("redirect_uri", input.redirectUrl);
  authorize.searchParams.set("state", oauthState);
  io.note(`Approve the internal app installation in Slack: ${authorize}`);
  io.openUrl(authorize.toString());

  const callback = await io.waitForOAuth();
  if (callback.error) throw new Error("Slack OAuth installation was not approved");
  if (!callback.code) throw new Error("Slack OAuth callback carried no authorization code");
  if (!callback.state || callback.state !== oauthState) throw new Error("Slack OAuth callback state mismatch");

  const oauth = await (deps.exchangeCode ?? exchangeSlackOAuthCode)({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    code: callback.code,
    redirectUrl: input.redirectUrl,
  });
  if (oauth.appId !== state.appId) throw new Error("Slack OAuth installed a different app than the manifest app");
  if (slackBotScopes(state.groupBehavior).some((scope) => !oauth.scopes.includes(scope))) {
    throw new Error("Slack OAuth completed without all required bot scopes; re-run fastagent add slack to reinstall");
  }
  await io.writeRuntimeSecrets({ botToken: oauth.botToken });
  state = {
    ...state,
    clientSecret: undefined,
    teamId: oauth.teamId,
    teamName: oauth.teamName,
    installedAt: new Date().toISOString(),
  };
  await writeSlackOnboardingState(input.stateRoot, state);
  return state;
}

export function newSlackOnboardingState(input: {
  appName: string;
  groupBehavior: SlackGroupBehavior;
  configToken: string;
  configRefreshToken: string;
  now?: number;
}): SlackOnboardingState {
  return {
    version: 1,
    appName: input.appName,
    groupBehavior: input.groupBehavior,
    configToken: input.configToken,
    configRefreshToken: input.configRefreshToken,
    // Slack config access tokens expire in 12 hours; use 11h so registration rotates before the edge.
    configTokenExpiresAt: (input.now ?? Date.now()) + 11 * 60 * 60_000,
  };
}
