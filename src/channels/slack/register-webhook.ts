import { retryWhile, type RegistrationOutcome } from "../registration.ts";
import { isSlackRequestUrlUnverified, updateSlackAppManifest } from "./config-api.ts";
import { buildSlackManifest } from "./manifest.ts";
import { currentSlackConfigToken, readSlackOnboardingState } from "./onboarding-state.ts";

export interface RegisterSlackWebhookOptions {
  stateRoot: string;
  log?: (message: string) => void;
  attempts?: number;
  retryMs?: number;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Update one onboarded internal Slack app without sending its configuration credential to the host. */
export async function registerSlackWebhook(
  baseUrl: string,
  options: RegisterSlackWebhookOptions,
): Promise<RegistrationOutcome> {
  const note = options.log ?? ((message: string) => console.error(message));
  const publicBaseUrl = baseUrl.replace(/\/$/, "");
  let state: ReturnType<typeof readSlackOnboardingState>;
  try {
    state = readSlackOnboardingState(options.stateRoot);
  } catch (error) {
    note(`[fastagent] slack: cannot read local onboarding state: ${String(error)}`);
    return "failed";
  }
  if (!state?.appId || !state.installedAt) {
    note(
      `[fastagent] slack: no completed local onboarding state on this machine — the config credential lives only where \`fastagent add slack\` ran. ` +
        `Set Event Subscriptions → Request URL = ${publicBaseUrl}/slack manually in the Slack console, or re-run this command from the onboarding machine ` +
        `(repair its expired/revoked tokens with \`fastagent add slack --replace-config\`)`,
    );
    return "manual";
  }
  const consoleFallback = `set ${publicBaseUrl}/slack as the Event Subscriptions Request URL in the Slack console`;
  let current: Awaited<ReturnType<typeof currentSlackConfigToken>>;
  try {
    // Rotation is not retried with the manifest below: each rotate invalidates the previous pair, so a
    // repeat would spend tokens on a failure that is about the URL, not about the credential.
    current = await currentSlackConfigToken(options.stateRoot, state, {
      apiBaseUrl: options.apiBaseUrl,
      fetch: options.fetch,
    });
  } catch (error) {
    note(
      `[fastagent] slack: could not refresh the App Configuration token: ${String(error)} — ` +
        `re-run \`fastagent add slack --replace-config\` to repair it, or ${consoleFallback}`,
    );
    return "failed";
  }

  // Slack verifies the new request_url with a challenge DURING apps.manifest.update, from Slack's own
  // network — that verdict IS the readiness signal, so it is retried while a fresh tunnel/container
  // warms up. No local `/health` poll precedes it: this machine's reach is the wrong question (#421).
  try {
    await retryWhile(
      () =>
        updateSlackAppManifest(
          current.token,
          current.state.appId as string,
          buildSlackManifest({
            name: current.state.appName,
            groupBehavior: current.state.groupBehavior,
            requestUrl: `${publicBaseUrl}/slack`,
            // Every manifest update is a full replacement, so the OAuth redirect URL the install used
            // stays declared; a reinstall replaces this placeholder with its one-shot local setup callback.
            redirectUrl: `${publicBaseUrl}/slack/oauth/callback`,
          }),
          { apiBaseUrl: options.apiBaseUrl, fetch: options.fetch },
        ),
      isSlackRequestUrlUnverified,
      {
        attempts: options.attempts,
        retryMs: options.retryMs,
        onRetry: ({ attempt, attempts }) =>
          note(
            `[fastagent] slack: Slack cannot verify ${publicBaseUrl}/slack yet (attempt ${attempt}/${attempts}); retrying…`,
          ),
      },
    );
    note(`[fastagent] slack: Event Subscriptions Request URL registered → ${publicBaseUrl}/slack`);
    return "registered";
  } catch (error) {
    note(
      isSlackRequestUrlUnverified(error)
        ? `[fastagent] slack: Slack could not verify ${publicBaseUrl}/slack after retries (last error: ${String(error)}) — ` +
            `once the app is up, ${consoleFallback}`
        : `[fastagent] slack: automatic Request URL registration failed: ${String(error)} — ` +
            `re-run \`fastagent add slack --replace-config\` to repair the configuration tokens, or ${consoleFallback}`,
    );
    return "failed";
  }
}
