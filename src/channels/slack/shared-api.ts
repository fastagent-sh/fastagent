/**
 * The ONE Slack transport per state root a process holds: the mounted channel's, shared with the
 * scaffolded send tool.
 *
 * The tool used to read `SLACK_BOT_TOKEN` from the environment, so once the channel had rotated the
 * bot token it kept posting with the one the process was booted with (#458). Sharing the channel's
 * transport gives it the current pair, one single-flight refresh, and the channel's Markdown splitting
 * and rate-limit handling. The channel registers at mount; the tool resolves at EXECUTE, never at
 * load (on AgentCore, loading runs before the state snapshot is restored), and builds a transport
 * from the documented env names only where no channel is mounted (`fastagent fire` / `invoke`) —
 * over the same persisted pair, so the lineage stays one. That fallback knows no `apiBaseUrl`: the
 * option lives in the channel's glue, which is not loaded on those paths, so it uses Slack's default.
 */
import { resolvePlacement, resolveStateRoot } from "../../paths.ts";
import { createSlackBotTokenProvider, slackBotAuthPath } from "./bot-auth.ts";
import { type SlackApi, createSlackApi } from "./slack-api.ts";

/** What a proactive sender needs: Markdown delivery and file upload, on the current credentials. */
export type SlackTransport = Pick<SlackApi, "sendMarkdown" | "uploadFile">;

const byStateRoot = new Map<string, SlackApi>();

/** A re-mount replaces the entry: the channel's transport is the authoritative one for its root. */
export function registerSlackApi(stateRoot: string, api: SlackApi): void {
  byStateRoot.set(stateRoot, api);
}

/**
 * The transport of the agent whose workspace is `cwd` (a tool's `ctx.cwd`). The state root is derived
 * exactly as the opener derives it for the channel, so both name the same file.
 */
export function slackTransport(cwd: string): SlackTransport {
  const stateRoot = resolveStateRoot(resolvePlacement(cwd).agentDir);
  let api = byStateRoot.get(stateRoot);
  if (!api) {
    api = slackApiFromEnv(stateRoot);
    byStateRoot.set(stateRoot, api);
  }
  return api;
}

function slackApiFromEnv(stateRoot: string): SlackApi {
  const env = process.env;
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not set and no Slack channel is mounted");
  return createSlackApi({
    botToken: createSlackBotTokenProvider({
      statePath: slackBotAuthPath(stateRoot),
      botToken: env.SLACK_BOT_TOKEN,
      botRefreshToken: env.SLACK_BOT_REFRESH_TOKEN || undefined,
      clientId: env.SLACK_CLIENT_ID || undefined,
      clientSecret: env.SLACK_CLIENT_SECRET || undefined,
      botTokenExpiresAt: env.SLACK_BOT_TOKEN_EXPIRES_AT ? Number(env.SLACK_BOT_TOKEN_EXPIRES_AT) : undefined,
    }),
  });
}
