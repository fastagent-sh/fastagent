---
title: Channels
description: "Connect an agent to Telegram, Slack, Feishu or Lark, or to your own webhook: add a channel, set up its app, and run it locally."
status: current
---

# Channels

A channel turns a platform's events into messages for the agent, and sends back its answers.

| Platform | Add it | Guide |
|---|---|---|
| Telegram | `fastagent add telegram` | [Telegram](telegram.md) |
| Slack | `fastagent add slack` | [Slack](slack.md) |
| Feishu (飞书) | `fastagent add feishu` | [Feishu / Lark](feishu.md) |
| Lark (international) | `fastagent add lark` | [Feishu / Lark](feishu.md) |
| Anything else | write `src/channels/<name>.ts` | [Channel development](channel-development.md) |

`add` writes the channel file (`src/channels/<name>.ts`, yours to edit) and its send tool. The first `fastagent dev`
then asks for the bot's credentials, or run `fastagent channels setup <name>` yourself.

## How a channel receives

A first-party channel opens its own connection to the platform: Telegram is polled, and Slack, Feishu and Lark hold a
connection. It needs no public URL, so `fastagent dev` on a laptop and `fastagent start` in a container run the same
channel file. The process must stay running to receive.

Each platform also has a webhook factory (`telegramChannel`, `slackChannel`, `feishuChannel`, `larkChannel`) that
serves a route and verifies the platform's signature. FastAgent does not register its URL: whoever hosts it points the
platform at `https://<host>/<channel>` and keeps the extra secret the factory takes.

Rename a channel file to `<name>.ts.disabled` to turn it off. A channel that fails to load stops `dev` and `start`.

## Good to know

- **Everyone who can message the bot can use the agent's tools.** A channel checks the platform, not the person.
- **Live previews show tool activity** to everyone in the chat, including the last line a `bash` command printed.
  A command that prints a secret shows it until the next line replaces it, and the platform may keep that frame.
  Slack's native stream does not show it.
- **Messages survive restarts.** An accepted message is answered after a restart, at least once.
- A third-party channel is a package you install and wire in a channel file, passing its secrets through `needs`.
