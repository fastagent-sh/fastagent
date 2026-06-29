---
title: Channels
type: doc
status: current
---

# Channels

A **channel** is the agent's inbound surface — how a turn gets triggered (an HTTP call, a GitHub webhook, a Telegram message, …). Channels consume only the engine-neutral [Agent contract](SPEC.md), so the same channel works with any engine. This is the **N axis**.

## The contract + discovery

A channel is a file in the workspace's `channels/` directory that default-exports a `ChannelModule`:

```ts
type ChannelModule = (agent: Agent) => Routes;   // Routes = { "METHOD /path": (req: Request) => Response | Promise<Response> }
```

`fastagent dev` / `start` discover every `channels/*.ts`, call each with the **same** assembled agent, and merge the returned route tables onto one HTTP server. A route-key clash is surfaced as a collision (first file wins). With no `channels/` dir, the default invoke channel is mounted at `POST /invoke`.

## Multiple channels

Drop one file per channel; they coexist on one process, all driving the same agent:

```
channels/
├── github.ts     → POST /webhook    (@kid7st/fastagent/github)
├── telegram.ts   → POST /telegram   (@kid7st/fastagent/telegram)
└── slack.ts      → POST /slack      (a third-party fastagent-channel-slack)
```

`fastagent start` serves all three. Each file reads its own secrets (`GITHUB_WEBHOOK_SECRET`, `TELEGRAM_*`, `SLACK_*`) and wires its own adapter — independent, different packages, different deps.

## Two layers: adapter + glue

Every channel is an **adapter** (reusable verify + parse + ACK logic, possibly with an SDK) wired to your **`on()` glue** (which maps events to agent intents). You write only the glue. For the first-party channels, `fastagent add github` / `fastagent add telegram` scaffold the file below (with the env vars + setup steps printed as next steps).

**GitHub** (`@kid7st/fastagent/github`) — fire-and-forget; the agent replies out-of-band (e.g. via `gh`). The channel holds only the inbound secret.

```ts
// channels/github.ts
import { githubChannel } from "@kid7st/fastagent/github";
import type { ChannelModule } from "@kid7st/fastagent";
const channel: ChannelModule = (agent) => ({
  "POST /webhook": githubChannel(agent, {
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    on: (event) =>
      event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload
        ? [{ session: event.deliveryId, text: `Review PR #${event.payload.pull_request.number}` }]
        : [],
  }),
});
export default channel;
```

**Telegram** (`@kid7st/fastagent/telegram`) — request/reply: the channel holds the bot token and **streams the agent's reply back to the chat** itself.

```ts
// channels/telegram.ts
import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";
const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // the setWebhook secret_token
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",       // used to send the reply
    onError: (failed) => `⚠️ ${failed.details}`,          // dev bot: surface raw errors; see below
    // `route` is OPTIONAL — omitted, it uses `defaultTelegramRoute` and the channel composes everything.
  }),
});
export default channel;
```

**Responsibility split.** The *channel* owns all transport + format: picking the message, extracting `text`/`caption`, attachments (photo→vision image with resize, document/voice/video/audio→downloaded to disk), composing the prompt envelope, Telegram-HTML formatting (+ plain fallback), streaming, 4096-split, and 429 retries. The *developer* owns **policy** via `route` and behaviour via `AGENTS.md` + tools. `route(update) => { session?, chatId?, threadId?, text? } | null` decides whether/where to answer (return `null` to ignore; omitted fields default from the message). It defaults to the exported **`defaultTelegramRoute`** (private chats always answer; groups on a command, a reply to the bot, or an @mention — telegramChannel resolves the bot's username via getMe). Override granularly by reusing the defaults — `route: (u) => defaultTelegramRoute(u) && { session: "…" }`, or a custom prompt with `text: \`${telegramEnvelope(u.message!)}\n…\`` (the channel still appends attachments + the HTML hint). The adapter auto-adapts to **Threaded Mode** (topics in private chats, a @BotFather toggle): an update carrying `message_thread_id` is answered in that thread with a per-`chat:thread` session; a linear chat has none and runs one session per chat. The turn is **streamed live** via `sendMessageDraft` — an ephemeral preview showing `Thinking…`, tool calls (`🔧 read AGENTS.md ✓`), and partial text — then the clean final text is persisted with `sendMessage`.

**Failures have two audiences.** The full `details` (the dev-facing diagnostic — raw provider/exception text) always go to the operator log. The chat message is **customer-facing**: by default a neutral message keyed on `retryable`, so an adopter building a public bot does not leak internals. A developer's own bot opts into transparency with `onError: (f) => \`⚠️ ${f.details}\`` (the scaffold sets this) so they — and their AI coding agent — can act on the real error.

