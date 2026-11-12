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

## Running locally

`fastagent dev` needs no public URL: Telegram is polled, and Slack, Feishu and Lark hold a connection. To try the
webhook path instead, set the channel to `webhook` and run `fastagent dev --tunnel` (needs `cloudflared`): it opens a
tunnel and points Telegram and Feishu at it. Slack's Request URL is printed for you to paste.

Rename a channel file to `<name>.ts.disabled` to turn it off. A channel that fails to load stops `dev` and `start`.

## How a channel receives

A channel file can serve both ways, and the instance chooses:

| Way | Needs | Default for |
|---|---|---|
| `connection` (polling, Socket Mode, WebSocket) | an always-on process, no public URL | `dev` |
| `webhook` | a public HTTPS URL; can wake a host that scales to zero | `start` and deployments |

Override it with `channels.<name>.ingress` in `fastagent.json`, or `--ingress telegram=webhook`.

## Good to know

- **Everyone who can message the bot can use the agent's tools.** A channel checks the platform, not the person.
- **Live previews show tool activity** to everyone in the chat, including the last line a `bash` command printed.
  A command that prints a secret shows it until the next line replaces it, and the platform may keep that frame.
  Slack's native stream does not show it.
- **Messages survive restarts.** An accepted message is answered after a restart, at least once.
- A third-party channel is a package you install and wire in a channel file, passing its secrets through `needs`.
