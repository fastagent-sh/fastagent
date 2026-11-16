---
title: Slack channel
description: "Run an agent as a Slack app: create the app, Socket Mode, when it answers, reading history, files, streaming, and sending from schedules."
status: current
---

# Slack channel

The agent answers as a Slack app, in threads, streaming with Slack's native Agent messages.

## Set it up

Declare it in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { slack } from "@fastagent-sh/fastagent/slack";

export default defineAgent({ channels: { slack: slack() } });
```

```bash
fastagent channels setup slack   # creates the app from a link; paste its tokens
fastagent dev                    # Socket Mode: no public URL needed
```

`channels setup slack` opens Slack's *create an app* page with everything filled in:
1. Pick the workspace, click **Create**, then **Install App → Install to Workspace → Allow**.
2. Paste the **Bot User OAuth Token** (`xoxb-…`).
3. Paste the **App-Level Token**: Basic Information → App-Level Tokens → *Generate*, scope `connections:write`.

Each value is checked with Slack before it is kept. A coding agent runs `channels setup slack --json` (exit 2 with the
manifest link and env var names until the owner puts them in `.secrets/.env` or runs `channels setup slack` in a
terminal). `fastagent dev` runs the setup itself the first time.

| Credential | Used for |
|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-…`) | everything the bot sends and reads |
| `SLACK_APP_TOKEN` (`xapp-…`) | opening the Socket Mode connection |

**Leave token rotation off** (it is off in the app setup creates): it cannot be turned off again, and a rotating
(`xoxe.…`) token is refused. If it is on, create the app again from the setup's link.

<details><summary>Creating the app by hand</summary>

Bot Token Scopes: `app_mentions:read`, `assistant:write`, `chat:write`, `files:read`, `files:write`, `im:history`,
`reactions:write`, `users:read`, plus `channels:history`, `groups:history`, `mpim:history` for reading history. Turn on
**Agents**. Subscribe to `agent_session_stopped`, `app_home_opened`, `app_context_changed`, `app_mention`, `message.im`,
`message.channels`, `message.groups`, `message.mpim`. Then run `channels setup slack` and paste the tokens.

An app created before FastAgent subscribed to `agent_session_stopped` shows no stop button: add the event under Event
Subscriptions.

</details>

## Socket Mode

The app receives over a Socket Mode connection, in `dev` and in a deployment alike, so it needs no public URL. Slack
hands each event to one of an app's connections, so give a deployment an app of its own:
`fastagent channels setup slack --env-file prod.env`.

`slackChannel({ botToken, signingSecret })` receives by the Events API at `POST /slack` instead, verified with the app's signing secret. FastAgent
does not set its Request URL: set it under Event Subscriptions yourself, and turn Socket Mode off.

If Socket Mode connects but nothing answers, Socket Mode may be off in the app's settings
([troubleshooting](troubleshooting.md#slack-socket-mode-is-connected-but-nothing-answers)).

## When it answers

- **DMs**: every message. Each top-level DM starts a thread with its own session.
- **Channels**: an `@mention`. The answer goes in a thread under it, and that thread is the conversation.
- **In a thread it took part in**: a bare reply too, while only one person talks there. Once a second person speaks,
  it needs a mention again.
- A message that mentions only other people is discussion, not a question.

The agent reads what was said in the channel, DM or thread it was asked in with `slack_history`, read from Slack when it
asks, people by name. A message that opened a thread says so, and the tool reads that thread by its id. Invite the app
only to channels it may read.

A message that arrives while the agent works is passed to the running work; if both are answered together, one answer
is sent. While a turn runs the asker's message shows 👀, then ✅.

## Stopping a turn

Slack's stop button on a working thread stops the running turn, and so does a DM or mention whose whole text is `stop`
or `cancel`.

## Files and images

Images reach the model as images (it must support vision). Other files are saved under
`<state root>/channels/slack/files/` and their paths given to the agent (up to 20 MB each). A file the asker attached
that cannot be read fails the turn visibly.

## Streaming

The answer streams into its thread as Slack's native agent message, and shows each tool call as a short line, which
stays in the message. The thread's agent session shows Slack's working indicator and stop button while the turn runs.
A stream holds at most 10 minutes and 12,000 characters, so a longer answer continues in a new message of the same
thread. A custom route that answers at a channel's top level (`threadTs: null`) cannot stream: its answer is posted
once it is done.

Replies use standard Markdown and neutralize `<!channel>`-style pings.

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

In a chat turn the reply is sent for you; calling the tool too posts twice. The tools are named after the channel: a
channel declared as `support` gives `support_send` and `support_history`.

## Options

```ts
slack({
  // aiDisclaimer: "AI-generated; verify important information.", // optional policy footer
  // welcome: "Custom first-run DM greeting", // sent once on first DM open; false disables (default: generic)
  // reactionAck: false, // disable the 👀→✅ ack on the user's message (default on; needs reactions:write)
  onError: (failed) => `⚠️ ${failed.details}`, // development transparency
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
