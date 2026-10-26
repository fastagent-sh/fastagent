/**
 * The ONE Slack transport per bot a process holds: the mounted channel's, shared with the scaffolded send tool, found
 * by the bot token both hold.
 */
import { roomThreads } from "../kit/room-threads.ts";
import { type SlackApi, createSlackApi } from "./slack-api.ts";

/** What a proactive sender needs: Markdown delivery and file upload. */
export type SlackTransport = Pick<SlackApi, "sendMarkdown" | "uploadFile">;

const byToken = new Map<string, SlackApi>();

/** A re-mount replaces the entry: the channel's transport is the authoritative one for its bot. */
export function registerSlackApi(botToken: string, api: SlackApi): void {
  byToken.set(botToken, api);
}

/** The transport of the bot `botToken` signs in as: its mounted channel's, or the token's own when none is mounted. */
export function slackTransport(botToken: string): SlackTransport {
  let api = byToken.get(botToken);
  if (!api) {
    api = createSlackApi({ botToken });
    byToken.set(botToken, api);
  }
  return api;
}

/**
 * The threads of the channel the message running in `sessionId` was asked in, and only those (`kit/room-threads.ts`):
 * `list()` its recent threads, `read(threadTs)` one of them. Throws outside a Slack channel turn served by this
 * process.
 */
export function slackThreads(sessionId: string | undefined): ReturnType<typeof roomThreads> {
  return roomThreads("slack", sessionId);
}
