---
title: Slack channel
description: "Serve an agent as a Slack-native Agent over Socket Mode or the signed Events API, with durable threads/context, native streams with inline tool traces, and file IO."
status: current
---

# Slack channel

The first-party Slack channel receives Slack's events one of two ways, the instance's choice
([Socket Mode or webhook](#socket-mode-or-webhook)): over a [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
WebSocket the process opens, so it needs no public URL; or at `POST /slack` by the [HTTP Events API](https://docs.slack.dev/apis/events-api/using-http-request-urls/),
verifying Slack's [raw-body request signature](https://docs.slack.dev/authentication/verifying-requests-from-slack/). Either
way it persists accepted work before acknowledging, serializes turns per conversation, and renders threaded replies with
Slack's native [`chat.*Stream`](https://docs.slack.dev/reference/methods/chat.startStream) Agent APIs. A rate-limited
edited-message renderer remains available for top-level replies and compatibility use.

## Add the channel, then set up its app

```bash
fastagent add slack            # the program: the channel file and its tools
fastagent channels setup slack # the app, and this instance's credentials for it
fastagent dev                  # no tunnel, no public URL
```

`dev` runs the setup itself the first time it finds the channel without credentials, at a terminal; run it yourself to do
it ahead of time or again.

`add slack` changes the program only. It creates

```txt
src/channels/slack.ts       # the channel, both ways of receiving, + policy
src/tools/slack-send.ts     # text and external-upload file tool
src/tools/slack-threads.ts  # reads the threads of the channel a message was asked in
```

and lists the variables they read in `.secrets/.env.example`. It asks nothing and creates no app.

`channels setup slack` sets up the app for **one instance** and keeps its credentials in that instance's value file:

1. It opens Slack's *create an app* page with the app's manifest filled in (scopes, event subscriptions, the Socket Mode
   switch, token rotation off). You pick a workspace and click **Create**, then **Install App → Install to Workspace →
   Allow**, and paste the **Bot User OAuth Token**.
2. For Socket Mode it then asks for an **App-Level Token**: Basic Information → App-Level Tokens → *Generate Token and
   Scopes*, scope `connections:write`. For a webhook it asks for the **Signing Secret** (Basic Information → App
   Credentials) instead.
3. Each value is checked with Slack before it is kept: the bot token with `auth.test`, the app-level token by opening a
   connection with it. The signing secret can only be checked by shape; the first signed request will say.

It is safe to run again: a value already set that Slack still accepts is kept, one it refuses is asked for again. The
values are typed with hidden input at a terminal. A coding agent runs `channels setup slack --json`: the person is sent
a page on this machine (`127.0.0.1`) to paste them, so a token never passes through the agent's conversation and no
tunnel is opened.

The way the app receives is `--ingress webhook|connection`, else the instance's `channels.slack.ingress`, else
Socket Mode for the development instance and webhook for any other (a host that scales to zero is woken by a request).
A deployment is another instance: `channels setup slack --config prod.json` sets up an
app of its own (a Socket Mode app receives over the socket alone, so two instances never share one) and writes its
values to that file. Webhook apps are created with a placeholder Request URL (`http.publicUrl` when the configuration
names one): Slack allows an app whose URL does not answer yet. Once the instance is served, open **Event Subscriptions**,
set the URL (`<where it is served>/slack`), and Slack verifies it as you save. `fastagent channels setup slack
--record-url --config prod.json` then records it for later deploys.

The app is created for a single workspace (internal use), not for Marketplace distribution, and with Slack's Agent
features, which a free workspace has too. The channel falls back to the compatibility renderer where one is missing.

## Credentials

| Credential | Made by | Used for | Lives in |
|---|---|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-…`) | Install App | Everything the channel sends: replies, files, `slack-send`, history reads, `auth.test` | The instance's value file |
| `SLACK_APP_TOKEN` (`xapp-…`, `connections:write`) | Basic Information → App-Level Tokens | Opening the Socket Mode connection, and nothing else | The instance's value file; Socket Mode only |
| `SLACK_SIGNING_SECRET` | Basic Information → App Credentials | Verifying each inbound webhook request | The instance's value file; webhook only |

The bot token sends and the app-level token (or the signing secret) receives. The app's Client ID and Client Secret are
for OAuth installation of an app distributed to other workspaces and are not used. Dev's value file is `.secrets/.env`;
a deployment has none by default: `channels setup slack --config <file> --env-file <values>` keeps it in the file you name, and
`fastagent secrets push <host> --env-file <values>` sets it on the target.

Bot-token rotation is off in the manifest. Do not turn it on: it cannot be turned off again, and FastAgent does not
support it.

### If token rotation is on

`channels setup slack` and the channel refuse a rotating (`xoxe.…`) bot token. Create the app again from the setup's
link, which leaves rotation off, and set it up again with the new app's tokens; remove the old app in the Slack console
when the new one answers.

### Manual setup

An app made by hand works the same: give it these Bot Token Scopes (`app_mentions:read`, `assistant:write`,
`chat:write`, `files:read`, `files:write`, `im:history`, `reactions:write`, `users:read`, and for group context
`channels:history`, `groups:history`, `mpim:history`), turn on the **Agents** feature (native mode needs `assistant:write`
and `agent_view`; an app without them uses `rendering: "classic"`), subscribe `app_home_opened`, `app_context_changed`,
`app_mention`, `message.im`, `message.channels`, `message.groups` and `message.mpim`, then run `channels setup slack`
and paste its tokens.

## Socket Mode or webhook

`slackSocketChannel` receives over Slack's Socket Mode: the process opens a WebSocket to Slack, so there is no Request URL,
no tunnel and no signing secret. The scaffolded channel offers both ways:

```ts
export default byIngress({
  webhook: needs(["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], (secrets) =>
    slackChannel({ botToken: secrets.SLACK_BOT_TOKEN, signingSecret: secrets.SLACK_SIGNING_SECRET, ...policy }),
  ),
  connection: needs(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], (secrets) =>
    slackSocketChannel({ botToken: secrets.SLACK_BOT_TOKEN, appToken: secrets.SLACK_APP_TOKEN, ...policy }),
  ),
});
```

The instance's `channels.slack.ingress` picks the way (unset: `dev` uses Socket Mode, everything else the webhook).
Both take the same policy options (`rendering`, `route`, `onError`, …) and answer the same way. An app in Socket Mode
receives over the socket **alone** (turning it on stops HTTP delivery), so keep a separate app for each instance that
receives by webhook, a deployment included. Apps that use Socket Mode cannot be listed in the Slack Marketplace.

The connection is refreshed by Slack every few hours; FastAgent opens the next one before the old one goes, so no event
falls between them, and it pings the socket and reconnects when one stops answering. A lost network is retried with a
growing wait. What retrying cannot fix ends the serve with its reason: a refused token (`invalid_auth`,
`token_revoked`, …), Socket Mode turned off for the app (`link_disabled`), or a start that cannot connect. An event
that cannot be taken (Slack authentication unavailable) is left unacknowledged, and Slack sends it again.

"Ready" means Slack accepted the token, not that events flow: with Socket Mode off in the app's settings a new
connection is accepted and receives nothing, and nothing says so (see
[troubleshooting](troubleshooting.md#slack-socket-mode-is-connected-but-nothing-answers)).

## Scaffolded channel

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

Required credentials are validated when serving activates the module, so deployment inspection remains
import-safe while a live endpoint never runs without verification.

On a user's first DM open (`app_home_opened` with `tab: "messages"`), the channel posts a one-time
plain-Markdown welcome. Set `welcome` to customize the text or `false` to disable it. No interactive
buttons are used yet, so the message stays plain until an interactivity endpoint exists.

While a turn runs, the channel adds a 👀 reaction to the user's triggering message and swaps it for ✅ on
completion. Set `reactionAck` to override the emoji names or `false` to disable it. This needs the
`reactions:write` scope; a missing scope degrades to no ack (the reply is unaffected).

## Routing and conversations

The default route answers:

- every human `message.im` DM;
- human `app_mention` events in channels;
- unmentioned human replies in a thread the Agent takes part in while exactly one human does (see
  [Group context](#group-context)) — an event the app receives only with the group message subscriptions.

Bot messages, edits, deletes, hidden events, and service subtypes are ignored. `file_share` and
`thread_broadcast` are new human content and remain eligible. Overlapping `app_mention` and `message.*`
deliveries are deduplicated by logical message identity `(team, channel, ts)`, not only `event_id`.

Default conversations, each with a session of its own, which the channel creates the first time it is asked there and
records in `<state root>/channels/slack/sessions.json`:

| Message | Conversation |
|---|---|
| Top-level DM | `<team>:<channel>:<ts>` |
| DM thread continuation | `<team>:<channel>:<root_ts>` |
| Top-level group mention | `<team>:<channel>:<ts>` |
| Group thread continuation | `<team>:<channel>:<root_ts>` |

There are no session modes. Slack has no quote primitive, so the only way to attach an answer to its
question is a thread on it (`thread_ts = incoming.thread_ts ?? incoming.ts`) — and that thread is then
the *place*, so it carries the memory ([design note](design/participant-model.md)). Native streaming
additionally requires a thread, but the shape does not depend on the renderer: `classic` attaches its
answer the same way.

Follow-ups therefore live in the thread, which is also where Slack's own conventions put them. Two
different threads run concurrently. A message in a thread whose agent is busy is sent at once and steered into the running work; if the agent takes it before the run ends, both messages share one answer, which is delivered once.

Override `route(envelope)` for custom policy. It returns `null` to ignore or a `SlackRoute` with optional
`conversation`, `channelId`, `threadTs`, and `text`. `threadTs: null` explicitly sends at channel top level.
Supplying a custom route disables the default thread-participation and unsummoned-context admission policy; the
custom route is then the complete authority.

## Group context

Given the group message subscriptions (the default app), the Agent behaves as a participant of the channel
([design note](design/participant-model.md)): it answers a bare message in a thread while it takes part
and **has not heard a second human** there. Mentioning it inside a thread is the bootstrap — it answers,
which makes it a participant, and later bare replies reach it without the name. When a second person
speaks in that thread, addressing is ambiguous again and it returns to requiring a mention while still
listening.

A bare message that @-mentions only other people is discussion, never an ask: the Agent stays quiet,
and the message reaches it, like any other unsummoned one, in the next turn it answers there
([Place history](#place-history)). Only an absent mention — or one naming the Agent — reaches the rule above.

Both halves are what this channel *heard*, not a claim about who is really in the thread: nothing is
read back from Slack before the ACK, so acceptance stays synchronous and a thread the Agent joined before this
deployment — or before a lost `thread-participants.json` — takes one mention to re-enter. That is the
same bootstrap every thread starts with and it self-heals in one message. A consequence worth knowing:
a thread where several people are present but only one has spoken *while the Agent was listening*
counts as two-party.

### Place history

A place is a channel's or DM's top level, or a thread in one. When a turn runs, the channel reads the place's
messages from Slack (`conversations.history` for the top level, `conversations.replies` for a thread) and folds what
was said since the ask its session was last sent into the prompt, as `[recent discussion here: …]`. A session's first turn in a
place reads its newest 20 messages: every top-level ask in a channel opens a thread with a session of its own, so each
one starts there, and discussion that an earlier ask's session already read is read again by the new session. The read ends at the turn's own ask: an ask queued behind it, and anything said
after it, are read by their own turn. Within that, the read leaves out what the session already holds: every message
the channel posted as a turn's output (answers, stop feedback), and the messages it took as input. An
answer is left out of the place it lands in: the Agent answers a top-level ask in a thread under it, so the answer
belongs to that thread. What the Agent posted itself, with `slack-send` from a schedule for example, stays, labelled
`you`, so a later "what did point 3 mean?" has it.

- People are shown by name (`users.info`, the `users:read` scope), looked up only for the speakers a fold shows and
  reused for 10 minutes; a person with no name, or a failed lookup, is shown by user id (`user U…`). Other bots are
  shown by name (`bot <name>`), with what an integration put in legacy attachments. Slack's own messages (joins, topic
  changes) and messages with nothing to show are left out.
- An app installed before `users:read` was in the manifest shows everyone by user id, and the channel says so once.
  Add the scope under the app's OAuth & Permissions → Bot Token Scopes (an app `channels setup slack` creates has it),
  then Reinstall to Workspace. A running channel
  asks again every 10 minutes, so names appear without a restart, unless the reinstall issued a new Bot Token: then
  update `SLACK_BOT_TOKEN` and restart.
- A post written as Markdown (every answer and `slack-send` post) is read from its blocks, tables included; Slack's
  plain-text rendering of such a post drops its tables.
- The fold is bounded: 4,000 characters, 280 per message (2,000 for the Agent's own post), the newest kept, and what it
  leaves out is counted in the prompt. A place with more than 50 messages since its last answer says earlier ones
  are not shown.
- A read that fails costs the turn its discussion, never the turn: the prompt says the discussion could not be read,
  a warning is logged, and the next turn reads the same messages again. A rate-limited read is not waited out, since
  the turn waits for it.
- A direct message is a place too: its turns read what was posted there since the last answer, which in practice is
  what the agent sent there itself with a send tool (a schedule's digest). Turns from a custom `route` read no history.

This deliberately lets the app read messages in channels where it is installed; invite it only to channels
it may read. State is local to the deployment and gitignored from git, but operators still own
retention/privacy policy.

### Reading threads

`fastagent add slack` also scaffolds `src/tools/slack-threads.ts`. In a channel turn, the agent calls it with no
arguments to list the channel's recent threads, and with a thread id (its first message's `ts`) to read one. That is
how a question about another thread ("was the deploy failure resolved?") reaches what a person wrote there.

- Only the channel the turn was asked in: the tool takes no channel id. In a DM, a scheduled turn or a turn from a
  custom `route` it answers that it cannot read threads.
- The list is the threads among the channel's newest 100 messages, by their last reply, at most 20.
- A read is the thread's newest 20 messages, bounded like the place history above, the agent's own answers included.
- An agent created before this release gets the tool by running `fastagent add slack` again: it keeps the channel
  file and writes the package's tools.

## Inbound files

Events persist stable Slack file IDs—never temporary private URLs. At dequeue, the channel calls
`files.info`, then:

- downloads images as vision `prompt.images`;
- writes ordinary files under `<state root>/channels/slack/files/c-<channel>/` (`c-` plus the URL-encoded channel id) and adds their absolute paths to the prompt;
- sends the Bot token on private-file downloads;
- accepts only HTTPS Slack-owned download/redirect hosts;
- enforces a streaming 20 MB cap and a download timeout;
- sanitizes names and prefixes them with the Slack file ID.

A current-message file is primary input: an inaccessible, deleted, external-without-bytes, not-yet-ready,
oversized, or Slack Connect-denied file produces a visible failed turn instead of silently running without
it. Files from the earlier discussion degrade individually; readable siblings still load and the prompt counts missing
ones.

The selected model must support vision for image inputs. Canvas and other remote/external file modes are
usable only when Slack exposes authenticated downloadable bytes.

## Agent rendering and `slack-send`

`rendering: "native"` is the default. For a threaded target the channel:

1. sets the Slack Agent loading status (and a title for a new DM thread);
2. starts a native stream with `chat.startStream`;
3. appends standard Markdown with `chat.appendStream`;
4. maps each `tool_started` to a compact inline Markdown trace containing the humanized tool identifier
   (`mcp__github__create_issue` → `Github: create issue`) and a bounded single-line argument summary
   (normally the command, path, or query); an errored `tool_result` appends one line naming the failed
   call, never its output, while a successful one appends nothing — an emitted line cannot be flipped
   to a checkmark, so the next trace (or the answer) is the completion signal;
5. closes the stream with `chat.stopStream`.

Raw model `thinking` and tool output are not customer-facing. The former is represented by Slack's
loading state; argument summaries are whitespace-collapsed, Unicode-safe truncated, and
notification-control sanitized. A native stream cannot be retracted, so unlike every other renderer
these traces stay in the delivered message next to the answer — including that argument summary, which
is the tool call's first string field and may name whatever the agent passed there. There is no
answer-only native stream: `rendering: "classic"` does settle into the answer alone, but it also gives
up native streaming — process visibility and transport are one choice here, not two. Agent replies also
neutralize Slack notification controls such as `<!channel>`; deliberate outbound mentions belong in the
explicit `slack-send` tool. Successful replies omit repetitive disclaimers by default; configure an
`aiDisclaimer` string only when workspace policy requires a per-message footer. Native channel streams carry the triggering user/team recipient IDs required by Slack. DM `app_context` entities are included in
the Agent prompt when Slack supplies them.

Standard Markdown—not Slack-specific `mrkdwn`—is the output contract. Each API write stays below Slack's
12,000-character Markdown limit. Link unfurls remain disabled. Very long answers continue in additional
Markdown messages.

`rendering: "classic"` retains one `💭 Thinking…` message and updates it no more than once every three
seconds. While a tool runs, its line shows the tool's latest status (`tool_progress`: for `bash`, the last line
of its output so far), clipped to one line and notification-control sanitized like the rest of the preview; the
native stream does not show it. The settled reply is the answer alone, but intermediate frames are visible while
they last and to `message_changed` subscribers ([what that exposes](channels.md#operational-notes)). A native-configured turn also uses this renderer when a custom route sends
at channel top level, because Slack native streams must reply to a parent user message. This fallback is
logged. Agent/API failures remain visible in the thread or operator logs.

The scaffolded `slack-send` tool supports text or one local file. **Do not use it to answer the current
turn** — the channel already delivers the reply, so calling the tool as well posts it twice; its
scaffolded description says so. It is the delivery path for turns no channel is carrying: a cron
schedule or a self-scheduled wake-up. A successful call names what it wrote (the message `ts`, or the
file id) so the agent can record the outcome.

The destination is what the turn's instruction names. A user id (`U…`) as `channelId` messages that
user's DM — Slack opens it under `chat:write`, no `conversations.open` needed — and the result reports
the DM channel id (`D…`), which is what a file upload to that user needs. A schedule that reports to its
owner therefore needs only the owner's user id, named in its prompt:

```ts
// src/schedules/growth-notes.ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  prompt: "Summarize yesterday's growth notes and send them with slack_send to user U0123456789.",
});
```

The tool holds no transport of its own. It calls `slackTransport(SLACK_BOT_TOKEN)` from
`@fastagent-sh/fastagent/slack`, which hands back the mounted channel's Slack transport for that bot — the same
token, `apiBaseUrl`, Markdown splitting and rate-limit handling the channel replies with. With no
channel mounted (`fastagent invoke`) the transport is built from `SLACK_BOT_TOKEN` against
Slack's default API base. `src/tools/slack-send.ts` is the package's and is rewritten by every `add slack`.

File mode uses Slack's current [external upload
protocol](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/):

```txt
files.getUploadURLExternal
→ upload bytes to upload_url
→ files.completeUploadExternal
```

`channel_id` and the parent `thread_ts` are supplied to the completion call. Upload delivery is
at-least-once: if Slack commits completion but the network response is lost, an explicit retry may post a
duplicate. The tool does not hide that uncertainty with an automatic final-step retry.

## Stopping a running turn

A DM or @mention whose whole message is "stop" or "cancel" aborts that conversation's active turn
instead of becoming a turn. Asks not yet taken are independent and keep running — stop the next one when it
starts. No configuration is needed: stopping the running turn is part of serving.

## Durability and state

Slack state lives under:

```txt
<state root>/channels/slack/
├── turns.json
├── seen.json
├── thread-participants.json
├── asks.json
├── history.json
└── files/
```

`asks.json` holds, per conversation, its newest asks (message key and `ts`); the Agent says which one the session holds,
and a turn's read starts after it. Losing it costs one re-read of a place's newest 20 messages. `history.json` holds,
per place, the messages turns posted there, which the next read leaves out; losing it costs the Agent's earlier answers
in one read.

`files/` holds downloaded inbound files, one directory per channel. They are kept — the path the agent
was given stays readable for as long as the conversation can refer back to it — and FastAgent never
prunes them, so a workspace that receives a lot of files wants a volume sized for that.

`thread-participants.json` records what the Agent HEARD in each group thread — the humans it saw speak
(capped at two, since the rule only asks whether a second one exists) and whether it has answered
there. It is written for **every group thread the channel can see**, including behind a custom route,
where the summon rule never reads it: a route is configuration and the record outlives a change to it,
so gating the write would leave a thread marked as answered-in while the humans who spoke in the
intervening window went unrecorded, and the Agent would then speak into a crowd. Deleting the file is
safe; each thread then costs one mention to re-enter.

An accepted turn is persisted before the 200 ACK and replayed after an interrupted process. Its message was sent with
the Slack message's identity as its key, so a replay reads the message already sent instead of sending a second one.
Replay is still at-least-once: side-effecting Agent tools must be idempotent or tolerate duplication. A turn whose reply
was already generated is not re-run — the answer is recorded before it is sent, so an interrupted or
failed delivery is re-sent on the next start (a duplicate is preferred to a lost
answer). The execution ceiling drops a turn that repeatedly starts without finishing and notifies the
thread instead of crash-looping forever — unless its answer was already recorded, which is sent instead. One process owns the state root: a second `dev` or `start` of the same agent is refused.

## Production

`fastagent deploy docker|fly|railway|agentcore` discovers Slack and checks that the deployment has the values its way of
receiving reads. A deployment receives by webhook, so it needs `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, from an app of
its own (`channels setup slack --config prod.json`). Slack's Request URL is the app's
page, which no credential on the box can change: `deploy` prints the URL to set under Event Subscriptions, and the box
confirms it once Slack reaches it there ([Deploy](deploy.md#chat-channels)). Resident hosts need durable storage and one
replica. [AgentCore resets its storage on every deploy](deploy.md#aws-bedrock-agentcore), so thread state and delivery
dedup start blank after each one; both secrets ride the runtime environment and are unaffected.

## Current boundaries

- One Slack workspace installation/token per channel instance; no OAuth installation store or Marketplace multi-tenancy.
- Edited/deleted messages do not change what a session already holds. A later read of the place sees them as they are then.
- Slack's Agent messaging experience is enabled for apps `channels setup slack` creates and cannot be switched back to the legacy Assistant experience.
- `rendering: "classic"` exists for plans/apps without native Agent streaming and for intentional top-level replies.
