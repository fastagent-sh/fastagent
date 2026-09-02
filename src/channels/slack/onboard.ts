import type { SlackOAuthResult } from "./config-api.ts";
import { createSlackApp, SlackConfigApiError, updateSlackAppManifest } from "./config-api.ts";
import { buildSlackManifest, slackBotScopes, type SlackGroupBehavior } from "./manifest.ts";
import { currentSlackConfigToken, type SlackOnboardingState, writeSlackOnboardingState } from "./onboarding-state.ts";

export interface SlackOnboardIO {
  note(message: string): void;
  /**
   * Install the created app into its workspace and return the runtime bot credentials.
   *
   * THE ONE STEP that differs between how an app gets installed, and therefore the only thing the two
   * `add slack` modes implement differently: the automatic one redirects a browser through a temporary
   * tunnel and exchanges the code, the `--manual` one has the operator install from Slack's console and
   * paste the token back. Everything around it — the manifest, app creation, what lands in state and in
   * `.env` — is this function's caller, once. An implementation that cannot report which scopes were
   * granted returns `scopes: []`, and the caller then does not pretend to have checked them.
   */
  install(app: { appId: string; clientId: string; clientSecret: string; scopes: string[] }): Promise<SlackOAuthResult>;
  /** Stage runtime-only credentials into the gitignored .env. */
  writeRuntimeSecrets(values: {
    botToken?: string;
    botRefreshToken?: string;
    botTokenExpiresAt?: number;
    clientId?: string;
    clientSecret?: string;
    signingSecret?: string;
  }): Promise<void>;
}

export interface SlackOnboardInput {
  stateRoot: string;
  state: SlackOnboardingState;
  /** Where events will arrive, when that is already known. `--manual` has no public URL yet: the app is
   *  created subscribed to its events with no `request_url`, and `dev`/`deploy` fill it in later. */
  requestUrl?: string;
  /** The one-shot OAuth callback. Its presence is what makes rotating bot tokens possible at all, so it
   *  also decides `token_rotation_enabled` — one fact, read in one place. */
  redirectUrl?: string;
}

/** Create/resume one internal Slack app and complete its workspace installation. */
export async function onboardSlackApp(
  input: SlackOnboardInput,
  io: SlackOnboardIO,
  deps: {
    createApp?: typeof createSlackApp;
    updateManifest?: typeof updateSlackAppManifest;
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
    tokenRotation: input.redirectUrl !== undefined,
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
    // refusing a blind retry is safer than silently producing duplicates. The marker spans exactly one
    // in-flight call — anything that widens that window turns a Ctrl-C into a wedged next run.
    state = { ...state, createAttemptedAt: new Date().toISOString() };
    writeSlackOnboardingState(input.stateRoot, state);
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
        writeSlackOnboardingState(input.stateRoot, state);
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
    writeSlackOnboardingState(input.stateRoot, state);
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
    writeSlackOnboardingState(input.stateRoot, state);
  }
  if (!state.appId || !state.clientId || !state.clientSecret) {
    throw new Error("Slack onboarding state lost app OAuth credentials before installation");
  }

  const scopes = slackBotScopes(state.groupBehavior);
  const oauth = await io.install({
    appId: state.appId,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    scopes,
  });
  if (oauth.appId !== state.appId) throw new Error("Slack installed a different app than the manifest app");
  // An install that reports no scopes could not observe them (a console install answers with the
  // token's identity, not its grant). Saying nothing beats asserting a check that did not happen.
  if (oauth.scopes.length > 0 && scopes.some((scope) => !oauth.scopes.includes(scope))) {
    throw new Error("Slack install completed without all required bot scopes; re-run fastagent add slack to reinstall");
  }
  await io.writeRuntimeSecrets({
    botToken: oauth.botToken,
    botRefreshToken: oauth.botRefreshToken,
    botTokenExpiresAt: oauth.botTokenExpiresAt,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
  });
  state = {
    ...state,
    clientSecret: undefined,
    teamId: oauth.teamId,
    teamName: oauth.teamName,
    installedAt: new Date().toISOString(),
  };
  writeSlackOnboardingState(input.stateRoot, state);
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
