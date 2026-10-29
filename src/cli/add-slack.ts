import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { dotEnvPath, parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { appendChannelDotEnv } from "../scaffold/add-channel.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../channels/slack/onboard.ts";
import {
  configTokenExpiry,
  readSlackOnboardingState,
  writeSlackOnboardingState,
} from "../channels/slack/onboarding-state.ts";
import { startSlackSetupServer } from "../channels/slack/setup-server.ts";
import { startCloudflareTunnel } from "../tunnel.ts";
import type { Person } from "./person.ts";

/** Where an App Configuration token pair is generated. */
export const SLACK_CONFIG_TOKEN_URL = "https://api.slack.com/apps";

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
  console.error(`[fastagent] generate an App Configuration Token pair at ${SLACK_CONFIG_TOKEN_URL}`);
  openExternalUrl(SLACK_CONFIG_TOKEN_URL);
  const configToken = await promptValue("Slack configuration access token (xoxe.xoxp-…)", true);
  const configRefreshToken = await promptValue("Slack configuration refresh token (xoxe-…)", true);
  return checkedConfigTokens(configToken, configRefreshToken);
}

type ConfigTokens = Awaited<ReturnType<typeof promptConfigTokens>>;

/** An App Configuration token pair, refused unless each is the kind Slack issues; `from` names where it was read. */
function checkedConfigTokens(configToken: string, configRefreshToken: string, from?: string) {
  if (!configToken.startsWith("xoxe.") || !configRefreshToken.startsWith("xoxe-")) {
    throw new Error(
      `invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh)${from ? ` in ${from}` : ""}`,
    );
  }
  return { configToken, configRefreshToken, configTokenExpiresAt: configTokenExpiry() };
}

/** Keep the saved token pair, or paste a fresh one? `--replace-config` answers without asking. */
async function chooseTokenAction(prompt: {
  /** `--replace-config`: answer without asking. */
  forced: boolean;
  /** false: no one to ask, so the saved pair is kept. */
  asks: boolean;
  message: string;
  keepLabel: string;
  replaceLabel: string;
  replaceHint?: string;
}): Promise<"keep" | "replace-config"> {
  if (prompt.forced) return "replace-config";
  if (!prompt.asks) return "keep";
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

/**
 * Where a coding agent's person leaves an App Configuration token pair for `add slack`: beside the onboarding state,
 * never in a value file (`.secrets/production/.env` is the deployed environment, and every variable in it travels).
 * `add slack` moves the pair into the onboarding state and deletes the file.
 */
export const slackTokenHandoffPath = (stateRoot: string) => join(stateRoot, "channels", "slack", "config-tokens.env");
/** The keys a person writes in the handoff file. */
export const slackTokenHandoffKeys = ["SLACK_CONFIG_TOKEN", "SLACK_CONFIG_REFRESH_TOKEN"] as const;

/** The token pair a person left in the handoff file, if they have; a file that is not one is refused, by name. */
async function takeSlackTokenHandoff(stateRoot: string): Promise<ConfigTokens | undefined> {
  const path = slackTokenHandoffPath(stateRoot);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const values = parseEnvContent(text);
  const tokens = checkedConfigTokens(
    values.get(slackTokenHandoffKeys[0]) ?? "",
    values.get(slackTokenHandoffKeys[1]) ?? "",
    path,
  );
  await rm(path);
  return tokens;
}

/**
 * Whether `add slack` can run its onboarding with no one to ask: the token pair it needs is in the onboarding state,
 * now if the person left a fresh one in the handoff file (taken into the state here), or it waits on them to leave one.
 * An app already installed needs no pair, unless `--replace-config` asks for a fresh one.
 */
export async function slackTokensForAgent(
  target: string,
  stateRoot: string,
  replaceConfig: boolean,
): Promise<"ready" | "needs-handoff"> {
  const state = readSlackOnboardingState(stateRoot);
  if (replaceConfig && state === undefined) throw nothingToReplace();
  if (state !== undefined && !replaceConfig) return "ready";
  const tokens = await takeSlackTokenHandoff(stateRoot);
  if (tokens === undefined) return "needs-handoff";
  writeSlackOnboardingState(
    stateRoot,
    state === undefined
      ? newSlackOnboardingState({ appName: `FastAgent ${basename(target)}`, ...tokens })
      : { ...state, ...tokens },
  );
  return "ready";
}

const nothingToReplace = () =>
  new Error(
    "--replace-config found no local Slack onboarding state on this machine — nothing to replace. " +
      "Run `fastagent add slack` to onboard, or update the Request URL manually in the Slack console",
  );

/** Single-workspace internal-app creation + installation. */
export async function onboardSlackInternalApp(input: {
  /**
   * The AGENT DIR — credentials land in its `.env` ({@link dotEnvPath}: `FASTAGENT_SECRETS_DIR` moves it, so messages
   * print the resolved path rather than the default spelling).
   */
  target: string;
  stateRoot: string;
  /** `--replace-config`: go straight to replacing the local App Configuration token pair. */
  replaceConfig?: boolean;
  /**
   * A coding agent's person, through a ticket: nothing is asked, the token pair is in the onboarding state already
   * (`slackTokensForAgent`), the app takes its default name and a saved pair is kept. Absent: the terminal asks.
   */
  person?: Person;
}): Promise<void> {
  const asks = input.person === undefined;
  let state = readSlackOnboardingState(input.stateRoot);
  const resumed = state !== undefined;
  if (input.replaceConfig && !state) throw nothingToReplace();
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
    const action = await chooseTokenAction({
      forced: input.replaceConfig === true,
      asks,
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
    if (!asks)
      throw new Error("no Slack App Configuration token pair: `add slack` takes it from its handoff file first");
    const appName = await promptValue("Slack app name", false, `FastAgent ${basename(input.target)}`);
    clackLog.info(
      "Slack's configuration refresh token can manage apps owned by your user in this workspace. " +
        "FastAgent stores it only in owner-readable local state; it is never deployed.",
    );
    state = newSlackOnboardingState({ appName, ...(await promptConfigTokens()) });
    writeSlackOnboardingState(input.stateRoot, state);
  }
  if (state.createAttemptedAt && !state.appId) {
    throw new Error(
      `a prior Slack app creation attempt at ${state.createAttemptedAt} returned no app ID — ` +
        `inspect ${SLACK_CONFIG_TOKEN_URL}; delete any incomplete app and ${input.stateRoot}/channels/slack/onboarding.json before retrying`,
    );
  }
  // `--replace-config` also covers the created-but-not-installed state, where a revoked token would otherwise strand
  // the resume (rotation fails and no menu offers replacement).
  if (resumed && (!state.appId || input.replaceConfig)) {
    const action = await chooseTokenAction({
      forced: input.replaceConfig === true,
      asks,
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
        note: (message) => (asks ? clackLog.info(message) : console.error(`[fastagent] ${message}`)),
        openUrl: (url) =>
          input.person === undefined
            ? openExternalUrl(url)
            : input.person.waitsOn(url, "click Allow to install the Slack app in their workspace"),
        waitForOAuth: async () => {
          const callback = await server.waitForOAuth();
          input.person?.carriesOn();
          return callback;
        },
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
