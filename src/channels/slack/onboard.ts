import { setTimeout as sleep } from "node:timers/promises";
import { REGISTRATION_ATTEMPTS, REGISTRATION_RETRY_MS } from "../registration.ts";
import type { SlackOAuthResult } from "./config-api.ts";
import {
  createSlackApp,
  isSlackRequestUrlUnverified,
  SlackConfigApiError,
  updateSlackAppManifest,
} from "./config-api.ts";
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
   * granted omits `scopes`, and the caller then does not pretend to have checked them.
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
   *  created with no event subscription at all, and `dev`/`deploy` add it with the URL later. */
  requestUrl?: string;
  /** The one-shot OAuth callback. Its presence is what makes rotating bot tokens possible at all, so it
   *  also decides `token_rotation_enabled` — one fact, read in one place. */
  redirectUrl?: string;
}

/**
 * Repeat a manifest call while Slack reports it cannot VERIFY the request_url it carries. Slack
 * challenges that URL from its own network during the call — the readiness signal #421 is about — and
 * validates the whole manifest BEFORE acting on it, so a call that ends this way did nothing.
 * `onAttemptFailed` runs before the wait, which is how the create path keeps its duplicate-guard
 * marker on for exactly one in-flight call and off during the sleep. Any other failure propagates.
 */
async function retryWhileUnverified<T>(
  io: Pick<SlackOnboardIO, "note">,
  budget: { attempts: number; retryMs: number },
  call: () => Promise<T>,
  onAttemptFailed: () => void = () => {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isSlackRequestUrlUnverified(error) || attempt >= budget.attempts) throw error;
      onAttemptFailed();
      io.note(`Slack cannot reach the temporary setup URL yet (attempt ${attempt}/${budget.attempts}); retrying…`);
      await sleep(budget.retryMs);
    }
  }
}

/** Create/resume one internal Slack app and complete its workspace installation. */
export async function onboardSlackApp(
  input: SlackOnboardInput,
  io: SlackOnboardIO,
  deps: {
    createApp?: typeof createSlackApp;
    updateManifest?: typeof updateSlackAppManifest;
    /** Attempts absorbing the setup tunnel's warm-up before Slack can verify its URL. */
    attempts?: number;
    retryMs?: number;
  } = {},
): Promise<SlackOnboardingState> {
  let state = input.state;
  const current = await currentSlackConfigToken(input.stateRoot, state);
  state = current.state;
  const budget = { attempts: deps.attempts ?? REGISTRATION_ATTEMPTS, retryMs: deps.retryMs ?? REGISTRATION_RETRY_MS };

  // The KIND of app — rotating token (installed through an OAuth redirect) or static token (installed
  // from the console) — is decided ONCE, when the app is created, and Slack makes it permanent: rotation
  // cannot be disabled, and a static-token app has no redirect to rotate through. This run's MODE
  // (whether it holds a redirect URL) chooses the kind only at creation. On a resume it must MATCH the
  // record, because every later manifest is written whole and would otherwise convert the app in
  // silence — then disagree with the record on every Request-URL update after that.
  const rotating = input.redirectUrl !== undefined;
  if (state.appId) {
    const recorded = state.tokenRotation ?? true; // absent: predates the record; only the OAuth path existed
    if (recorded !== rotating) {
      throw new Error(
        recorded
          ? `Slack app ${state.appId} was created for an OAuth install (rotating token) — re-run \`fastagent add slack\` without --manual to resume it`
          : `Slack app ${state.appId} was created for a console install (static token) — re-run \`fastagent add slack --manual\` to resume it`,
      );
    }
  }
  const manifest = buildSlackManifest({
    name: state.appName,
    groupBehavior: state.groupBehavior,
    requestUrl: input.requestUrl,
    redirectUrl: input.redirectUrl,
    tokenRotation: rotating,
  });

  if (!state.appId) {
    if (state.createAttemptedAt) {
      throw new Error(
        `a Slack app creation request started at ${state.createAttemptedAt}, but no app ID was returned. ` +
          "Inspect https://api.slack.com/apps before retrying; if an app exists, delete that incomplete app first, then remove the local Slack onboarding state and re-run",
      );
    }
    io.note("Creating the internal Slack app from its FastAgent manifest…");
    const setMarker = (value: string | undefined): void => {
      state = { ...state, createAttemptedAt: value };
      writeSlackOnboardingState(input.stateRoot, state);
    };
    let created: Awaited<ReturnType<typeof createSlackApp>>;
    try {
      created = await retryWhileUnverified(
        io,
        budget,
        () => {
          // Record BEFORE the non-idempotent API call. A transport/internal failure may have created the
          // app; refusing a blind retry is safer than silently producing duplicates. The marker spans
          // exactly one in-flight call: an unverifiable URL created nothing, so it comes off again before
          // the wait — a Ctrl-C during that wait must not wedge the next run on an app that never existed.
          setMarker(new Date().toISOString());
          return (deps.createApp ?? createSlackApp)(current.token, manifest);
        },
        () => setMarker(undefined),
      );
    } catch (error) {
      const ambiguous =
        !(error instanceof SlackConfigApiError) ||
        ["fatal_error", "internal_error", "request_timeout", "service_unavailable", "failed_creating_app"].includes(
          error.code,
        );
      if (!ambiguous) setMarker(undefined);
      throw error;
    }
    state = {
      ...state,
      appId: created.appId,
      createAttemptedAt: undefined,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      signingSecret: created.signingSecret,
      tokenRotation: rotating,
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
    const appId = state.appId;
    io.note(`Resuming Slack app ${appId}; refreshing its temporary setup URLs…`);
    await retryWhileUnverified(io, budget, () =>
      (deps.updateManifest ?? updateSlackAppManifest)(current.token, appId, manifest),
    );
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
  // Two checks an installer may be unable to answer (a console install has only what `auth.test`
  // returns). An unanswered check is SKIPPED and said so — never passed by substituting the expected
  // value, which would make "a different app's token was pasted" indistinguishable from success.
  if (oauth.appId === undefined) {
    io.note("Slack did not report which app this token belongs to; make sure it is the one just created.");
  } else if (oauth.appId !== state.appId) {
    throw new Error("Slack installed a different app than the manifest app");
  }
  const granted = oauth.scopes;
  if (granted === undefined) {
    io.note(
      "Slack did not report which scopes were granted; the app was installed with the ones its manifest asks for.",
    );
  } else if (scopes.some((scope) => !granted.includes(scope))) {
    throw new Error("Slack install completed without all required bot scopes; re-run fastagent add slack to reinstall");
  }
  // The client credentials have ONE runtime use: rotating the bot token. bot-auth.ts reads the four
  // rotation fields as all-or-nothing, so writing them next to a static token (the --manual install)
  // does not make it rotate — it makes the channel refuse to start.
  await io.writeRuntimeSecrets({
    botToken: oauth.botToken,
    ...(rotating
      ? {
          botRefreshToken: oauth.botRefreshToken,
          botTokenExpiresAt: oauth.botTokenExpiresAt,
          clientId: state.clientId,
          clientSecret: state.clientSecret,
        }
      : {}),
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
