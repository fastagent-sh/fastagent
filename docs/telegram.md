---
title: Telegram channel
description: "Run an agent as a Telegram bot: create the bot, receive by polling or webhook, group behavior, stopping a turn, files, and sending messages from schedules."
status: current
---

# Telegram channel

The agent answers as a Telegram bot, streaming its answer into one message that it edits as it goes.

## Set it up

```bash
fastagent add telegram              # src/channels/telegram.ts and the telegram_send tool
fastagent channels setup telegram   # opens @BotFather; paste the token (hidden, checked with Telegram)
fastagent dev                       # polls Telegram: no public URL needed
```

Message the bot. A coding agent runs `channels setup telegram --json` (exit 2 with the missing env var and `@BotFather`
link until the owner adds `TELEGRAM_BOT_TOKEN` to `.secrets/.env` or runs `channels setup telegram` in a terminal, then
exit 0 once valid). `fastagent dev` runs the setup itself the first time.

**For groups, turn privacy mode off**, or the bot sees only mentions and replies: in @BotFather send `/setprivacy`,
choose the bot, choose Disable, then **remove the bot from each group and add it back**. Setup and startup warn when
it is on.

## Polling or webhook

| | Needs | Used by default in |
|---|---|---|
| Long polling | `TELEGRAM_BOT_TOKEN` | `dev` |
| Webhook at `https://<host>/telegram` | also `TELEGRAM_SECRET_TOKEN` (setup makes one) | `start` and deployments |

Change it with `channels.telegram.ingress` (`webhook` or `connection`). One bot is polled by one process or reached
by one webhook: a second poller of the same bot ends with `another process polls this bot`. A deployment points
the webhook at itself on every start.

## When it answers

| Where | Answers | Conversation (one session each) |
|---|---|---|
| Private chat | every message | the chat |
| Group | an `@bot` mention, or a reply to the bot | one per sender |
| Topic | the same | the whole topic |

- In groups, the bot reads the un-summoned discussion (kept 14 days) and gets what was said since its last answer, with
  senders and reply links, plus recent files and photos.
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
`telegram_send` (text or a file). In a chat turn the reply is sent for you; calling the tool too posts twice.
`fastagent add telegram` again updates the tool and keeps your channel file.

## The channel file

```ts
import { byIngress, needs } from "@fastagent-sh/fastagent";
import { telegramChannel, telegramPollingChannel } from "@fastagent-sh/fastagent/telegram";

// Optional. The scaffold uses this for development transparency.
const onError = (failed: { details: string }) => `⚠️ ${failed.details}`;

export default byIngress({
  webhook: needs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"], (secrets) =>
    telegramChannel({
      secretToken: secrets.TELEGRAM_SECRET_TOKEN,
      botToken: secrets.TELEGRAM_BOT_TOKEN,
      onError,
    }),
  ),
  connection: needs(["TELEGRAM_BOT_TOKEN"], (secrets) =>
    telegramPollingChannel({ botToken: secrets.TELEGRAM_BOT_TOKEN, onError }),
  ),
});
```

Customize with `route(update)`: return `null` to ignore an update, or `{ conversation?, chatId?, threadId?, text? }`.
A custom route decides group summoning itself; reuse `defaultTelegramRoute` and pass `botUsername`:

```ts
import { needs } from "@fastagent-sh/fastagent";
import { defaultTelegramRoute, telegramChannel, telegramEnvelope } from "@fastagent-sh/fastagent/telegram";

const botUsername = "my_bot";

// The policy is the same for both ways; this shows the webhook way, and `telegramPollingChannel` takes it unchanged.
export default needs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"], (secrets) =>
  telegramChannel({
    secretToken: secrets.TELEGRAM_SECRET_TOKEN,
    botToken: secrets.TELEGRAM_BOT_TOKEN,
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
  }),
);
```

`onError(failed)` sets what the user sees when a turn fails (the log always has the details). Show `failed.details`
only on a bot for developers.

## Data and restarts

- An accepted message is answered after a restart, at least once: a tool may run twice.
- Group discussion is kept 14 days (then the next turn is told it is gone); folded discussion stays in the session.
  To make the bot forget a group, delete its files under `<state root>/channels/telegram/buffers/` and the session.
- One process owns the state: a second `dev` or `start` of the agent is refused.

## Limits

- Long answers are split at 4096 characters, keeping HTML valid. Markup Telegram rejects falls back to plain text.
- Rate limits (429) are retried as Telegram asks.
- No built-in audio or video transcription.
