import { needs } from "@fastagent-sh/fastagent";
import { type SlackSocketChannelOptions, slackSocketChannel } from "@fastagent-sh/fastagent/slack";

// Slack channel. `fastagent channels setup slack` creates the app (from a manifest link that sets the scopes, the
// events and the Socket Mode switch this file needs) and keeps its credentials.
//
// The app receives over a Socket Mode connection this process opens, so it needs no public URL, in `fastagent dev`
// and in a container alike. An app in Socket Mode hands each event to one of its connections: give a deployment an
// app of its own.
//
// Leave token rotation OFF: it cannot be turned off again, and this channel takes one long-lived Bot User OAuth Token.

const policy: Pick<SlackSocketChannelOptions, "rendering" | "onError"> = {
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

// `needs` declares the env vars this file reads: the instance is refused to serve while one is unset.
export default needs(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], (secrets) =>
  slackSocketChannel({
    botToken: secrets.SLACK_BOT_TOKEN, // Install App → Bot User OAuth Token (xoxb-…)
    appToken: secrets.SLACK_APP_TOKEN, // Basic Information → App-Level Tokens (xapp-…, connections:write)
    ...policy,
  }),
);
