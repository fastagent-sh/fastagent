---
title: Channels
description: "How channels turn external events into agent invocations: discovery, route tables, first-party chat/webhook adapters, and local tunneling."
status: current
---

# Channels

A **channel** is an agent's inbound surface — it turns an external event into invocations: HTTP, Telegram messages, Slack events, even the clock ([schedules](quickstart.md#8-run-on-a-clock)).

Channels consume only the engine-neutral [Agent contract](SPEC.md). The same channel can drive any conforming agent.

> To build a new channel adapter, see [Channel development](channel-development.md).

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

The agent remains the same assembled agent.

## Workspace discovery

An agent declares channels with files under `channels/`:

```txt
channels/
├── telegram.ts   # POST /telegram
└── slack.ts      # POST /slack
```

A route channel default-exports a `ChannelModule`:

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

A long-connection channel instead exports a `LongConnectionChannelModule` object:

```ts
import type { LongConnectionChannelModule } from "@fastagent-sh/fastagent/core";

const channel: LongConnectionChannelModule = {
  name: "acme websocket",
  connect({ agent, stateRoot }, signal) {
    // Start the connection. Translate signal abort into the transport's close operation.
    return { ready, closed };
  },
};

export default channel;
```

`fastagent dev` and `fastagent start` discover every `channels/*.ts|*.js|*.mjs`. Function exports
contribute route tables to the HTTP server; object exports open long connections. Both receive the
assembled agent and resolved state root. Long-connection adapters own reconnects, observe shutdown
through `AbortSignal`, and report first readiness plus terminal closure through the two promises.

**A channel verifies its own caller**, by checking the platform's signature (`X-Telegram-Bot-Api-Secret-Token`,
Feishu's signature). FastAgent adds no authentication to channel routes, and does not apply the JSON content-type
requirement or CORS policy of its own routes to them. A custom channel that verifies nothing can be driven by
anyone, including a web page.

`POST /invoke` is reserved: a channel declaring it makes `dev` / `start` fail (unless `http.invoke: false`). Rename
a channel file to e.g. `telegram.ts.disabled` to keep it without mounting it. A channel that fails to load, or
collides with another channel's route, makes `dev` / `start` fail.

## Routes

Route keys are either:

```txt
/path              # any method
METHOD /path       # method-specific
```

The path is matched **literally**: `:id` and `*` are ordinary characters. Full rules:
[Channel development](channel-development.md#route-keys).

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
| Telegram bot | `@fastagent-sh/fastagent/telegram` | [Telegram channel](telegram.md) | `fastagent add telegram` |
| Slack app | `@fastagent-sh/fastagent/slack` | [Slack channel](slack.md) | `fastagent add slack` |
| Feishu bot (飞书) | `@fastagent-sh/fastagent/feishu` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add feishu` |
| Lark bot (international) | `@fastagent-sh/fastagent/lark` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add lark` |

Example Telegram glue:

```ts
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["TELEGRAM_SECRET_TOKEN", "TELEGRAM_BOT_TOKEN"],
  channel: (secrets) =>
    telegramChannel({
      secretToken: secrets.TELEGRAM_SECRET_TOKEN,
      botToken: secrets.TELEGRAM_BOT_TOKEN,
    }),
});
```

Example Slack glue:

```ts
import { slackChannel } from "@fastagent-sh/fastagent/slack";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  channel: (secrets) =>
    slackChannel({
      botToken: secrets.SLACK_BOT_TOKEN,
      signingSecret: secrets.SLACK_SIGNING_SECRET,
      rendering: "native", // Slack Agent stream with inline tool traces; "classic" for compatibility
      // aiDisclaimer: "AI-generated; verify important information.", // optional policy footer
    }),
});
```

Example canonical Feishu glue (Lark international exposes a branded `larkChannel` compatibility
adapter over this engine and reads `LARK_*`):

```ts
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
  channel: (secrets) =>
    feishuChannel({
      appId: secrets.FEISHU_APP_ID,
      appSecret: secrets.FEISHU_APP_SECRET,
      verificationToken: secrets.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
    }),
});
```

A route-adapter call returns a `ChannelModule`; a WebSocket adapter such as
`feishuWebSocketChannel` returns a `LongConnectionChannelModule`. In either form the glue holds only
policy (the declared `secrets` and `route`); `agent` and the state root come from the framework. Each adapter has
a default route (`POST /telegram`, `POST /slack`, `POST /feishu`, `POST /lark`); wrap it in your own
`ChannelModule` to remap.

## Adapter + glue

A channel usually has two layers:

| Layer | Reusable? | Example |
|---|---|---|
| Adapter | yes | verify a platform signature, parse a Telegram update, call an SDK |
| Glue | agent-specific | map one event to `{ session, text }`, choose routing policy |

Keep transport mechanics in reusable adapters. Keep product/agent policy in the agent's `channels/*.ts` file.

## Local webhook development

Webhooks need a public HTTPS URL, but `fastagent dev` serves `localhost`. Use:

```bash
fastagent dev --tunnel
```

When `cloudflared` is installed, FastAgent opens a Cloudflare quick tunnel, prints the public URL, and auto-registers first-party webhooks where possible:

- Telegram: calls `setWebhook` using `.env` values.
- Slack: for an app created by `add slack`, rotates its owner-local Configuration Token and updates the App Manifest Request URL; scaffold-only/manual apps receive the URL to paste.
- Feishu: PATCHes the app's event subscription to the tunnel URL via the reference cloud's config API.
- Lark compatibility: probes the same Feishu mechanism; its lagging config route currently falls back
  to opening the app console and printing the Request URL.

The tunnel is owned by the dev watch supervisor, so the URL survives worker reloads.

## Third-party channels

Heavy or long-tail adapters should live outside `@fastagent-sh/fastagent`:

```jsonc
{
  "name": "fastagent-channel-acme",
  "peerDependencies": { "@fastagent-sh/fastagent": "^0.x" },
  "dependencies": { "@acme/sdk": "^1" }
}
```

The user's agent installs the adapter and wires it with a channel file:

```ts
import { acmeChannel } from "fastagent-channel-acme";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["ACME_SECRET"],
  channel: (secrets) =>
    acmeChannel({
      secret: secrets.ACME_SECRET,
      on: (event) => ({ session: event.user, text: event.text }),
    }),
});
```

Declaring `secrets` makes an unset value a startup failure (and a `deploy --run` refusal).

Read [Channel development](channel-development.md) for adapter design, packaging, and testing guidance.

## Operational notes

- Channels choose the `session` string. Core same-session concurrency fails fast; a channel such as Telegram may queue before invoking.
- Work started after a webhook ACK is lost if the process exits, unless the channel persists it (Telegram, Slack and Feishu/Lark do).
- Public endpoints should verify signatures/secrets and cap request bodies before parsing untrusted payloads.
- User-facing error messages should avoid leaking provider or infrastructure details; log full diagnostics for operators.

## Where next

- [Telegram channel](telegram.md)
- [Slack channel](slack.md)
- [Feishu channel (Lark compatibility)](feishu.md)
- [Channel development](channel-development.md)
- [Embedding](embedding.md)
