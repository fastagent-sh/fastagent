---
title: Telegram channel
status: current
---

# Telegram channel

The Telegram channel turns a Telegram Bot API webhook update into an agent turn and sends the agent's reply back to the chat.

Unlike the GitHub channel, Telegram is request/reply: the channel holds the bot token, streams a live preview message while the turn runs, and edits it into the final answer.

## Add the channel

From an agent workspace:

```bash
fastagent add telegram
```

This creates:

```txt
channels/telegram.ts      # inbound webhook adapter + routing policy
tools/telegram-send.ts    # optional outbound file-send tool for the agent
```

It also appends the required env vars to `.env.example` when possible.

## Configure Telegram

Create a bot with [@BotFather](https://t.me/BotFather), then set:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_SECRET_TOKEN=... # any random string; verifies inbound updates
```

For local webhook testing:

```bash
fastagent dev --tunnel
```

When `cloudflared` is installed, FastAgent opens a public HTTPS URL and calls Telegram `setWebhook` using the env vars above.

For production, set the webhook URL yourself or run behind a stable public HTTPS endpoint:

```txt
https://<host>/telegram
```

## Scaffolded channel

A minimal channel module looks like this:

```ts
import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";

const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "",
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    // Optional. The scaffold uses this for development transparency.
    onError: (failed) => `⚠️ ${failed.details}`,
  }),
});

export default channel;
```

Both `secretToken` and `botToken` are required. Construction fails if either is empty, so a public endpoint never silently accepts forged updates or fails later without a bot token.

## Routing policy

By default, `telegramChannel` uses `defaultTelegramRoute`:

- private chats always answer,
- groups answer when the message replies to a bot,
- groups answer on a boundary-anchored `@botname` mention when the bot username is known (case-insensitive; `@fast` does not match `@fastagent`).

A slash command does **not** summon in a group (bare or directed like `/cmd@botname`) — it was noise; a bot that wants commands adds a custom `route`. Override `route` to decide whether and where to answer; a custom route owns its own group-summon policy, and if you rely on `@botname` mentions, pass a known `botUsername` to `defaultTelegramRoute`.

## Group chats

A group answers one shared `chat[:thread]` session: everyone talks to the same agent with one history. To keep that shared session coherent:

- **Serialized turns.** Concurrent summons in the same session run one at a time (FIFO) instead of failing fast as `session busy` — the right UX when several people talk in one group. Different sessions still run in parallel.
- **Sender attribution.** Each message is prefixed with its sender, and a group is flagged in the prompt, so the model can tell participants apart and answer "summarize the discussion".
- **Context buffer.** The channel keeps a small per-chat buffer of recent **un-summoned** messages (bounded by a character budget; the oldest are dropped) and folds it into the next answered turn. The buffer is in-process — a restart loses anything not yet folded in; folded discussion lives in the durable session.

The buffer needs Telegram **group privacy mode off** (@BotFather → `/setprivacy` → Disable) to receive un-summoned messages at all. The channel resolves the bot's privacy flag once at startup and warns when it is on.

```ts
import { defaultTelegramRoute, telegramChannel, telegramEnvelope } from "@kid7st/fastagent/telegram";

const botUsername = "my_bot";

telegramChannel(agent, {
  secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "",
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  route(update) {
    const base = defaultTelegramRoute(update, { botUsername });
    if (!base) return null;
    const message = update.message;
    if (!message) return null;
    return {
      ...base,
      session: `telegram:${message.chat.id}`,
      text: `${telegramEnvelope(message)}\n\nAnswer briefly.`,
    };
  },
});
```

`route(update)` returns:

```ts
type TelegramRoute = {
  session?: string;
  chatId?: number | string;
  threadId?: number;
  text?: string;
} | null;
```

Return `null` to ignore the update. Omitted fields default from the message.

## Prompt envelope

The exported `telegramEnvelope(message)` builds a text envelope with chat/thread/from metadata, reply context, text/caption, and structured payloads such as location, contact, and poll. You can reuse it when customizing `route`.

The channel appends a formatting instruction so replies use Telegram-supported HTML rather than Markdown.

## Threads and sessions

Telegram Threaded Mode is handled automatically:

- if `message_thread_id` is present, the default session is `chat:thread`,
- otherwise the default session is `chat`.

Replies are sent back to the same thread unless `route` overrides `threadId`.

Same-session concurrency is still controlled by the engine lease. If two updates map to the same session at the same time, one turn runs and the other fails fast with a retryable `session busy` event.

## Streaming behavior

The channel sends ONE preview message and edits it in place (`sendMessage` once → `editMessageText`), so it works in groups and private chats alike:

- an immediate "💭 Thinking…" placeholder,
- tool-call previews + partial answer text, edited in (plain text — a partial answer may carry unbalanced HTML),
- on completion, the same message is edited into the final answer as HTML (falling back to plain if Telegram rejects the markup).

The preview is best-effort; the final write is authoritative. A short answer edits the preview in place (falling back to a fresh send if the message can no longer be edited). A long answer that overflows one message is sent as consecutive fresh messages — the preview placeholder is removed first, so the parts stay together instead of the first chunk being pinned where an active group has scrolled past. An empty answer leaves a `(no reply)` message rather than vanishing; a suppressed error notice deletes the placeholder, leaving no residue.

## Failures

Failures have two audiences:

- **Operator log**: always receives the full diagnostic details.
- **Chat user**: receives `onError(failed)` if provided; otherwise a neutral default message keyed on `retryable`.

For development bots, surfacing `failed.details` is useful. For public bots, prefer a neutral user-facing message.

## Files and images

Telegram media are handled by the channel before the agent turn runs.

- Photos are downloaded, converted to `prompt.images`, and resized by the engine before reaching the model. The selected model must support vision.
- Documents, voice, video, and audio are downloaded to `<cwd>/.fastagent/telegram-files/<chat>/`. Their local paths are appended to the prompt so the agent can read them with tools.
- Download failures become `failed` events, never silent drops.

Downloaded files persist until the operator cleans them up. Treat `.fastagent/telegram-files/` like session state: git-ignored machine state that may need a volume or cleanup policy for long-running bots.

## Sending files back

`fastagent add telegram` also scaffolds `tools/telegram-send.ts`. Because tool names come from filenames, the agent can call the `telegram-send` tool with a `chatId` from the `[telegram: chat …]` envelope to send a local file back through the bot.

## Limits

- Telegram messages are split to the 4096-character limit.
- HTML parse failures fall back to plain text so a model formatting mistake does not lose the reply.
- Bot API 429 responses are retried with Telegram's `retry_after` hint.
- Audio/video transcription is not built in; the agent must use its own tools if it needs media content.
