import { byIngress, needs } from "@fastagent-sh/fastagent";
import { type SlackChannelOptions, slackChannel, slackSocketChannel } from "@fastagent-sh/fastagent/slack";

// Slack channel. `fastagent channels setup slack` creates the app (from a manifest link that sets the scopes, the
// events and the Socket Mode switch this file needs) and keeps its credentials.
//
// How it receives is the instance's choice, `channels.slack.ingress` in its fastagent.json (webhook | connection).
// Unset, `fastagent dev` opens a Socket Mode connection OUT (no public URL, no tunnel), and everything else —
// `fastagent start`, every deployment — receives by webhook at POST /slack, the way a host that wakes on a request is
// reached. An app in Socket Mode receives over the socket ALONE, so an app serves one instance, and a deployment that
// receives by webhook has an app of its own.
//
// Leave token rotation OFF: it cannot be turned off again, and this channel takes one long-lived Bot User OAuth Token.

// Your policy, the same whichever way the channel receives.
const policy: Pick<SlackChannelOptions, "rendering" | "onError"> = {
  // Slack Agent stream; its inline tool traces show each call's first argument and stay in the delivered message.
  // "classic" settles into the answer alone (and gives up native streaming).
  rendering: "native",
  // Optional per-reply footer, if your policy requires one: aiDisclaimer: "AI-generated; verify important information.",
  // welcome: "Custom first-run DM greeting", // sent once on first DM open; false disables (default: a generic greeting)
  // reactionAck: false, // disable the 👀→✅ ack on the user's message (default on; needs reactions:write)
  // An answer attaches to its question with a thread (Slack has no quote primitive), and that thread is
  // one conversation, with a session of its own.
  // Dev/personal bot: surface raw errors. Remove this for a customer-facing bot; details remain in logs.
  onError: (failed) => `⚠️ ${failed.details}`,
};

// Each way's `needs` declares the env vars it reads: an instance is asked only for its way's, and refused to serve
// while a required one is unset.
export default byIngress({
  webhook: needs(["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], (secrets) =>
    slackChannel({
      botToken: secrets.SLACK_BOT_TOKEN, // Install App → Bot User OAuth Token (xoxb-…)
      signingSecret: secrets.SLACK_SIGNING_SECRET, // Basic Information → Signing Secret
      ...policy,
    }),
  ),
  connection: needs(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], (secrets) =>
    slackSocketChannel({
      botToken: secrets.SLACK_BOT_TOKEN,
      appToken: secrets.SLACK_APP_TOKEN, // Basic Information → App-Level Tokens (xapp-…, connections:write)
      ...policy,
    }),
  ),
});
