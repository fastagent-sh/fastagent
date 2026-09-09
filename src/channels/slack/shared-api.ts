/**
 * The ONE Slack transport per state root a process holds: the mounted channel's, shared with the scaffolded send tool.
 */
import { resolvePlacement, resolveStateRoot } from "../../paths.ts";
import { type SlackApi, createSlackApi } from "./slack-api.ts";

/** What a proactive sender needs: Markdown delivery and file upload. */
export type SlackTransport = Pick<SlackApi, "sendMarkdown" | "uploadFile">;

const byStateRoot = new Map<string, SlackApi>();

/** A re-mount replaces the entry: the channel's transport is the authoritative one for its root. */
export function registerSlackApi(stateRoot: string, api: SlackApi): void {
  byStateRoot.set(stateRoot, api);
}

/** The transport of the agent whose workspace is `cwd` (a tool's `ctx.cwd`). */
export function slackTransport(cwd: string): SlackTransport {
  const stateRoot = resolveStateRoot(resolvePlacement(cwd).agentDir);
  let api = byStateRoot.get(stateRoot);
  if (!api) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) throw new Error("SLACK_BOT_TOKEN is not set and no Slack channel is mounted");
    api = createSlackApi({ botToken });
    byStateRoot.set(stateRoot, api);
  }
  return api;
}
