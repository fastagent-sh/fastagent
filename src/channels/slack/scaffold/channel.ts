import { slackChannel } from "@fastagent-sh/fastagent/slack";
import { defineChannel } from "@fastagent-sh/fastagent";

// Slack HTTP Events API channel. Setup:
//   1. Create a Slack app at https://api.slack.com/apps and add a bot user.
//   2. Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history,
//      files:read, files:write, channels:history, groups:history, and mpim:history. The explicit
//      mention-only mode may omit the three group-history scopes.
//   3. Event Subscriptions: app_home_opened, app_context_changed, app_mention, message.im,
//      message.channels, message.groups, and message.mpim. Mention-only may omit the last three.
//      Set Request URL to https://<host>/slack.
//   4. Install the app (reinstall after changing scopes) and leave token rotation OFF: it cannot be
//      turned off again, and this channel takes one long-lived Bot User OAuth Token.
export default defineChannel({
  // The env vars this channel needs. fastagent carries them to a deployed box and refuses to serve
  // while one is unset — a bare process.env read gets neither guarantee.
  secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  channel: (secrets) =>
    slackChannel({
      botToken: secrets.SLACK_BOT_TOKEN, // OAuth & Permissions → Bot User OAuth Token (xoxb-…)
      signingSecret: secrets.SLACK_SIGNING_SECRET, // Basic Information → App Credentials
      // Slack Agent stream; its inline tool traces show each call's first argument and stay in the
      // delivered message. "classic" settles into the answer alone (and gives up native streaming).
      rendering: "native",
      // Optional per-reply footer, if your policy requires one: aiDisclaimer: "AI-generated; verify important information.",
      // welcome: "Custom first-run DM greeting", // sent once on first DM open; false disables (default: a generic greeting)
      // reactionAck: false, // disable the 👀→✅ ack on the user's message (default on; needs reactions:write)
      // No session modes: an answer attaches to its question with a thread (Slack has no quote primitive),
      // and that thread is the session — see docs/design/participant-model.md.
      // Dev/personal bot: surface raw errors. Remove this for a customer-facing bot; details remain in logs.
      onError: (failed) => `⚠️ ${failed.details}`,
    }),
});
