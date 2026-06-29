---
title: Channels
status: current
---

# Channels

A **channel** is an agent's inbound surface: HTTP, GitHub webhooks, Telegram messages, Slack events, scheduled jobs, and so on.

Channels consume only the engine-neutral [Agent contract](SPEC.md). The same channel can drive any conforming agent.

## Mental model

```txt
external event → channel adapter → agent.invoke(scope, prompt) → channel response/action
```

A channel decides:

- how to verify and parse an external event,
- whether the agent should run,
- which `session` to use,
- what prompt text/images/files to pass,
- how to acknowledge or reply to the external system.

The agent remains the same assembled workspace.

## Workspace discovery

A workspace declares channels with files under `channels/`:

```txt
channels/
├── github.ts     # POST /webhook
├── telegram.ts   # POST /telegram
└── slack.ts      # POST /slack
```

Each file default-exports a `ChannelModule`:

```ts
import type { ChannelModule } from "@kid7st/fastagent";

const channel: ChannelModule = (agent) => ({
  "POST /webhook": async (req) => {
    // parse req, call agent, return a Response
    return new Response(null, { status: 204 });
  },
});

export default channel;
```

`fastagent dev` and `fastagent start` discover every `channels/*.ts|*.js|*.mjs`, call each module with the same assembled agent, and merge the returned route tables onto one HTTP server.

With no `channels/` directory, FastAgent mounts the default HTTP/SSE invoke channel at `POST /invoke`.

## Routes

Route keys are either:

```txt
/path              # any method
METHOD /path       # method-specific
```

Examples:

```ts
{
  "GET /healthz": () => new Response("ok\n"),
  "POST /webhook": webhookHandler,
}
```

A route overlap is surfaced as a collision. A bare `/webhook` conflicts with `POST /webhook`; `GET /webhook` and `POST /webhook` can coexist.

FastAgent adds a default `GET /health` route unless a channel already covers it.

## First-party channels

FastAgent ships lightweight first-party adapters as subpath exports.

| Channel | Package import | Docs | Add command |
|---|---|---|---|
| GitHub webhook | `@kid7st/fastagent/github` | [GitHub channel](github.md) | `fastagent add github` |
| Telegram bot | `@kid7st/fastagent/telegram` | [Telegram channel](telegram.md) | `fastagent add telegram` |

Example GitHub glue:

```ts
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

Example Telegram glue:

```ts
import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";

const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "",
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  }),
});

export default channel;
```

## Adapter + glue

A channel usually has two layers:

| Layer | Reusable? | Example |
|---|---|---|
| Adapter | yes | verify a GitHub signature, parse a Telegram update, call an SDK |
| Glue | workspace-specific | map one event to `{ session, text }`, choose routing policy |

Keep transport mechanics in reusable adapters. Keep product/agent policy in the workspace's `channels/*.ts` file.

## Local webhook development

Webhooks need a public HTTPS URL, but `fastagent dev` serves `localhost`. Use:

```bash
fastagent dev --tunnel
```

When `cloudflared` is installed, FastAgent opens a Cloudflare quick tunnel, prints the public URL, and auto-registers first-party webhooks where possible:

- Telegram: calls `setWebhook` using `.env` values.
- GitHub: prints the Payload URL to paste into repo settings.

The tunnel is owned by the dev watch supervisor, so the URL survives worker reloads.

## Third-party channels

Heavy or long-tail adapters should live outside `@kid7st/fastagent`:

```jsonc
{
  "name": "fastagent-channel-slack",
  "peerDependencies": { "@kid7st/fastagent": "^0.x" },
  "dependencies": { "@slack/web-api": "^7" }
}
```

The user's workspace installs the adapter and wires it with a channel file:

```ts
import { slackChannel } from "fastagent-channel-slack";
import type { ChannelModule } from "@kid7st/fastagent";

const channel: ChannelModule = (agent) => ({
  "POST /slack": slackChannel(agent, {
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    on: (event) => ({ session: event.user, text: event.text }),
  }),
});

export default channel;
```

Read [Channel development](channel-development.md) for adapter design, packaging, and testing guidance.

## Operational notes

- Channels choose the `session` string. Same-session concurrent turns fail fast with a retryable `failed` event.
- Post-ACK fire-and-forget work is lost if the process exits unless the channel or host persists intents.
- Public endpoints should verify signatures/secrets and cap request bodies before parsing untrusted payloads.
- User-facing error messages should avoid leaking provider or infrastructure details; log full diagnostics for operators.

## Where next

- [GitHub channel](github.md)
- [Telegram channel](telegram.md)
- [Channel development](channel-development.md)
- [Embedding](embedding.md)
