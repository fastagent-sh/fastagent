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

**Telegram** (`@kid7st/fastagent/telegram`) — request/reply: the channel holds the bot token and **sends the agent's reply back to the chat** itself.

```ts
// channels/telegram.ts
import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";
const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // the setWebhook secret_token
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",       // used to send the reply
    on: (update) =>
      update.message?.text
        ? [{ session: `${update.message.chat.id}`, text: update.message.text, chatId: update.message.chat.id }]
        : [],
  }),
});
export default channel;
```

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
