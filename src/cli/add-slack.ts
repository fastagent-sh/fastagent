import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { dotEnvPath, parseEnvContent } from "../value-file.ts";
import { openExternalUrl } from "../open-url.ts";
import { appendChannelDotEnv } from "../scaffold/add-channel.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../channels/slack/onboard.ts";
import {
  configTokenExpiry,
  readSlackOnboardingState,
  writeSlackOnboardingState,
} from "../channels/slack/onboarding-state.ts";
import { type SlackSetupServer, startSlackSetupServer } from "../channels/slack/setup-server.ts";
import { startCloudflareTunnel } from "../tunnel.ts";
import type { Person } from "./person.ts";

/** Where an App Configuration token pair is generated. */
const SLACK_CONFIG_TOKEN_URL = "https://api.slack.com/apps";

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

/** An App Configuration token pair, refused unless each is the kind Slack issues. */
function checkedConfigTokens(configToken: string, configRefreshToken: string) {
  if (!configToken.startsWith("xoxe.") || !configRefreshToken.startsWith("xoxe-")) {
    throw new Error("invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh)");
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

const nothingToReplace = () =>
  new Error(
    "--replace-config found no local Slack onboarding state on this machine — nothing to replace. " +
      "Run `fastagent add slack` to onboard, or update the Request URL manually in the Slack console",
  );

/** The temporary setup server and the tunnel to it, started once something needs them. */
function setupEndpoint() {
  let started: Promise<{ server: SlackSetupServer; tunnelUrl: string; closeTunnel(): void }> | undefined;
  return {
    get: () => {
      started ??= (async () => {
        const server = await startSlackSetupServer();
        const tunnel = await startCloudflareTunnel(server.port);
        if (!tunnel) {
          await server.close();
          throw new Error("Slack onboarding needs a temporary HTTPS tunnel — install cloudflared and re-run");
        }
        console.error(`[fastagent] temporary Slack setup tunnel ready → ${tunnel.url}`);
        return { server, tunnelUrl: tunnel.url, closeTunnel: () => tunnel.close() };
      })();
      return started;
    },
    /** The endpoint if something started it, never starting one. */
    ifStarted: () => started?.catch(() => undefined),
    async close() {
      const endpoint = await started?.catch(() => undefined);
      if (endpoint === undefined) return;
      endpoint.closeTunnel();
      await endpoint.server.close().catch(() => {});
    },
  };
}

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
   * A coding agent's person, through a ticket: nothing is asked at a terminal. The token pair is pasted on a page the
   * setup server shows, which then takes the browser on to Slack's install page; the app takes its default name, and
   * a saved pair is kept. Absent: the terminal asks.
   */
  person?: Person;
}): Promise<void> {
  const { person } = input;
  const endpoint = setupEndpoint();
  /** A fresh pair: at the terminal, or on the setup server's page. */
  const freshTokens = async (): Promise<ConfigTokens> => {
    if (person === undefined) return promptConfigTokens();
    const { server, tunnelUrl } = await endpoint.get();
    person.waitsOn(
      `${tunnelUrl}${server.tokensPath}`,
      `generate a Slack App Configuration Token at ${SLACK_CONFIG_TOKEN_URL} and paste it on this page`,
    );
    const tokens = await server.waitForTokens(({ access, refresh }) => checkedConfigTokens(access, refresh));
    person.carriesOn();
    return tokens;
  };
  try {
    await onboard(input, freshTokens, endpoint);
  } catch (error) {
    // The browser that pasted the pair waits on the next page: it says why, as the ticket does.
    await (await endpoint.ifStarted())?.server.failed((error as Error).message);
    throw error;
  } finally {
    await endpoint.close();
  }
}

async function onboard(
  input: { target: string; stateRoot: string; replaceConfig?: boolean; person?: Person },
  freshTokens: () => Promise<ConfigTokens>,
  endpoint: ReturnType<typeof setupEndpoint>,
): Promise<void> {
  const { person } = input;
  const asks = person === undefined;
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
      writeSlackOnboardingState(input.stateRoot, { ...state, ...(await freshTokens()) });
      console.error("[fastagent] replaced local Slack App Configuration tokens; runtime app credentials are unchanged");
      // A browser that pasted the pair waits on the page after it: this is where the setup ends.
      await (await endpoint.ifStarted())?.server.done(
        "Slack App Configuration tokens replaced: you can close this page.",
      );
    } else {
      console.error("[fastagent] keeping the installed Slack app and local configuration tokens");
    }
    return;
  }

  if (!state) {
    const appName = asks
      ? await promptValue("Slack app name", false, `FastAgent ${basename(input.target)}`)
      : `FastAgent ${basename(input.target)}`;
    if (asks) {
      clackLog.info(
        "Slack's configuration refresh token can manage apps owned by your user in this workspace. " +
          "FastAgent stores it only in owner-readable local state; it is never deployed.",
      );
    }
    state = newSlackOnboardingState({ appName, ...(await freshTokens()) });
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
      state = { ...state, ...(await freshTokens()) };
      writeSlackOnboardingState(input.stateRoot, state);
    }
  }

  const { server, tunnelUrl } = await endpoint.get();
  const requestUrl = `${tunnelUrl}${server.requestPath}`;
  const redirectUrl = `${tunnelUrl}${server.redirectPath}`;
  // No local readiness probe: Slack challenges requestUrl from ITS network during app creation, and that is the
  // reachability that matters (#421).
  await onboardSlackApp(
    { stateRoot: input.stateRoot, state, requestUrl, redirectUrl },
    {
      note: (message) => (asks ? clackLog.info(message) : console.error(`[fastagent] ${message}`)),
      openUrl: (url) => {
        if (person === undefined) return openExternalUrl(url);
        // A browser that pasted the pair goes straight on; the ticket names the page for one that did not.
        server.next(url);
        person.waitsOn(url, "click Allow to install the Slack app in their workspace");
      },
      waitForOAuth: async () => {
        const callback = await server.waitForOAuth();
        person?.carriesOn();
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
}
