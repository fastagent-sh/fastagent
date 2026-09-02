import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { dotEnvPath, parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { installProxyFetch } from "../proxy.ts";
import { appendChannelDotEnv } from "../scaffold/add-channel.ts";
import type { GroupBehaviorChoice } from "../scaffold/add-channel.ts";
import { exchangeSlackOAuthCode, slackAuthTest } from "../channels/slack/config-api.ts";
import type { SlackOnboardIO } from "../channels/slack/onboard.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../channels/slack/onboard.ts";
import { readSlackOnboardingState, writeSlackOnboardingState } from "../channels/slack/onboarding-state.ts";
import { startSlackSetupServer } from "../channels/slack/setup-server.ts";
import { startCloudflareTunnel } from "../tunnel.ts";

const CONFIG_TOKEN_URL = "https://api.slack.com/apps";

async function promptValue(message: string, hidden = false, initialValue?: string): Promise<string> {
  const result = hidden ? await password({ message }) : await clackText({ message, initialValue });
  if (isCancel(result)) throw new Error("Slack onboarding cancelled");
  const value = String(result).trim();
  if (!value) throw new Error(`${message}: value is required`);
  return value;
}

/** Stage whatever an install produced into the agent's `.env`. Shared by both install modes: which
 *  credentials exist differs (a console install issues no rotation pair), what happens to them does not. */
function writeRuntimeSecrets(target: string): SlackOnboardIO["writeRuntimeSecrets"] {
  return async ({ botToken, botRefreshToken, botTokenExpiresAt, clientId, clientSecret, signingSecret }) => {
    const values = {
      ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
      ...(botRefreshToken ? { SLACK_BOT_REFRESH_TOKEN: botRefreshToken } : {}),
      ...(botTokenExpiresAt ? { SLACK_BOT_TOKEN_EXPIRES_AT: String(botTokenExpiresAt) } : {}),
      ...(clientId ? { SLACK_CLIENT_ID: clientId } : {}),
      ...(clientSecret ? { SLACK_CLIENT_SECRET: clientSecret } : {}),
      ...(signingSecret ? { SLACK_SIGNING_SECRET: signingSecret } : {}),
    };
    if (Object.keys(values).length > 0) {
      await appendChannelDotEnv(target, "slack", values, Object.keys(values));
    }
  };
}

/** Install by redirecting a browser through the temporary tunnel and exchanging the code it carries. */
export function installViaOAuth(
  redirectUrl: string,
  waitForOAuth: () => Promise<{ code?: string; state?: string; error?: string }>,
): SlackOnboardIO["install"] {
  return async ({ clientId, clientSecret, scopes }) => {
    // The CSRF nonce is meaningful only for a redirect, so it is minted and checked here rather than in
    // the shared flow — a console install has no callback to forge.
    const expectedState = randomBytes(24).toString("hex");
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("scope", scopes.join(","));
    authorize.searchParams.set("redirect_uri", redirectUrl);
    authorize.searchParams.set("state", expectedState);
    const authorizeUrl = authorize.toString();
    clackLog.info("Approve the internal app installation in Slack:");
    console.error(`[fastagent] ${authorizeUrl}`);
    openExternalUrl(authorizeUrl);

    const callback = await waitForOAuth();
    if (callback.error) throw new Error("Slack OAuth installation was not approved");
    if (!callback.code) throw new Error("Slack OAuth callback carried no authorization code");
    if (!callback.state || callback.state !== expectedState) throw new Error("Slack OAuth callback state mismatch");
    return exchangeSlackOAuthCode({ clientId, clientSecret, code: callback.code, redirectUrl });
  };
}

/**
 * Install from Slack's own console and take the token by hand — the mode for a machine that cannot
 * receive a public callback at all (strict egress, no cloudflared, a hostname its resolver will not
 * answer for, #421). Slack shows the bot token instead of redirecting it, so nothing has to reach here.
 *
 * The app it installs carries no rotation pair: rotating tokens are issued THROUGH an OAuth redirect,
 * which is the one thing this mode does not have. The channel reads a static `SLACK_BOT_TOKEN` in that
 * case (bot-auth.ts), so the cost is re-running this command if the token is ever revoked.
 */
export function installFromConsole(): SlackOnboardIO["install"] {
  return async ({ appId }) => {
    const installUrl = `${CONFIG_TOKEN_URL}/${appId}/install-on-team`;
    // After Install → Allow the SAME page ("Installed App Settings") shows the token with a Copy button;
    // no navigation is needed, so name nothing else.
    clackLog.info(
      "Install the app into your workspace from its console page (Install → Allow), then copy the " +
        "Bot User OAuth Token the page shows.",
    );
    console.error(`[fastagent] ${installUrl}`);
    openExternalUrl(installUrl);
    const botToken = await promptValue("Slack Bot User OAuth Token (xoxb-…)", true);
    if (!botToken.startsWith("xoxb-")) throw new Error("a Slack bot token starts with xoxb-");
    // The one call that separates a real token from a mistyped one, and it names the workspace the
    // agent just joined. Without it the first wrong character would surface as a runtime 401 later.
    const identity = await slackAuthTest(botToken);
    return {
      botToken,
      // Reported as observed: `auth.test` may omit app_id, and filling in the expected value would turn
      // the shared flow's "different app" check into one that cannot fail.
      appId: identity.appId,
      teamId: identity.teamId,
      teamName: identity.teamName,
      botUserId: identity.botUserId,
      // A console install reports the token's identity, never its grant: no `scopes`, and the shared
      // flow skips the scope check instead of asserting one it did not make.
    };
  };
}

/** Interactive single-workspace internal-app creation + installation. Safe to re-run after interruption. */
export async function onboardSlackInternalApp(input: {
  /** The AGENT DIR — credentials land in its `.env` ({@link dotEnvPath}: `FASTAGENT_SECRETS_DIR` moves
   *  it, so messages print the resolved path rather than the default spelling). */
  target: string;
  stateRoot: string;
  groupBehavior: GroupBehaviorChoice;
  /** `--replace-config`: go straight to replacing the local App Configuration token pair. */
  replaceConfig?: boolean;
  /** `--manual`: install from Slack's console instead of catching an OAuth redirect. For a machine
   *  that cannot receive a public callback — a stable property of the network, which is why this is a
   *  flag the operator sets and not a guess made after the automatic path fails. */
  manual?: boolean;
}): Promise<void> {
  installProxyFetch();
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      "`add slack` needs an interactive terminal for internal-app creation and OAuth — " +
        "re-run in a terminal, or pass --no-onboard to scaffold only",
    );
  }

  let state = readSlackOnboardingState(input.stateRoot);
  const resumed = state !== undefined;
  if (input.replaceConfig && !state) {
    throw new Error(
      "--replace-config found no local Slack onboarding state on this machine — nothing to replace. " +
        "Run `fastagent add slack` to onboard, or update the Request URL manually in the Slack console",
    );
  }
  if (state?.installedAt) {
    const env = await readFile(dotEnvPath(input.target), "utf8")
      .then(parseEnvContent)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return new Map<string, string>();
        throw error;
      });
    // What "installed" must have written depends on the KIND of app the record says this is: a console
    // install (`--manual`) runs on a static token and has no rotation fields to be missing.
    const rotation = state.tokenRotation ?? true;
    const missingRuntime = [
      "SLACK_BOT_TOKEN",
      ...(rotation
        ? ["SLACK_BOT_REFRESH_TOKEN", "SLACK_BOT_TOKEN_EXPIRES_AT", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]
        : []),
      "SLACK_SIGNING_SECRET",
    ].filter((name) => !((process.env[name] ?? env.get(name))?.trim() ?? ""));
    if (missingRuntime.length > 0) {
      throw new Error(
        `Slack app ${state.appId ?? "(unknown)"} is installed but ${dotEnvPath(input.target)} is missing ` +
          `${missingRuntime.join(", ")} — ` +
          "restore them from the Slack app console, or delete the app + onboarding state and create a new one",
      );
    }
    if (input.groupBehavior.explicit && state.groupBehavior !== input.groupBehavior.behavior) {
      throw new Error(
        `the onboarded Slack app uses group behavior ${state.groupBehavior}; changing an installed app's ` +
          "OAuth scopes is a migration. Keep the existing choice, or remove the app + Slack onboarding state and create a new app",
      );
    }
    let action: "keep" | "replace-config" = "replace-config";
    if (!input.replaceConfig) {
      const answer = await select<"keep" | "replace-config">({
        message: `Slack app ${state.appId ?? "(unknown)"} is already installed${state.teamName ? ` in ${state.teamName}` : ""}`,
        initialValue: "keep",
        options: [
          { value: "keep", label: "Keep the installed app" },
          {
            value: "replace-config",
            label: "Replace App Configuration tokens",
            hint: "repair automatic dev/deploy Request URL updates",
          },
        ],
      });
      if (isCancel(answer)) throw new Error("Slack onboarding cancelled");
      action = answer;
    }
    if (action === "replace-config") {
      console.error(`[fastagent] generate a fresh App Configuration Token pair at ${CONFIG_TOKEN_URL}`);
      openExternalUrl(CONFIG_TOKEN_URL);
      const configToken = await promptValue("Slack configuration access token (xoxe.xoxp-…)", true);
      const configRefreshToken = await promptValue("Slack configuration refresh token (xoxe-…)", true);
      if (!configToken.startsWith("xoxe.") || !configRefreshToken.startsWith("xoxe-")) {
        throw new Error("invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh)");
      }
      writeSlackOnboardingState(input.stateRoot, {
        ...state,
        configToken,
        configRefreshToken,
        configTokenExpiresAt: Date.now() + 11 * 60 * 60_000,
      });
      console.error("[fastagent] replaced local Slack App Configuration tokens; runtime app credentials are unchanged");
    } else {
      console.error("[fastagent] keeping the installed Slack app and local configuration tokens");
    }
    return;
  }

  if (!state) {
    const appName = await promptValue("Slack app name", false, `FastAgent ${basename(input.target)}`);
    clackLog.info(
      "Slack's configuration refresh token can manage apps owned by your user in this workspace. " +
        "FastAgent stores it only in owner-readable local state; it is never deployed.",
    );
    console.error(`[fastagent] generate an App Configuration Token at ${CONFIG_TOKEN_URL}`);
    openExternalUrl(CONFIG_TOKEN_URL);
    const configToken = await promptValue("Slack configuration access token (xoxe.xoxp-…)", true);
    const configRefreshToken = await promptValue("Slack configuration refresh token (xoxe-…)", true);
    if (!configToken.startsWith("xoxe.")) throw new Error("Slack configuration access token must start with xoxe.");
    if (!configRefreshToken.startsWith("xoxe-")) {
      throw new Error("Slack configuration refresh token must start with xoxe-");
    }
    state = newSlackOnboardingState({
      appName,
      groupBehavior: input.groupBehavior.behavior,
      configToken,
      configRefreshToken,
    });
    writeSlackOnboardingState(input.stateRoot, state);
  } else if (input.groupBehavior.explicit && !state.appId) {
    state = { ...state, groupBehavior: input.groupBehavior.behavior };
    writeSlackOnboardingState(input.stateRoot, state);
  }
  if (state.createAttemptedAt && !state.appId) {
    throw new Error(
      `a prior Slack app creation attempt at ${state.createAttemptedAt} returned no app ID — ` +
        `inspect ${CONFIG_TOKEN_URL}; delete any incomplete app and ${input.stateRoot}/channels/slack/onboarding.json before retrying`,
    );
  }
  // `--replace-config` also covers the created-but-not-installed state, where a revoked token would
  // otherwise strand the resume (rotation fails and no menu offers replacement).
  if (resumed && (!state.appId || input.replaceConfig)) {
    let action: "keep" | "replace-config" = "replace-config";
    if (!input.replaceConfig) {
      const answer = await select<"keep" | "replace-config">({
        message: "Resume Slack onboarding with which App Configuration tokens?",
        initialValue: "keep",
        options: [
          { value: "keep", label: "Use the saved token pair" },
          { value: "replace-config", label: "Paste a fresh token pair" },
        ],
      });
      if (isCancel(answer)) throw new Error("Slack onboarding cancelled");
      action = answer;
    }
    if (action === "replace-config") {
      console.error(`[fastagent] generate a fresh App Configuration Token pair at ${CONFIG_TOKEN_URL}`);
      openExternalUrl(CONFIG_TOKEN_URL);
      state = {
        ...state,
        configToken: await promptValue("Slack configuration access token (xoxe.xoxp-…)", true),
        configRefreshToken: await promptValue("Slack configuration refresh token (xoxe-…)", true),
        configTokenExpiresAt: Date.now() + 11 * 60 * 60_000,
      };
      if (!state.configToken.startsWith("xoxe.") || !state.configRefreshToken.startsWith("xoxe-")) {
        throw new Error("invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh)");
      }
      writeSlackOnboardingState(input.stateRoot, state);
    }
  }

  // `--manual` needs no tunnel and no setup server: the app is created through the same API call, and
  // its `request_url` is simply left unset until something knows a public URL. Everything after the
  // install step is the automatic path's code, not a copy of it.
  if (input.manual) {
    await onboardSlackApp(
      { stateRoot: input.stateRoot, state },
      {
        note: (message) => clackLog.info(message),
        install: installFromConsole(),
        writeRuntimeSecrets: writeRuntimeSecrets(input.target),
      },
    );
    // What happened, once. What to do next is `add`'s "next steps" block, which says it in the user's
    // terms (messages do not arrive until the agent runs somewhere Slack can reach) — the same truth
    // for both install modes, so neither branch narrates its own mechanism here.
    console.error(`[fastagent] Slack app installed; credentials written to ${dotEnvPath(input.target)}`);
    return;
  }

  const server = await startSlackSetupServer();
  const tunnel = await startCloudflareTunnel(server.port);
  if (!tunnel) {
    await server.close();
    throw new Error(
      "Slack onboarding needs a temporary HTTPS tunnel — install cloudflared and re-run, " +
        "or re-run with --manual to install from Slack's console instead",
    );
  }
  const requestUrl = `${tunnel.url}${server.requestPath}`;
  const redirectUrl = `${tunnel.url}${server.redirectPath}`;
  console.error(`[fastagent] temporary Slack setup tunnel ready → ${tunnel.url}`);
  try {
    // No local readiness probe: Slack challenges requestUrl from ITS network during app creation, and
    // that is the reachability that matters (#421); onboardSlackApp retries the create while Slack
    // cannot verify a still-warming tunnel. A machine that can never host the callback is a different
    // case, and --manual is for that one.
    await onboardSlackApp(
      { stateRoot: input.stateRoot, state, requestUrl, redirectUrl },
      {
        note: (message) => clackLog.info(message),
        install: installViaOAuth(redirectUrl, () => server.waitForOAuth()),
        writeRuntimeSecrets: writeRuntimeSecrets(input.target),
      },
    );
    console.error(`[fastagent] Slack app installed; credentials written to ${dotEnvPath(input.target)}`);
  } finally {
    tunnel.close();
    await server.close().catch(() => {});
  }
}
