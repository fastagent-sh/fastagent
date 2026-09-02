import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { dotEnvPath, parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { installProxyFetch } from "../proxy.ts";
import { appendChannelDotEnv, type GroupBehaviorChoice } from "../scaffold/add-channel.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../channels/slack/onboard.ts";
import { readSlackOnboardingState, writeSlackOnboardingState } from "../channels/slack/onboarding-state.ts";
import { buildSlackManifest } from "../channels/slack/manifest.ts";
import { startSlackSetupServer } from "../channels/slack/setup-server.ts";
import { startCloudflareTunnel } from "../tunnel.ts";

const CONFIG_TOKEN_URL = "https://api.slack.com/apps";

/**
 * The route that needs no public callback. Automatic onboarding exists only to catch ONE OAuth
 * redirect, so any environment without a reachable public URL — strict egress, no cloudflared, a
 * hostname this machine cannot resolve (#421) — can still finish by hand. Printed on every failure of
 * the automated path, because that path is unavailable rather than broken in those environments.
 *
 * The manifest lands in a FILE rather than the terminal: step 1 is a paste into Slack's console, and
 * scrollback is the worst place to copy forty lines of JSON from. It carries no secret — an app name,
 * the scopes, the events.
 */
async function printManualRoute(
  target: string,
  app: { appName: string; groupBehavior: GroupBehaviorChoice["behavior"] },
): Promise<void> {
  const manifestPath = join(target, "slack-app-manifest.json");
  const manifest = buildSlackManifest({ name: app.appName, groupBehavior: app.groupBehavior });
  let step1 = `  1. ${CONFIG_TOKEN_URL} → Create New App → From an app manifest, and paste ${manifestPath}`;
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    // The manual route is what is left when the automatic one failed; losing it silently to a second
    // failure would leave the operator with nothing. Say so, and keep the rest of the steps.
    step1 = `  1. ${CONFIG_TOKEN_URL} → Create New App → From an app manifest. FastAgent could not write the\n     manifest to ${manifestPath} (${String(error)}) — re-run \`fastagent add slack\` from a writable dir for it.`;
  }
  console.error(
    `[fastagent] slack: no public callback is needed to create the app by hand.\n${step1}\n` +
      `  2. Install to Workspace — the console SHOWS the credentials instead of redirecting.\n` +
      `  3. Copy into ${dotEnvPath(target)}: SLACK_BOT_TOKEN, SLACK_BOT_REFRESH_TOKEN and\n` +
      `     SLACK_BOT_TOKEN_EXPIRES_AT (OAuth & Permissions — the manifest enables token rotation),\n` +
      `     SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET (Basic Information).\n` +
      `  4. Set Event Subscriptions → Request URL to <public-url>/slack once the agent is serving.`,
  );
}

async function promptValue(message: string, hidden = false, initialValue?: string): Promise<string> {
  const result = hidden ? await password({ message }) : await clackText({ message, initialValue });
  if (isCancel(result)) throw new Error("Slack onboarding cancelled");
  const value = String(result).trim();
  if (!value) throw new Error(`${message}: value is required`);
  return value;
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
    const missingRuntime = [
      "SLACK_BOT_TOKEN",
      "SLACK_BOT_REFRESH_TOKEN",
      "SLACK_BOT_TOKEN_EXPIRES_AT",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
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

  const app = { appName: state.appName, groupBehavior: state.groupBehavior };
  const server = await startSlackSetupServer();
  const tunnel = await startCloudflareTunnel(server.port);
  if (!tunnel) {
    await server.close();
    await printManualRoute(input.target, app);
    throw new Error("Slack onboarding needs a temporary HTTPS tunnel — install cloudflared and re-run");
  }
  const requestUrl = `${tunnel.url}${server.requestPath}`;
  const redirectUrl = `${tunnel.url}${server.redirectPath}`;
  console.error(`[fastagent] temporary Slack setup tunnel ready → ${tunnel.url}`);
  try {
    // No local readiness probe: Slack challenges requestUrl from ITS network during app creation, and
    // that is the reachability that matters. onboardSlackApp retries while Slack cannot verify it.
    await onboardSlackApp(
      { stateRoot: input.stateRoot, state, requestUrl, redirectUrl },
      {
        note: (message) => clackLog.info(message),
        openUrl: openExternalUrl,
        waitForOAuth: () => server.waitForOAuth(),
        writeRuntimeSecrets: async ({
          botToken,
          botRefreshToken,
          botTokenExpiresAt,
          clientId,
          clientSecret,
          signingSecret,
        }) => {
          const values = {
            ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
            ...(botRefreshToken ? { SLACK_BOT_REFRESH_TOKEN: botRefreshToken } : {}),
            ...(botTokenExpiresAt ? { SLACK_BOT_TOKEN_EXPIRES_AT: String(botTokenExpiresAt) } : {}),
            ...(clientId ? { SLACK_CLIENT_ID: clientId } : {}),
            ...(clientSecret ? { SLACK_CLIENT_SECRET: clientSecret } : {}),
            ...(signingSecret ? { SLACK_SIGNING_SECRET: signingSecret } : {}),
          };
          if (Object.keys(values).length > 0) {
            await appendChannelDotEnv(input.target, "slack", values, Object.keys(values));
          }
        },
      },
    );
    console.error(
      `[fastagent] Slack app installed; rotating bot credentials and Signing Secret written to ${dotEnvPath(input.target)}`,
    );
    console.error(
      `[fastagent] run \`fastagent dev --tunnel\` next — FastAgent will rotate the config token and ` +
        "replace the temporary Events API URL automatically",
    );
  } catch (error) {
    await printManualRoute(input.target, app);
    throw error;
  } finally {
    tunnel.close();
    await server.close().catch(() => {});
  }
}
