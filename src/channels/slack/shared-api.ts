/**
 * The ONE Slack transport per state root a process holds: the mounted channel's, shared with the scaffolded send tool.
 */
import { resolveStateRoot } from "../../paths.ts";
import { roomThreads } from "../kit/room-threads.ts";
import { type SlackApi, createSlackApi } from "./slack-api.ts";

/** What a proactive sender needs: Markdown delivery and file upload. */
export type SlackTransport = Pick<SlackApi, "sendMarkdown" | "uploadFile">;

const byStateRoot = new Map<string, SlackApi>();

/** A re-mount replaces the entry: the channel's transport is the authoritative one for its root. */
export function registerSlackApi(stateRoot: string, api: SlackApi): void {
  byStateRoot.set(stateRoot, api);
}

/** The transport of the agent whose directory is `cwd` (a tool's `ctx.cwd`). */
export function slackTransport(cwd: string): SlackTransport {
  const stateRoot = resolveStateRoot(cwd);
  let api = byStateRoot.get(stateRoot);
  if (!api) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) throw new Error("SLACK_BOT_TOKEN is not set and no Slack channel is mounted");
    api = createSlackApi({ botToken });
    byStateRoot.set(stateRoot, api);
  }
  return api;
}

/**
 * The threads of the channel a tool's turn was asked in, and only those (`kit/room-threads.ts`): `list()` its recent
 * threads, `read(threadTs)` one of them. Throws outside a Slack channel turn served by this process.
 */
export function slackThreads(ctx: Parameters<typeof roomThreads>[1]): ReturnType<typeof roomThreads> {
  return roomThreads("slack", ctx);
}
