---
title: Channels
description: "How channels turn external events into agent invocations: discovery, route tables, first-party chat/webhook adapters, and local tunneling."
status: current
---

# Channels

A **channel** is an agent's inbound surface: it turns an external event (an HTTP webhook, a Telegram message, a Slack
event) into messages to the agent. The clock is the other way in ([schedules](configuration.md#schedules)).

Channels call the [Agent API](SPEC.md), in process, like every other Caller.

> To build a new channel adapter, see [Channel development](channel-development.md).

## Mental model

```txt
external event → channel: verify, parse → the conversation's session → agent.invoke → reply or action
```

A channel decides:

- how to verify that an event comes from its platform, and parse it,
- whether the agent should answer,
- which conversation it belongs to, and so which session (the channel keeps that map),
- what text, images and files to send,
- how to acknowledge or reply to the external system.

## Discovery

An agent declares channels with modules of `src/channels/`, each named by its file:

```txt
src/channels/
├── telegram.ts   # POST /telegram
└── slack.ts      # POST /slack
```

A route channel default-exports a `ChannelModule`:

```ts
import type { ChannelModule } from "@fastagent-sh/fastagent/core";

const channel: ChannelModule = ({ agent, stateRoot }) => ({
  "POST /webhook": async (req) => {
    // verify the platform, parse, send the agent a message, return a Response; durable channel state goes under
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

`fastagent dev` and `fastagent start` mount every channel: function exports contribute route tables to the HTTP
server; object exports open long connections. Both receive the agent and the resolved state root. Long-connection
adapters own reconnects, observe shutdown through `AbortSignal`, and report first readiness plus terminal closure
through the two promises.

**A channel MUST verify its caller**, by checking the platform's signature or secret
(`X-Telegram-Bot-Api-Secret-Token`, Slack's `v0` HMAC, Feishu's token and signature). A serve has no API and no
authentication of its own: its routes are the channels' and `GET /health`, so a custom channel that verifies nothing
can be driven by anyone who finds its URL ([security boundary](design/security-boundary.md)).

Rename a channel file to e.g. `telegram.ts.disabled` to keep it without mounting it. A channel that fails to load, or
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

FastAgent adds a `GET /health` route beside the channels'.

## First-party channels

FastAgent ships lightweight first-party adapters as subpath exports.

| Channel | Package import | Docs | Add command |
|---|---|---|---|
| Telegram bot | `@fastagent-sh/fastagent/telegram` | [Telegram channel](telegram.md) | `fastagent add telegram` |
| Slack app | `@fastagent-sh/fastagent/slack` | [Slack channel](slack.md) | `fastagent add slack` |
| Feishu bot (飞书) | `@fastagent-sh/fastagent/feishu` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add feishu` |
| Lark bot (international) | `@fastagent-sh/fastagent/lark` | [Feishu channel (Lark compatibility)](feishu.md) | `fastagent add lark` |

Example Telegram glue (`fastagent add telegram` writes it):

```ts
import { needs } from "@fastagent-sh/fastagent";
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";

export default needs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"], (secrets) =>
  telegramChannel({
    secretToken: secrets.TELEGRAM_SECRET_TOKEN, // verifies inbound updates really come from Telegram
    botToken: secrets.TELEGRAM_BOT_TOKEN,
  }),
);
```

Example Slack glue:

```ts
import { needs } from "@fastagent-sh/fastagent";
import { slackChannel } from "@fastagent-sh/fastagent/slack";

export default needs(["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], (secrets) =>
  slackChannel({
    botToken: secrets.SLACK_BOT_TOKEN,
    signingSecret: secrets.SLACK_SIGNING_SECRET,
    rendering: "native", // Slack Agent stream with inline tool traces; "classic" for compatibility
  }),
);
```

Example canonical Feishu glue, receiving by webhook (Lark international exposes a branded `larkChannel`
compatibility adapter over this engine and reads `LARK_*`; the scaffold picks the WebSocket form under `dev`):

```ts
import { needs } from "@fastagent-sh/fastagent";
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";

export default needs(
  [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_VERIFICATION_TOKEN",
    { name: "FEISHU_ENCRYPT_KEY", description: "when set, plaintext events are refused", optional: true },
  ],
  (secrets) =>
    feishuChannel({
      appId: secrets.FEISHU_APP_ID,
      appSecret: secrets.FEISHU_APP_SECRET,
      verificationToken: secrets.FEISHU_VERIFICATION_TOKEN,
      encryptKey: secrets.FEISHU_ENCRYPT_KEY,
    }),
);
```

A route-adapter call returns a `ChannelModule`; a WebSocket adapter such as `feishuWebSocketChannel` returns a
`LongConnectionChannelModule`. In either form the glue holds only policy (the declared secrets and `route`); `agent`
and the state root come from the framework. `needs` makes each required secret a startup refusal while unset, and
carries it to a deployment. Each adapter has
a default route (`POST /telegram`, `POST /slack`, `POST /feishu`, `POST /lark`); wrap it in your own
`ChannelModule` to remap.

## Adapter + glue

A channel usually has two layers:

| Layer | Reusable? | Example |
|---|---|---|
| Adapter | yes | verify a platform signature, parse a Telegram update, call an SDK |
| Glue | agent-specific | map one event to `{ conversation, text }`, choose routing policy |

Keep transport mechanics in reusable adapters. Keep product/agent policy in the agent's `src/channels/*.ts` file.

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
import { needs } from "@fastagent-sh/fastagent";
import { acmeChannel } from "fastagent-channel-acme";

export default needs(["ACME_SECRET"], ({ ACME_SECRET }) =>
  acmeChannel({
    secret: ACME_SECRET,
    on: (event) => ({ conversation: event.user, text: event.text, deliveryId: event.deliveryId }),
  }),
);
```

Declaring the secret makes an unset value a startup failure (and a `deploy --run` refusal).

Read [Channel development](channel-development.md) for adapter design, packaging, and testing guidance.

## Operational notes

- A channel maps its conversations to the Agent's sessions, in its own state. A message for a busy session queues behind the ones before it; the first-party chat channels also serialize their own turns per conversation.
- An accepted message is durable and answered after a restart. Delivering its answer after a webhook ACK is the channel's to make durable (Telegram, Slack and Feishu/Lark persist each turn).
- Public endpoints should verify signatures/secrets and cap request bodies before parsing untrusted payloads.
- User-facing error messages should avoid leaking provider or infrastructure details; log full diagnostics for operators.
- Live previews show tool activity to everyone in the conversation: each call's argument summary and, while it runs,
  its latest status line (`tool_progress`). For `bash` that status is the last line it has printed, so a command that
  prints a secret (`printenv`, `cat .secrets/.env`) shows that line in the preview until the next one replaces it.
  The settled answer drops it, but the platform keeps what was sent: a message's edit events (Slack
  `message_changed`), other bots, and notification previews can read an intermediate frame. Telegram, Feishu/Lark and
  Slack `rendering: "classic"` show it; Slack's native stream does not.

## Where next

- [Telegram channel](telegram.md)
- [Slack channel](slack.md)
- [Feishu channel (Lark compatibility)](feishu.md)
- [Channel development](channel-development.md)
- [Embedding](embedding.md)
