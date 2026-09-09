import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { dotEnvPath, parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { installProxyFetch } from "../proxy.ts";
import { appendChannelDotEnv, type GroupBehaviorChoice } from "../scaffold/add-channel.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../channels/slack/onboard.ts";
import {
  configTokenExpiry,
  readSlackOnboardingState,
  writeSlackOnboardingState,
} from "../channels/slack/onboarding-state.ts";
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

/** The one place an App Configuration token pair is asked for and validated. */
async function promptConfigTokens(): Promise<{
  configToken: string;
  configRefreshToken: string;
  configTokenExpiresAt: number;
}> {
  console.error(`[fastagent] generate an App Configuration Token pair at ${CONFIG_TOKEN_URL}`);
  openExternalUrl(CONFIG_TOKEN_URL);
  const configToken = await promptValue("Slack configuration access token (xoxe.xoxp-…)", true);
  const configRefreshToken = await promptValue("Slack configuration refresh token (xoxe-…)", true);
  if (!configToken.startsWith("xoxe.") || !configRefreshToken.startsWith("xoxe-")) {
    throw new Error("invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh)");
  }
  return { configToken, configRefreshToken, configTokenExpiresAt: configTokenExpiry() };
}

/** Keep the saved token pair, or paste a fresh one? `--replace-config` answers without asking. */
async function chooseTokenAction(prompt: {
  /** `--replace-config`: answer without asking. */
  forced: boolean;
  message: string;
  keepLabel: string;
  replaceLabel: string;
  replaceHint?: string;
}): Promise<"keep" | "replace-config"> {
  if (prompt.forced) return "replace-config";
  const answer = await select<"keep" | "replace-config">({
    message: prompt.message,
    initialValue: "keep",
    options: [
      { value: "keep", label: prompt.keepLabel },
      {
        value: "replace-config",
        label: prompt.replaceLabel,
        ...(prompt.replaceHint ? { hint: prompt.replaceHint } : {}),
      },
    ],
  });
  if (isCancel(answer)) throw new Error("Slack onboarding cancelled");
  return answer;
}

/** Interactive single-workspace internal-app creation + installation. */
export async function onboardSlackInternalApp(input: {
  /**
   * The AGENT DIR — credentials land in its `.env` ({@link dotEnvPath}: `FASTAGENT_SECRETS_DIR` moves it, so messages
   * print the resolved path rather than the default spelling).
   */
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
    const missingRuntime = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].filter(
      (name) => !((process.env[name] ?? env.get(name))?.trim() ?? ""),
    );
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
    const action = await chooseTokenAction({
      forced: input.replaceConfig === true,
      message: `Slack app ${state.appId ?? "(unknown)"} is already installed${state.teamName ? ` in ${state.teamName}` : ""}`,
      keepLabel: "Keep the installed app",
      replaceLabel: "Replace App Configuration tokens",
      replaceHint: "repair automatic dev/deploy Request URL updates",
    });
    if (action === "replace-config") {
      writeSlackOnboardingState(input.stateRoot, { ...state, ...(await promptConfigTokens()) });
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
    state = newSlackOnboardingState({
      appName,
      groupBehavior: input.groupBehavior.behavior,
      ...(await promptConfigTokens()),
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
  // `--replace-config` also covers the created-but-not-installed state, where a revoked token would otherwise strand
  // the resume (rotation fails and no menu offers replacement).
  if (resumed && (!state.appId || input.replaceConfig)) {
    const action = await chooseTokenAction({
      forced: input.replaceConfig === true,
      message: "Resume Slack onboarding with which App Configuration tokens?",
      keepLabel: "Use the saved token pair",
      replaceLabel: "Paste a fresh token pair",
    });
    if (action === "replace-config") {
      state = { ...state, ...(await promptConfigTokens()) };
      writeSlackOnboardingState(input.stateRoot, state);
    }
  }

  const server = await startSlackSetupServer();
  const tunnel = await startCloudflareTunnel(server.port);
  if (!tunnel) {
    await server.close();
    throw new Error("Slack onboarding needs a temporary HTTPS tunnel — install cloudflared and re-run");
  }
  const requestUrl = `${tunnel.url}${server.requestPath}`;
  const redirectUrl = `${tunnel.url}${server.redirectPath}`;
  console.error(`[fastagent] temporary Slack setup tunnel ready → ${tunnel.url}`);
  try {
    // No local readiness probe: Slack challenges requestUrl from ITS network during app creation, and that is the
    // reachability that matters (#421).
    await onboardSlackApp(
      { stateRoot: input.stateRoot, state, requestUrl, redirectUrl },
      {
        note: (message) => clackLog.info(message),
        openUrl: openExternalUrl,
        waitForOAuth: () => server.waitForOAuth(),
        writeRuntimeSecrets: async ({ botToken, signingSecret }) => {
          const values = {
            ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
            ...(signingSecret ? { SLACK_SIGNING_SECRET: signingSecret } : {}),
          };
          if (Object.keys(values).length > 0) {
            await appendChannelDotEnv(input.target, "slack", values, Object.keys(values));
          }
        },
      },
    );
    // What happened, once. What to do next is `add`'s "next steps" block.
    console.error(`[fastagent] Slack app installed; credentials written to ${dotEnvPath(input.target)}`);
  } finally {
    tunnel.close();
    await server.close().catch(() => {});
  }
}
