---
title: Telegram channel
description: "Run an agent as a Telegram bot: create the bot, group behavior, stopping a turn, files, and sending messages from schedules."
status: current
---

# Telegram channel

The agent answers as a Telegram bot, streaming its answer into one message that it edits as it goes.

## Set it up

Declare it in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { telegram } from "@fastagent-sh/fastagent/telegram";

export default defineAgent({ channels: { telegram: telegram() } });
```

```bash
fastagent channels setup telegram   # opens @BotFather; paste the token (hidden, checked with Telegram)
fastagent dev                       # polls Telegram: no public URL needed
```

Message the bot. A coding agent runs `channels setup telegram --json` (exit 2 with the missing env var and `@BotFather`
link until the owner adds `TELEGRAM_BOT_TOKEN` to `.secrets/.env` or runs `channels setup telegram` in a terminal, then
exit 0 once valid). `fastagent dev` runs the setup itself the first time.

**For groups, turn privacy mode off**, or the bot sees only mentions and replies: in @BotFather send `/setprivacy`,
choose the bot, choose Disable, then **remove the bot from each group and add it back**. Setup and startup warn when
it is on.

## Polling

The bot polls Telegram for its updates, in `dev` and in a deployment alike, so it needs no public URL. One bot is
polled by one process: a second poller of the same bot ends with `another process polls this bot`. Give a deployment
a bot of its own (`fastagent channels setup telegram --env-file prod.env`).

`telegramChannel({ botToken, secretToken })` receives by webhook at `POST /telegram` instead, verified with a
`secretToken` of your choosing.
FastAgent does not call `setWebhook` for it: point the bot at the URL yourself, with the same `secret_token`. Polling
removes the bot's webhook when it starts.

## When it answers

| Where | Answers | Conversation (one session each) |
|---|---|---|
| Private chat | every message | the chat |
| Group | an `@bot` mention, or a reply to the bot | one per sender |
| Topic | the same | the whole topic |

- The agent reads what was said in the chat or topic with `telegram_history`, with senders, reply links and its own
  answers. Telegram cannot read a chat's history, so the channel keeps the newest 200 messages of each place it has
  seen; in a group it sees the messages nobody summons it with only when privacy mode is off.
- A reply to one of the bot's answers continues the session that answer came from, whoever replies.
- A message that arrives while the agent works is passed to the running work. If both are answered together, the
  later asker is pointed to the answer (👀 while waiting, 👌 when answered).
- Edited messages and slash commands do not summon.

## Stopping a turn

`/stop` stops the running turn. In a group it must be addressed: `/stop@yourbot`, `@yourbot /stop`, or a reply to
the bot. A bare `/stop` in a group is ordinary discussion, since Telegram sends it to every bot there. In a group it
stops only the sender's own session.

## Files and images

Photos reach the model as images (it must support vision). Documents, voice, video and audio are saved under
`<state root>/channels/telegram/files/` and their paths given to the agent. A failed download fails the turn with the
reason. Files are never deleted automatically.

## Sending from schedules (`telegram_send`)

A schedule or a wake-up has no chat to reply in: its prompt names the chat id, and the agent sends with
`telegram_send` (text or a file). In a chat turn the reply is sent for you; calling the tool too posts twice. The
tool is named after the channel: a channel declared as `support` gives `support_send`.

## Options

```ts
telegram({
  onError: (failed) => `⚠️ ${failed.details}`, // what the chat sees when a turn fails; details only for developers
});
```

Customize with `route(update)`: return `null` to ignore an update, or `{ conversation?, chatId?, threadId?, text? }`.
A custom route decides group summoning itself; reuse `defaultTelegramRoute` and pass `botUsername`:

```ts
import { defaultTelegramRoute, telegram, telegramEnvelope } from "@fastagent-sh/fastagent/telegram";

const botUsername = "my_bot";

const channel = telegram({
  botUsername,
  route(update) {
    const base = defaultTelegramRoute(update, { botUsername });
    if (!base) return null;
    const message = update.message;
    if (!message) return null;
    return {
      ...base,
      conversation: `${message.chat.id}`, // one conversation per chat, topics included
      text: `${telegramEnvelope(message)}\n\nAnswer briefly.`,
    };
  },
});
```

`onError(failed)` sets what the user sees when a turn fails (the log always has the details). Show `failed.details`
only on a bot for developers.

## Data and restarts

- An accepted message is answered after a restart, at least once: a tool may run twice.
- The newest 200 messages of each chat and topic are kept under `<state root>/channels/telegram/recent/`. To make the
  bot forget a chat, delete its file there and the session.
- One process owns the state: a second `dev` or `start` of the agent is refused.

## Limits

- Long answers are split at 4096 characters, keeping HTML valid. Markup Telegram rejects falls back to plain text.
- Rate limits (429) are retried as Telegram asks.
- No built-in audio or video transcription.
