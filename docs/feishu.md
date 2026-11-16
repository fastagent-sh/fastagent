---
title: Feishu and Lark channel
description: "Run an agent as a Feishu (飞书) or Lark bot: create the app, the WebSocket connection, scopes, when it answers, reading history, cards, files, and sending from schedules."
status: current
---

# Feishu and Lark channel

The agent answers as a Feishu or Lark bot, streaming its answer into a Markdown card (CardKit). Without the card scope
(`cardkit:card:write`, "Create and update card") there is no live card: the answer is sent as text once it is done,
and the log says why.

| | Feishu (飞书) | Lark (international) |
|---|---|---|
| Console | `open.feishu.cn` | `open.larksuite.com` |
| Declare | `feishu()` | `feishu({ domain: "lark" })` |
| Variables | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | `LARK_APP_ID`, `LARK_APP_SECRET` |

Pick the cloud your tenant is on. One agent can serve both, with two apps.

## Set it up

Declare it in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { feishu } from "@fastagent-sh/fastagent/feishu";

export default defineAgent({ channels: { feishu: feishu() } });
```

```bash
npm install @larksuiteoapi/node-sdk   # the WebSocket SDK the channel opens its connection with
fastagent channels setup feishu       # scan or open the link to create the app; credentials are kept for you
fastagent dev                     # WebSocket: no public URL needed
```

- **Feishu** creates the app for you (scan-to-create): confirm it in the browser or the Feishu app, then **create a
  version and publish it** in the console.
- **Lark** opens a link that creates the app with the right scopes; paste its App ID and App Secret in a terminal (or
  add `LARK_APP_ID` / `LARK_APP_SECRET` to `.secrets/.env` and verify with `--json`), then publish.

Setup checks the app's scopes and names any your tenant withheld, with a link to request it:

| Scope | Without it |
|---|---|
| `im:message.group_msg` (sensitive) | only @mentions arrive: no bare replies in threads |
| `im:message:readonly` | `feishu_history` and quoted messages cannot read the chat |
| `im:message.reactions:write_only` | no 👀 on a message waiting behind a running task |
| `im:chat.members:read` | people show as open_ids instead of names |

<details><summary>Creating the app by hand</summary>

1. Create a custom app and enable the bot capability.
2. Add the scopes `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`,
   `im:resource`, the card scope ("Create and update card"), and the ones in the table above.
3. Under Events & Callbacks choose long connection, and subscribe to `im.message.receive_v1`.
4. Put the values in `.secrets/.env`, then create a version and publish.

</details>

## WebSocket

The app receives over a WebSocket connection, in `dev` and in a deployment alike, so it needs no public URL. It needs
the App ID and Secret, a process that stays running, and `@larksuiteoapi/node-sdk` in the agent's dependencies.

**Use separate apps for dev and production**: two instances on one app split its events. Make the production app with
`fastagent channels setup feishu --env-file prod.env`, which keeps its credentials in that file.

`feishuChannel({ appId, appSecret, verificationToken, encryptKey? })` receives by webhook instead, at `POST /feishu`
(`POST /lark` with `domain: "lark"`), checked by the Verification Token, or with an Encrypt Key by signature
(plaintext is then refused; without one there is no replay protection, and startup warns). FastAgent does not set the
Request URL: set it in the console yourself.

## When it answers

| Place | Answers | Conversation (one session each) |
|---|---|---|
| Direct message | every message | the chat |
| Group | an `@bot` mention | one per sender |
| Thread in a group | a mention; then bare replies while only one person talks there | the thread |

- A thread opened on one of the bot's answers starts from that conversation's history.
- The agent reads what was said in the chat or thread with `feishu_history`, read from Feishu when it asks, people by
  name. A message that opened a thread says so, and the tool reads that thread by its id; only this chat's threads.
- A reply to one of its answers continues the session that answer came from.
- A message that arrives while it works is passed to the running work and may share its answer. A waiting message
  shows a reaction until it is answered.
- Other bots never trigger it. A quoted message is always read, up to 8 messages up its reply chain.

## Stopping a turn

A mention whose whole text is `stop` or `cancel` stops the running turn.

## Files and images

Images reach the model as images (it must support vision). Files, audio and video are saved under
`<state root>/channels/feishu/files/` and their paths given to the agent. A failed download of the message's own
attachment fails the turn visibly. Without `im:message.group_msg`, a bare image in a group is not delivered: send the
question and the image together, or reply to the image with a mention.

## Sending from schedules (`feishu_send`)

A schedule or a wake-up has no chat to reply in: its prompt names the chat id, and the agent sends text or a Markdown
card with `feishu_send`. It cannot target a thread yet. In a chat turn the reply is sent for you; calling the tool too
posts twice. The tools are named after the channel: a channel declared as `lark` gives `lark_send` and `lark_history`.

## Options

```ts
feishu({
  domain: "feishu", // or "lark"
  onError: (failed) => `⚠️ ${failed.details}`, // dev transparency; drop for a public bot
});
```

`route(event)` replaces the answering policy: return `null` to ignore, or `{ conversation?, chatId?, text? }`. A custom
route reads no place history. `onError(failed)` sets what the user sees when a turn fails; show `failed.details` only
to developers.

## Data and limits

- An accepted message is answered after a restart, at least once: a tool may run twice. A message Feishu delivers twice
  is taken once.
- Sessions are never deleted, so storage grows with the chats and threads the bot has joined.
- Messages show the asker as `user <open_id>`: events carry no display name.
- Feishu limits sends to one chat to 5 per second.
