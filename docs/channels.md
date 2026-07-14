---
title: Channels
description: "How channels turn external events into agent invocations: discovery, route tables, the GitHub and Telegram adapters, and local webhook tunneling."
status: current
---

# Channels

A **channel** is an agent's inbound surface — it turns an external event into invocations: HTTP, GitHub webhooks, Telegram messages, Slack events, even the clock ([schedules](quickstart.md#8-run-on-a-clock)).

Channels consume only the engine-neutral [Agent contract](SPEC.md). The same channel can drive any conforming agent.

> This page is the USER's view — what channels exist and how to wire them. Building a new channel adapter is a different audience: see [Channel development](channel-development.md).

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
import type { ChannelModule } from "@fastagent-sh/fastagent/core";

const channel: ChannelModule = ({ agent, stateRoot }) => ({
  "POST /webhook": async (req) => {
    // parse req, call agent, return a Response; durable channel state goes under
    // `${stateRoot}/channels/<kind>` (never process.cwd())
    return new Response(null, { status: 204 });
  },
});

export default channel;
```

`fastagent dev` and `fastagent start` discover every `channels/*.ts|*.js|*.mjs`, call each module with the same mount context (the assembled agent + the resolved state root), and merge the returned route tables onto one HTTP server.

With no enabled channel files, FastAgent mounts the default HTTP/SSE invoke channel at `POST /invoke`.
A channel file is enabled by its importable extension (`.ts`, `.js`, or `.mjs`); rename it to, for
example, `telegram.ts.disabled` to keep it in the workspace without mounting it. A declared channel that
fails to load, or overlaps another channel's route, makes `dev` / `start` fail — it never silently
disappears or triggers the `/invoke` fallback.

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
| GitHub webhook | `@fastagent-sh/fastagent/github` | [GitHub channel](github.md) | `fastagent add github` |
| Telegram bot | `@fastagent-sh/fastagent/telegram` | [Telegram channel](telegram.md) | `fastagent add telegram` |
| Feishu bot (飞书) | `@fastagent-sh/fastagent/feishu` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add feishu` |
| Lark bot (international) | `@fastagent-sh/fastagent/lark` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add lark` |

Example GitHub glue:

```ts
import { githubChannel } from "@fastagent-sh/fastagent/github";

export default githubChannel({
  secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  on: (event) =>
    event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload
      ? [{ session: event.deliveryId, text: `Review PR #${event.payload.pull_request.number}` }]
      : [],
});
```

Example Telegram glue:

```ts
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";

export default telegramChannel({
  secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "",
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
});
```

Example canonical Feishu glue (Lark international exposes a branded `larkChannel` compatibility
adapter over this engine and reads `LARK_*`):

```ts
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";

export default feishuChannel({
  appId: process.env.FEISHU_APP_ID ?? "",
  appSecret: process.env.FEISHU_APP_SECRET ?? "",
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "",
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
});
```

An adapter call returns a `ChannelModule`: the glue holds only policy (secrets from env, `on`/`route`),
while `agent` and the state root flow from the framework to the adapter without transiting your code.
The adapter owns its default route (`POST /webhook`, `POST /telegram`, `POST /feishu`, `POST /lark`);
wrap it in your own `ChannelModule` to remap.

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
- Feishu: PATCHes the app's event subscription to the tunnel URL via the reference cloud's config API.
- Lark compatibility: probes the same Feishu mechanism; its lagging config route currently falls back
  to opening the app console and printing the Request URL.

The tunnel is owned by the dev watch supervisor, so the URL survives worker reloads.

## Third-party channels

Heavy or long-tail adapters should live outside `@fastagent-sh/fastagent`:

```jsonc
{
  "name": "fastagent-channel-slack",
  "peerDependencies": { "@fastagent-sh/fastagent": "^0.x" },
  "dependencies": { "@slack/web-api": "^7" }
}
```

The user's workspace installs the adapter and wires it with a channel file:

```ts
import { slackChannel } from "fastagent-channel-slack";

export default slackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  on: (event) => ({ session: event.user, text: event.text }),
});
```

Read [Channel development](channel-development.md) for adapter design, packaging, and testing guidance.

## Operational notes

- Channels choose the `session` string. Core same-session concurrency fails fast; a channel such as Telegram may queue before invoking.
- Post-ACK fire-and-forget work is lost if the process exits unless the channel or host persists intents.
- Public endpoints should verify signatures/secrets and cap request bodies before parsing untrusted payloads.
- User-facing error messages should avoid leaking provider or infrastructure details; log full diagnostics for operators.

## Where next

- [GitHub channel](github.md)
- [Telegram channel](telegram.md)
- [Channel development](channel-development.md)
- [Embedding](embedding.md)
