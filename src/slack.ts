/** `@fastagent-sh/fastagent/slack` — the first-party Slack Events API bot-channel surface. */
export {
  slackChannel,
  defaultSlackRoute,
  slackEnvelope,
  verifySlackSignature,
  type SlackChannelOptions,
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRendering,
  type SlackRoute,
  type SlackFailure,
} from "./channels/slack/slack.ts";
