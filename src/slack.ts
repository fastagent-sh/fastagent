/** `@fastagent-sh/fastagent/slack` — the Slack bot channel, kept off the root surface. */
export {
  slack,
  slackChannel,
  defaultSlackRoute,
  slackEnvelope,
  verifySlackSignature,
  type SlackOptions,
  type SlackChannelOptions,
  type SlackEventEnvelope,
  type SlackFile,
  type SlackMessageEvent,
  type SlackRoute,
  type SlackFailure,
} from "./channels/slack/slack.ts";
