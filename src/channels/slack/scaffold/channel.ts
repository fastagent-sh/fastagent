import { slackChannel } from "@fastagent-sh/fastagent/slack";

// Slack HTTP Events API channel. Setup:
//   1. Create a Slack app at https://api.slack.com/apps and add a bot user.
//   2. Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history,
//      files:read, files:write, channels:history, groups:history, and mpim:history. The explicit
//      mention-only mode may omit the three group-history scopes.
//   3. Event Subscriptions: app_home_opened, app_context_changed, app_mention, message.im,
//      message.channels, message.groups, and message.mpim. Mention-only may omit the last three.
//      Set Request URL to https://<host>/slack.
//   4. Enable token rotation and install/reinstall the app after changing scopes. Rotating credentials
//      are written by `fastagent add slack`; manual long-lived tokens may omit the four rotation fields.
export default slackChannel({
  botToken: process.env.SLACK_BOT_TOKEN ?? "", // Bot User OAuth Token (xoxb-… or rotating xoxe.xoxb-…)
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "", // Basic Information → App Credentials
  botRefreshToken: process.env.SLACK_BOT_REFRESH_TOKEN || undefined,
  clientId: process.env.SLACK_CLIENT_ID || undefined,
  clientSecret: process.env.SLACK_CLIENT_SECRET || undefined,
  tokenExpiresAt: process.env.SLACK_BOT_TOKEN_EXPIRES_AT
    ? Number(process.env.SLACK_BOT_TOKEN_EXPIRES_AT)
    : undefined,
  groupBehavior: "context", // default; use "mentions" only for an explicit least-privilege setup
  rendering: "native", // Slack Agent streams + task timeline; use "classic" only for compatibility
  // Optional per-reply footer, if your policy requires one: aiDisclaimer: "AI-generated; verify important information.",
  // Direct and group asks default to independent sessions + Slack threads; opt out independently:
  // directMessageSession: "continuous",
  // groupMessageSession: "continuous",
  // Dev/personal bot: surface raw errors. Remove this for a customer-facing bot; details remain in logs.
  onError: (failed) => `⚠️ ${failed.details}`,
});