**Groups (shared session + context).** A group answers one shared `chat[:thread]` session: everyone talks to the same agent with one history, and concurrent summons are **serialized** (FIFO) rather than dropped as "busy". Each message is tagged with its sender so the model tells participants apart, and a group is flagged in the prompt. So the agent can answer "summarize the discussion" / "reply based on everyone's input", the channel keeps a small per-chat buffer of recent **un-summoned** messages (under a char budget, oldest dropped) and folds it into the next answered turn — which needs Telegram **group privacy mode OFF** (@BotFather → `/setprivacy` → Disable) to receive those messages at all; the channel warns at startup if it is on. The buffer is in-process (a restart loses anything not yet folded in; folded discussion lives in the durable session).

**Files.** Telegram media are just files. The channel downloads any document/voice/video/audio on a routed message to `<cwd>/.fastagent/telegram-files/<chat>/` and appends the local paths to the prompt — the agent then reads/processes them with its own tools (`read`/`bash`); we shuttle bytes, the agent decides. To send a file back, the agent calls the scaffolded `tools/telegram-send.ts` (`telegram_send_file`) with a `chatId` from the `[telegram: chat …]` context line. A load failure surfaces as a `failed` event, never a silent drop. Audio/video transcoding is out of scope — the agent finds its own tools if it needs the content. Downloaded files persist under `.fastagent/telegram-files/` (git-ignored machine state, not auto-cleaned — like sessions); a long-running production bot should mount/clean that dir.

**Images.** The channel extracts photos (the largest `message.photo` size, plus any on a replied-to message) and passes them to the agent as `prompt.images`, resized to the model's needs in the engine — so the model must support vision. Reply formatting is the channel's job, not a developer knob: the final text is sent as Telegram HTML and silently retries as plain text if Telegram rejects the markup, so a model formatting slip degrades instead of losing the message (the streamed draft stays plain — mid-stream markup is incomplete).

## Long-tail channels: external adapter packages

fastagent does **not** publish a package per channel. Built-in/first-party adapters (the default invoke channel, `github`, `telegram`) are zero- or light-dependency. Anything with a heavy SDK (Slack, Discord, …) is a **separate adapter package** — first-party or community — that the user installs; its SDK never enters `@kid7st/fastagent`'s dependencies.

```jsonc
// fastagent-channel-slack/package.json
{
  "name": "fastagent-channel-slack",
  "dependencies": { "@slack/web-api": "^7" },          // the heavy SDK lives here
  "peerDependencies": { "@kid7st/fastagent": "^0.x" }  // for the Agent type + channel-authoring kit
}
```

```ts
// the user's workspace:  npm i fastagent-channel-slack
// channels/slack.ts
import { slackChannel } from "fastagent-channel-slack";
import type { ChannelModule } from "@kid7st/fastagent";
const channel: ChannelModule = (agent) => ({ "POST /slack": slackChannel(agent, { /* on() glue */ }) });
export default channel;
```

`fastagent start` discovers `channels/slack.ts`; the Slack SDK is in the **workspace's** `node_modules`, not the main package. This is the same discovery/merge mechanism as multiple channels — long-tail and multi-channel are one mechanism.

## Local development: a public URL

Webhooks need a public HTTPS URL, but `fastagent dev` serves `localhost`. `--tunnel` bridges the gap:

```bash
fastagent dev --tunnel
```

It starts the server, opens a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (needs `cloudflared` installed — it prints an install hint if missing, and serves without a tunnel), prints the public URL, and **auto-registers the first-party webhooks**: it calls Telegram `setWebhook` (using the `.env` tokens) and prints the GitHub Payload URL to paste into repo settings. The tunnel is owned by the watch supervisor, so the URL **survives reloads** — edit and save without re-registering. `fastagent add telegram` scaffolds the `.env` vars (with a generated secret) and points you straight at `fastagent dev --tunnel`.

## Authoring an adapter

An adapter is a `(agent, options) => (req: Request) => Promise<Response>`. It needs only the public `@kid7st/fastagent` surface — the **channel-authoring kit** — so a third-party package depends on nothing else:

| Export | Use |
|---|---|
| `Agent` | the type of the agent the adapter drives |
| `Routes`, `ChannelHandler` | type the returned route table |
| `collect` | run a turn to its final `{ text, data }` (throws `AgentFailure` on failure) |
| `readBodyCapped` | read a request body with a hard byte cap (DoS guard on a public endpoint) |
| `text`, `textHeaders` | build plain `text/plain` responses (4xx / status replies) |

Concurrency safety across channels is the engine's per-session lease: concurrent turns on the same `session` fail fast with `failed{session busy}`. Post-ACK turns (fire-and-forget) are lost on shutdown until durable execution exists.

## Where next

- [github](github.md) — the GitHub webhook channel in depth (`fastagent add github`).
- [embedding](embedding.md) — using channels (and the rest of the library) from your own app.
