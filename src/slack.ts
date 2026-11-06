/** `@fastagent-sh/fastagent/slack` — the first-party Slack Events API bot-channel surface. */
export {
  slackChannel,
  slackSocketChannel,
  defaultSlackRoute,
  slackEnvelope,
  verifySlackSignature,
  type SlackChannelOptions,
  type SlackSocketChannelOptions,
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRendering,
  type SlackRoute,
  type SlackFailure,
} from "./channels/slack/slack.ts";
export { slackThreads, slackTransport, type SlackTransport } from "./channels/slack/shared-api.ts";
export type { SentSlackMessage, SlackTarget, UploadedSlackFile } from "./channels/slack/slack-api.ts";
