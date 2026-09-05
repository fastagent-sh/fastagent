---
title: Slack channel
description: "Serve an agent as a Slack-native Agent with signed Events API ingress, durable threads/context, native streams with inline tool traces, and file IO."
status: current
---

# Slack channel

The first-party Slack channel uses Slack's [HTTP Events API](https://docs.slack.dev/apis/events-api/using-http-request-urls/) at `POST /slack`. It verifies Slack's [raw-body request signature](https://docs.slack.dev/authentication/verifying-requests-from-slack/), persists accepted work before ACK, serializes turns per session, and renders threaded replies with Slack's native [`chat.*Stream`](https://docs.slack.dev/reference/methods/chat.startStream) Agent APIs. A rate-limited edited-message renderer remains available for top-level replies and compatibility use.

## Add the channel

```bash
fastagent add slack
```

`--group-behavior context|mentions` decides what the created app is allowed to hear. `context`
(default) subscribes the channel/private-channel/MPIM message streams, which is what lets the Agent
take part in a thread and read recent discussion ([Group context](#group-context)). `mentions` asks for
`app_mention` and DMs only — least privilege, for a workspace that will not approve an app reading
channel history. The runtime has one behavior either way; what differs is which events Slack delivers.

The command creates:

```txt
channels/slack.ts       # signed Events API adapter + policy
tools/slack-send.ts     # text and external-upload file tool
```

It also adds `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and optional rotating-bot credential placeholders
to `.env.example` and, by default, starts single-workspace internal-app onboarding.

## Internal-app onboarding

Slack's [App Manifest API](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) requires a user/workspace **App Configuration Token**. The command opens
[Your Apps](https://api.slack.com/apps); generate one under **Your App Configuration Tokens**, then paste
its access and refresh tokens into the hidden prompts. These configuration credentials can manage apps
owned by your user in that workspace, so FastAgent:

- stores them only in owner-readable (`0600`) `<state root>/channels/slack/onboarding.json`;
- never puts it in `.env`, an image, a deploy secret, argv, or logs;
- uses it locally to rotate the 12-hour access token and update the App Manifest.

Slack labels configuration-token rotation / Manifest management as a control-plane API surface that may
change. FastAgent treats every failure as visible and keeps `--no-onboard` plus the manual console path as
the fallback; it never silently claims that an unverified Request URL was installed.

The command then:

1. starts a temporary Cloudflare Quick Tunnel (`cloudflared` is required);
2. creates the internal app from a mode-specific manifest;
3. enables Slack's irreversible `agent_view`, native Agent streaming, suggested prompts, the writable Messages tab, scopes, and Events API subscriptions;
4. opens [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/), validates its `state`, exchanges the code, and installs into one workspace;
5. writes the Signing Secret plus the rotating bot access/refresh token, expiry, OAuth client ID, and
   client secret to the workspace `.secrets/.env`.

App creation is an irreversible persisted boundary. If OAuth is cancelled or the process stops afterward,
re-run `fastagent add slack`; it resumes the same App rather than creating another. Once installed, run:

```bash
fastagent dev --tunnel
```

The temporary onboarding URL is replaced automatically with the live `<quick-tunnel>/slack` Request URL.
Each later Quick Tunnel receives the same update. `deploy fly --run`, `deploy railway --run`, and Docker
`--run --tunnel` likewise update the deployed URL from the local machine without sending the configuration
token to the host. Invite the App to each channel it should read.

This is an internal, single-workspace installation—not Marketplace/multi-workspace OAuth token storage.
Slack may require a paid plan or Developer Program sandbox for platform AI features. If native Agent
features are unavailable, use the manual path with `rendering: "classic"`; a definitive native capability
rejection also falls back to one compatibility Markdown reply without retrying ambiguous stream writes.

### Manual/scaffold-only setup

Use `fastagent add slack --no-onboard` to create only the channel/tool files. In that mode, create the App
in Slack yourself and configure these base Bot Token Scopes:

```txt
app_mentions:read
assistant:write
chat:write
im:history
files:read
files:write
reactions:write
```

A `context` app additionally needs `channels:history`, `groups:history`, and `mpim:history`. Native mode
requires `assistant:write` and the **Agents** feature with the Agent messaging experience (`agent_view`);
a manually configured classic-only app may omit those two Agent capabilities. Subscribe `app_home_opened`,
`app_context_changed`, `app_mention`, and `message.im`; a `context` app additionally subscribes
`message.channels`, `message.groups`, and `message.mpim`. Set `https://<host>/slack` under Event
Subscriptions while FastAgent is running,
then put the Bot Token and Signing Secret in `.env`. Without local onboarding state, tunnel/deploy commands
print this manual Request URL instead of claiming registration succeeded. On the machine that onboarded the
app, `fastagent add slack --replace-config` replaces an expired or revoked App Configuration token pair
without touching the installed app or its runtime credentials.

## Scaffolded channel

```ts
import { slackChannel } from "@fastagent-sh/fastagent/slack";

export default slackChannel({
  botToken: process.env.SLACK_BOT_TOKEN ?? "",
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  botRefreshToken: process.env.SLACK_BOT_REFRESH_TOKEN || undefined,
  clientId: process.env.SLACK_CLIENT_ID || undefined,
  clientSecret: process.env.SLACK_CLIENT_SECRET || undefined,
  botTokenExpiresAt: process.env.SLACK_BOT_TOKEN_EXPIRES_AT
    ? Number(process.env.SLACK_BOT_TOKEN_EXPIRES_AT)
    : undefined,
  rendering: "native", // native Agent stream with inline tool traces; "classic" is the compatibility renderer
  // aiDisclaimer: "AI-generated; verify important information.", // optional policy footer
  // welcome: "Custom first-run DM greeting", // sent once on first DM open; false disables (default: generic)
  // reactionAck: false, // disable the 👀→✅ ack on the user's message (default on; needs reactions:write)
  // No session modes: an answer attaches to its question with a thread, and that thread is the session.
  onError: (failed) => `⚠️ ${failed.details}`, // development transparency
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

## Routing and sessions

The default route answers:

- every human `message.im` DM;
- human `app_mention` events in channels;
- unmentioned human replies in a thread the Agent takes part in while exactly one human does (see
  [Group context](#group-context)) — an event the app receives only with the group message subscriptions.

Bot messages, edits, deletes, hidden events, and service subtypes are ignored. `file_share` and
`thread_broadcast` are new human content and remain eligible. Overlapping `app_mention` and `message.*`
deliveries are deduplicated by logical message identity `(team, channel, ts)`, not only `event_id`.

Default sessions:

| Message | Session |
|---|---|
| Top-level DM | `slack:<team>:<channel>:<ts>` |
| DM thread continuation | `slack:<team>:<channel>:<root_ts>` |
| Top-level group mention | `slack:<team>:<channel>:<ts>` |
| Group thread continuation | `slack:<team>:<channel>:<root_ts>` |

There are no session modes. Slack has no quote primitive, so the only way to attach an answer to its
question is a thread on it (`thread_ts = incoming.thread_ts ?? incoming.ts`) — and that thread is then
the *place*, so it carries the memory ([design note](design/participant-model.md)). Native streaming
additionally requires a thread, but the shape does not depend on the renderer: `classic` attaches its
answer the same way.

Follow-ups therefore live in the thread, which is also where Slack's own conventions put them. Two
different threads run concurrently; turns within one are FIFO.

Override `route(envelope)` for custom policy. It returns `null` to ignore or a `SlackRoute` with optional
`session`, `channelId`, `threadTs`, and `text`. `threadTs: null` explicitly sends at channel top level.
Supplying a custom route disables the default thread-participation and unsummoned-context admission policy; the
custom route is then the complete authority.

## Group context

Given the group message subscriptions (the default app), the Agent behaves as a participant of the channel
([design note](design/participant-model.md)): it answers a bare message in a thread while it takes part
and **has not heard a second human** there. Mentioning it inside a thread is the bootstrap — it answers,
which makes it a participant, and later bare replies reach it without the name. When a second person
speaks in that thread, addressing is ambiguous again and it returns to requiring a mention while still
listening.

A bare message that @-mentions only other people is discussion, never an ask: it is buffered like any
other unsummoned message, and the Agent stays quiet. Only an absent mention — or one naming the Agent —
reaches the rule above.

Both halves are what this channel *heard*, not a claim about who is really in the thread: nothing is
read back from Slack, so acceptance stays synchronous and a thread the Agent joined before this
deployment — or before a lost `thread-participants.json` — takes one mention to re-enter. That is the
same bootstrap every thread starts with and it self-heals in one message. A consequence worth knowing:
a thread where several people are present but only one has spoken *while the Agent was listening*
counts as two-party.

Unsummoned human discussion is bucketed by workspace + channel + concrete thread root.
The next answered turn in that place receives a bounded sender-prefixed block. Consumption is durable:

1. persist each background message before webhook ACK;
2. snapshot with `peek` when the turn dequeues;
3. commit exactly that snapshot only when the Agent emits `completed`;
4. retain it on failure/crash, and retain messages that arrive while the turn is running.

This deliberately lets the app read messages in channels where it is installed. Create the app with
`--group-behavior mentions` when that permission or retention boundary is inappropriate: without the
history subscriptions none of the above ever fires. State is local to the deployment and gitignored
from git, but operators still own retention/privacy policy.

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
it. Earlier buffered files degrade individually; readable siblings still load and the prompt counts missing
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
   (normally the command, path, or query); an errored `tool_ended` appends one line naming the failed
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
seconds. A native-configured turn also uses this renderer when a custom route sends
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
owner therefore needs only the owner's user id in its prompt:

```ts
export default defineSchedule({
  cron: "0 9 * * 1-5",
  prompt: "Summarize yesterday's growth notes and send them with slack-send to user U0123456789.",
});
```

The tool holds no transport of its own. It calls `slackTransport(ctx.cwd)` from
`@fastagent-sh/fastagent/slack`, which hands back the mounted channel's Slack transport — the same
Markdown splitting, rate-limit handling, and **current rotating credentials** the channel replies with,
resolved at execute time, never at load. With no channel mounted (`fastagent fire` / `invoke`) the
transport is built from `.env` over the same persisted pair under the state root, so a proactive send
as the first Slack activity after a restart still refreshes and persists correctly. That fallback
uses Slack's default API base: an `apiBaseUrl` set in `channels/slack.ts` reaches the tool only while
the channel is mounted. `tools/slack-send.ts` is the package's and is rewritten by every `add slack`.

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

When the serve runs with `sessionControl: true` (fastagent.config), a DM or @mention whose whole
message is "stop" or "cancel" aborts that conversation's active turn instead of becoming a turn.
Queued asks are independent and keep running — stop the next one when it starts. Without session
control the command answers with a visible "not enabled" notice.

## Durability and state

Slack state lives under:

```txt
<state root>/channels/slack/
├── bot-auth.json       # latest rotating bot access/refresh pair (0600)
├── turns.json
├── seen.json
├── thread-participants.json
├── buffers.json
└── files/
```

`thread-participants.json` records what the Agent HEARD in each group thread — the humans it saw speak
(capped at two, since the rule only asks whether a second one exists) and whether it has answered
there. It is written for **every group thread the channel can see**, including behind a custom route,
where the summon rule never reads it: a route is configuration and the record outlives a change to it,
so gating the write would leave a thread marked as answered-in while the humans who spoke in the
intervening window went unrecorded, and the Agent would then speak into a crowd. Deleting the file is
safe; each thread then costs one mention to re-enter.

The onboarded App Manifest enables Slack token rotation. Before expiry, the runtime exchanges the bot
refresh token, atomically persists the replacement pair in `bot-auth.json`, and uses that durable pair on
later restarts; all four rotation inputs must be configured together. `deploy --run` overlays any newer
local pair onto the deploy secrets; at boot the runtime selects whichever env/persisted pair has the newer expiry.
The channel and the `slack-send` tool share one credential provider per state root, so a refresh
happens once per process however the two interleave. Before refreshing, a provider re-reads
`bot-auth.json` and adopts a newer pair another process wrote (`fastagent fire` beside a running `dev`)
rather than presenting a refresh token that process has already consumed.
One Slack app must have one active FastAgent state lineage: stop local `dev` before running the deployed
copy, or create separate Slack apps for local and production, so two machines never rotate the same
single-use refresh token independently. A manual classic app may still use
a long-lived `SLACK_BOT_TOKEN` by omitting every rotation input.

An accepted turn is persisted before the 200 ACK and replayed after an interrupted process. Replay is
at-least-once: side-effecting Agent tools must be idempotent or tolerate duplication. The execution ceiling
drops a turn that repeatedly starts without finishing and notifies the thread instead of crash-looping
forever. File-backed channel state supports one process/replica only.

## Production

`fastagent deploy docker|fly|railway|agentcore` discovers Slack and carries access/signing secrets plus
configured runtime rotation credentials. For a reachable webhook ingress, `--run` updates the Request
URL using the builder's local onboarding state. Without that state, it reports the required manual
console action. App Configuration tokens stay on the builder. Docker's optional Quick Tunnel URL is
ephemeral; resident hosts need durable storage and one replica. AgentCore uses the
[ingress-session S3 snapshot](deploy.md#aws-bedrock-agentcore). Preserve the single active credential/state
lineage and verify proactive delivery separately from normal channel replies.

## Upgrading from the environment-token `slack-send`

Releases up to 0.20.0 scaffolded a `tools/slack-send.ts` that read `SLACK_BOT_TOKEN` from the
environment, so after the channel's first token rotation every proactive send failed with
`token_expired`. After upgrading the package, re-run `fastagent add slack --no-onboard` in the agent:
it keeps `channels/slack.ts`, `.secrets/.env` and the onboarding state, and rewrites
`tools/slack-send.ts` with the transport-backed version.

## Upgrading from the session-mode releases

`directMessageSession` and `groupMessageSession` are **removed** — placement and session identity
follow from Slack's own primitives (an answer goes in a thread on the ask, and that thread is the
session), which leaves nothing for the options to select. Delete them from `channels/slack.ts`
yourself: nothing rejects them at startup, and the file is loaded as ESM rather than type-checked, so a
leftover option is ignored in silence while placement and the memory boundary change underneath it.

If either was set to `continuous`, both where answers land and how sessions are keyed change with the
removal, and **existing conversation history is not migrated** — every thread starts fresh. The obsolete
`owned-threads.json` is left behind, unread by anything; delete it if you want the state directory clean.

Slack's scaffolded `slack-send` already carried the "do not use this to answer the current turn"
boundary its Feishu and Telegram siblings gained this release, so nothing to paste here.

Behaviour that changes even on the default configuration: a bare reply in a thread is answered while
the Agent takes part and it has not heard a second human there (previously: any thread it had created).
Derivation in [design/participant-model.md](design/participant-model.md) §3 and §12.

## Current boundaries

- HTTP Events API only; Socket Mode is not included.
- One Slack workspace installation/token per channel instance; no OAuth installation store or Marketplace multi-tenancy.
- Edited/deleted messages do not mutate Agent history or buffered context.
- Slack's Agent messaging experience is enabled for newly onboarded apps and cannot be switched back to the legacy Assistant experience.
- `rendering: "classic"` exists for plans/apps without native Agent streaming and for intentional top-level replies.
- Rotating bot credentials require durable single-process state; deleting `bot-auth.json` after the env refresh token has been consumed requires reinstalling/restoring credentials.
