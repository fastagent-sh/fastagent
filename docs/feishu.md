---
title: Feishu channel (Lark compatibility)
description: "Run an agent as a Feishu (飞书) or Lark bot: create the app, WebSocket or webhook, scopes, when it answers, threads, cards, files, and sending from schedules."
status: current
---

# Feishu channel (Lark compatibility)

The agent answers as a Feishu or Lark bot, streaming its answer into a Markdown card.

| | Feishu (飞书) | Lark (international) |
|---|---|---|
| Console | `open.feishu.cn` | `open.larksuite.com` |
| Add | `fastagent add feishu` | `fastagent add lark` |
| Variables | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` (+ `FEISHU_VERIFICATION_TOKEN`, optional `FEISHU_ENCRYPT_KEY` for webhooks) | the same with `LARK_` |
| Webhook path | `POST /feishu` | `POST /lark` |

Pick the cloud your tenant is on. One agent can serve both, with two apps.

## Set it up

```bash
fastagent add feishu              # src/channels/feishu.ts, the feishu-send and feishu-threads tools, and the WebSocket SDK in package.json
npm install                       # installs @larksuiteoapi/node-sdk
fastagent channels setup feishu   # scan or open the link to create the app; credentials are kept for you
fastagent dev                     # WebSocket: no public URL needed
```

- **Feishu** creates the app for you (scan-to-create): confirm it in the browser or the Feishu app, then **create a
  version and publish it** in the console.
- **Lark** opens a link that creates the app with the right scopes; paste its App ID and App Secret in a terminal (or
  add `LARK_APP_ID` / `LARK_APP_SECRET` to `.secrets/.env` and verify with `--json`), then publish.

Setup checks the app's scopes and names any your tenant withheld, with a link to request it:

| Scope | Without it |
|---|---|
| `im:message.group_msg` (sensitive) | only @mentions arrive: no bare replies in threads, no group discussion |
| `im:message:readonly` | earlier discussion and quoted messages cannot be read |
| `im:message.reactions:write_only` | no 👀 on a message waiting behind a running task |
| `im:chat.members:read` | people show as open_ids instead of names |

<details><summary>Creating the app by hand</summary>

1. Create a custom app and enable the bot capability.
2. Add the scopes `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`,
   `im:resource`, the card scope ("Create and update card"), and the ones in the table above.
3. Subscribe to `im.message.receive_v1`, choosing long connection (for `dev`) or webhook (copy the Verification
   Token; an Encrypt Key is recommended).
4. Put the values in `.secrets/.env`, then create a version and publish.

</details>

## WebSocket or webhook

| | WebSocket | Webhook |
|---|---|---|
| Needs | App ID + Secret, an always-on process, `@larksuiteoapi/node-sdk` in the agent's dependencies | also the Verification Token, a public URL |
| Default for | `dev` | `start` and deployments |
| Scale to zero | no | yes |

Change it with `channels.feishu.ingress` (`connection` or `webhook`). **Use separate apps for dev and production**:
two instances on one app split its events. `deploy --run` creates the production app (asking for the extra
`application:application:patch` scope, which lets it register the Request URL and read the Verification Token), or
pass one made with `fastagent channels setup feishu --config prod.json --env-file prod.env`. On Lark, set the Request
URL in the console when its API does not allow it.

Webhook events are checked by the Verification Token, or, with an Encrypt Key, by signature (plaintext is then
refused). Set an Encrypt Key: without it there is no replay protection, and startup warns.

## When it answers

| Place | Answers | Conversation (one session each) |
|---|---|---|
| Direct message | every message | the chat |
| Group | an `@bot` mention | one per sender |
| Thread in a group | a mention; then bare replies while only one person talks there | the thread |

- A thread opened on one of the bot's answers starts from that conversation's history.
- Before answering, it reads what was said in the place since its last answer (by name, bounded). A thread's first
  turn also reads the room. The `feishu-threads` tool lets it read other threads of the group.
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

## Sending from schedules (`feishu-send` / `lark-send`)

A schedule or a wake-up has no chat to reply in: its prompt names the chat id, and the agent sends text or a Markdown
card with the send tool. It cannot target a thread yet. In a chat turn the reply is sent for you; calling the tool too
posts twice. `fastagent add feishu` again updates the tools and keeps your channel file.

## The channel file

```ts
import { byIngress, needs } from "@fastagent-sh/fastagent";
import { type FeishuChannelOptions, feishuChannel, feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";

const policy: Pick<FeishuChannelOptions, "onError" | "route"> = {
  onError: (failed) => `⚠️ ${failed.details}`, // dev transparency; drop for a public bot
};

export default byIngress({
  webhook: needs(
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
        ...policy,
      }),
  ),
  connection: needs(["FEISHU_APP_ID", "FEISHU_APP_SECRET"], (secrets) =>
    feishuWebSocketChannel({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET, ...policy }),
  ),
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
- Reading a place's history adds about 300–400 ms before a group turn.
- Feishu limits sends to one chat to 5 per second.
