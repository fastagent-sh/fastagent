---
title: Slack channel
description: "Run an agent as a Slack app: create the app, Socket Mode or webhook, when it answers, threads and history, files, rendering, and sending from schedules."
status: current
---

# Slack channel

The agent answers as a Slack app, in threads, streaming with Slack's native Agent messages.

## Set it up

```bash
fastagent add slack              # src/channels/slack.ts, and the slack_send and slack-threads tools
fastagent channels setup slack   # creates the app from a link; paste its tokens
fastagent dev                    # Socket Mode: no public URL needed
```

`channels setup slack` opens Slack's *create an app* page with everything filled in:
1. Pick the workspace, click **Create**, then **Install App → Install to Workspace → Allow**.
2. Paste the **Bot User OAuth Token** (`xoxb-…`).
3. Paste the **App-Level Token**: Basic Information → App-Level Tokens → *Generate*, scope `connections:write`. For a
   webhook app, it asks for the **Signing Secret** instead.

Each value is checked with Slack before it is kept. A coding agent runs `channels setup slack --json`, and the person
pastes the tokens on a local page. `fastagent dev` runs the setup itself the first time.

| Credential | Used for | Needed for |
|---|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-…`) | everything the bot sends and reads | both ways |
| `SLACK_APP_TOKEN` (`xapp-…`) | opening the Socket Mode connection | Socket Mode |
| `SLACK_SIGNING_SECRET` | checking each webhook request | webhook |

**Leave token rotation off** (it is off in the app setup creates): it cannot be turned off again, and a rotating
(`xoxe.…`) token is refused. If it is on, create the app again from the setup's link.

<details><summary>Creating the app by hand</summary>

Bot Token Scopes: `app_mentions:read`, `assistant:write`, `chat:write`, `files:read`, `files:write`, `im:history`,
`reactions:write`, `users:read`, plus `channels:history`, `groups:history`, `mpim:history` for group context. Turn on
**Agents**. Subscribe to `app_home_opened`, `app_context_changed`, `app_mention`, `message.im`, `message.channels`,
`message.groups`, `message.mpim`. Then run `channels setup slack` and paste the tokens.

</details>

## Socket Mode or webhook

| | Needs | Used by default in |
|---|---|---|
| Socket Mode | the app-level token, no public URL | `dev` |
| Webhook at `POST /slack` | the signing secret, a public URL | `start` and deployments |

Change it with `channels.slack.ingress`. An app in Socket Mode receives only over the socket, so give each instance
that uses webhooks (a deployment) its own app: `channels setup slack --config prod.json`. A webhook app's
**Request URL** is yours to set under Event Subscriptions, at `<your URL>/slack`; `deploy` prints it.

If Socket Mode connects but nothing answers, Socket Mode may be off in the app's settings
([troubleshooting](troubleshooting.md#slack-socket-mode-is-connected-but-nothing-answers)).

## When it answers

- **DMs**: every message. Each top-level DM starts a thread with its own session.
- **Channels**: an `@mention`. The answer goes in a thread under it, and that thread is the conversation.
- **In a thread it took part in**: a bare reply too, while only one person talks there. Once a second person speaks,
  it needs a mention again.
- A message that mentions only other people is discussion, not a question.

Before answering, it reads what was said in the place since its last answer (by name, newest first, bounded). Invite
the app only to channels it may read. The `slack-threads` tool lets the agent list and read other threads of the
channel it was asked in.

A message that arrives while the agent works is passed to the running work; if both are answered together, one answer
is sent. While a turn runs the asker's message shows 👀, then ✅.

## Stopping a turn

A DM or mention whose whole text is `stop` or `cancel` stops the running turn.

## Files and images

Images reach the model as images (it must support vision). Other files are saved under
`<state root>/channels/slack/files/` and their paths given to the agent (up to 20 MB each). A file the asker attached
that cannot be read fails the turn visibly.

## Rendering

- `rendering: "native"` (default) streams into the thread and shows each tool call as a short line. These lines stay
  in the message.
- `rendering: "classic"` edits one message at most every 3 seconds and settles into the answer alone. Use it for apps
  without Agent features, or for replies at channel top level.

Replies use standard Markdown, neutralize `<!channel>`-style pings, and continue in new messages past Slack's length
limit.

## Sending from schedules (`slack_send`)

A schedule or a wake-up has no thread to reply in: its prompt names the destination, and the agent sends with
`slack_send` (text or one file). A user id (`U…`) sends a DM:

```ts
// src/schedules/growth-notes.ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  prompt: "Summarize yesterday's growth notes and send them with slack_send to user U0123456789.",
});
```

In a chat turn the reply is sent for you; calling the tool too posts twice. `fastagent add slack` again updates the
tools and keeps your channel file.

## The channel file

```ts
import { byIngress, needs } from "@fastagent-sh/fastagent";
import { type SlackChannelOptions, slackChannel, slackSocketChannel } from "@fastagent-sh/fastagent/slack";

// Your policy, the same whichever way the channel receives.
const policy: Pick<SlackChannelOptions, "rendering" | "onError"> = {
  rendering: "native", // native Agent stream with inline tool traces; "classic" is the compatibility renderer
  // aiDisclaimer: "AI-generated; verify important information.", // optional policy footer
  // welcome: "Custom first-run DM greeting", // sent once on first DM open; false disables (default: generic)
  // reactionAck: false, // disable the 👀→✅ ack on the user's message (default on; needs reactions:write)
  // No session modes: an answer attaches to its question with a thread, and that thread is the conversation.
  onError: (failed) => `⚠️ ${failed.details}`, // development transparency
};

export default byIngress({
  webhook: needs(["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], (secrets) =>
    slackChannel({ botToken: secrets.SLACK_BOT_TOKEN, signingSecret: secrets.SLACK_SIGNING_SECRET, ...policy }),
  ),
  connection: needs(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], (secrets) =>
    slackSocketChannel({ botToken: secrets.SLACK_BOT_TOKEN, appToken: secrets.SLACK_APP_TOKEN, ...policy }),
  ),
});
```

`welcome` sets the one-time greeting on a user's first DM (`false` turns it off). `reactionAck` sets or turns off the
👀/✅ reactions. `route(envelope)` replaces the answering policy: return `null` to ignore, or
`{ conversation?, channelId?, threadTs?, text? }` (`threadTs: null` sends at top level). `onError(failed)` sets what the
user sees when a turn fails; show `failed.details` only to developers.

## Data and limits

- An accepted message is answered after a restart, at least once: a tool may run twice.
- One workspace per app. No Marketplace distribution.
- Edits and deletions do not change what a session already holds.
- AgentCore resets the channel's state on every deploy.
