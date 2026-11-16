---
title: Channels
description: "Connect an agent to Telegram, Slack, Feishu or Lark, or to your own webhook: declare a channel, set up its app, and run it locally."
status: current
---

# Channels

A channel turns a platform's events into messages for the agent, and sends back its answers. Declare it under
`channels` in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { telegram } from "@fastagent-sh/fastagent/telegram";

export default defineAgent({
  channels: { telegram: telegram() },
});
```

| Platform | Declare it | Reads | Guide |
|---|---|---|---|
| Telegram | `telegram()` | `TELEGRAM_BOT_TOKEN` | [Telegram](telegram.md) |
| Slack | `slack()` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | [Slack](slack.md) |
| Feishu (飞书) | `feishu()` | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | [Feishu / Lark](feishu.md) |
| Lark (international) | `feishu({ domain: "lark" })` | `LARK_APP_ID`, `LARK_APP_SECRET` | [Feishu / Lark](feishu.md) |
| Anything else | your own channel | what it declares | [Channel development](channel-development.md) |

The first `fastagent dev` asks for the credentials a declared channel lacks, or run
`fastagent channels setup <platform>` yourself (`telegram`, `slack`, `feishu` or `lark`; the platform, not the channel's
name). A channel whose variables are unset stops `dev` and `start`, naming them.

The name you give a channel (`telegram` above) names its tools and keeps its state apart: lowercase letters, digits
and `_`. Each first-party channel gives the agent two tools:

- `<name>_send`: a message no chat turn carries (a schedule's, a wake-up's).
- `<name>_history`: the recent messages of the chat, channel or thread a turn was asked in, or of a thread there
  (`threadId`), 30 by default and up to 50. A turn carries only the message it answers and the one it replies to; the
  agent reads what came before when it needs it. It reads only the place the turn was asked in.

## How a channel receives

A first-party channel opens its own connection to the platform: Telegram is polled, and Slack, Feishu and Lark hold a
connection. It needs no public URL, so `fastagent dev` on a laptop and `fastagent start` in a container run the same
channel. The process must stay running to receive.

Each platform also has a webhook factory (`telegramChannel`, `slackChannel`, `feishuChannel`) that serves a route and
verifies the platform's signature. FastAgent does not register its URL: whoever hosts it points the platform at
`https://<host>/<route>` and passes the factory its credentials and the extra secret it takes.

Remove a channel from `channels` to turn it off. A channel that fails to load stops `dev` and `start`.

## Good to know

- **Everyone who can message the bot can use the agent's tools.** A channel checks the platform, not the person.
- **Live previews show tool activity** to everyone in the chat, including the last line a `bash` command printed.
  A command that prints a secret shows it until the next line replaces it, and the platform may keep that frame.
  Slack's native stream does not show it.
- **Messages survive restarts.** An accepted message is answered after a restart, at least once.
- A third-party channel is a package you install and declare the same way.
