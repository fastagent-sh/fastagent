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
tools/telegram-send.ts    # optional outbound send tool for the agent (message or file)
```

It also appends the required env vars to `.env.example` when possible.

## Configure Telegram

Create a bot with [@BotFather](https://t.me/BotFather), then set the bot token in the run-root `.env`:

```bash
TELEGRAM_BOT_TOKEN=...
```

`fastagent add telegram` writes a generated `TELEGRAM_SECRET_TOKEN` to `.env` when `.env` is gitignored. If it could not write one, add it yourself:

```bash
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
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";

export default telegramChannel({
  secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "",
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  // Optional. The scaffold uses this for development transparency.
  onError: (failed) => `⚠️ ${failed.details}`,
});
```

Both `secretToken` and `botToken` are required. Construction fails if either is empty, so a public endpoint never silently accepts forged updates or fails later without a bot token.

## Routing policy

The channel routes only **fresh** `message` / `channel_post` updates. Everything else — edited messages (each typo fix would re-answer), edited channel posts, callback queries — is ACKed and dropped **before** `route` runs, so a custom route never sees them.

By default, `telegramChannel` uses `defaultTelegramRoute`:

- private chats always answer,
- groups answer when the message replies to THIS bot — matched by the bot id parsed from the token, so a reply to another bot in a multi-bot group stays silent, precisely from the first update (no getMe race),
- groups answer on an `@botname` mention when the bot username is known — detected from Telegram's own `mention` entities, not a text scan, so `@fast` never matches `@fastagent`, and an `@botname` inside a code block or a URL does not summon (it is not a mention entity).

A slash command does **not** summon in a group (bare or directed like `/cmd@botname`) — it was noise; a bot that wants commands adds a custom `route`. Override `route` to decide whether and where to answer; a custom route owns its own group-summon policy. When reusing `defaultTelegramRoute`, pass your bot's identity (`botUsername` and/or `botId`) — group summon needs it, and a bare call answers only private chats (fail-closed: "is this a reply to me?" cannot be yes without knowing who "me" is).

## Group chats

A group answers one shared `chat[:thread]` session: everyone talks to the same agent with one history. To keep that shared session coherent:

- **Serialized turns.** Concurrent summons in the same session run one at a time (FIFO) instead of failing fast as `session busy` — the right UX when several people talk in one group. Different sessions still run in parallel.
- **Queue feedback.** A summon that lands while the session is busy gets an immediate "⏳ Queued" notice (reply-quoted to the asker, so a group sees whose ask is waiting); when its turn starts, the live preview edits that same message in place — the notice morphs into the answer, no orphan messages. Not group-specific: any busy session answers this way, including a private chat with two quick asks.
- **Sender attribution.** Each message is prefixed with its sender, and a group is flagged in the prompt, so the model can tell participants apart and answer "summarize the discussion".
- **Context buffer.** The channel keeps a small per-chat buffer of recent **un-summoned** messages (bounded by a character budget; the oldest are dropped) and folds it into the next answered turn — annotated with message ids and reply relations, so "the one Alex replied to" resolves. Attachments posted without summoning ride along too: the next summon downloads the most recent few files (readable by the agent's tools) and includes recent photos as vision inputs (photos ride along without per-photo attribution — the fold marks every attachment line with `[photo]`/`[document: …]` next to its sender, caption or not), so "summarize the file from earlier" actually works; a stale or cap-skipped earlier attachment is counted in a visible note instead of silently missing or failing the ask. The buffer is durable: persisted before each webhook ACK and reloaded on start, so a restart keeps the discussion; folded discussion lives in the durable session.

The buffer needs Telegram **group privacy mode off** (@BotFather → `/setprivacy` → Disable) to receive un-summoned messages at all. The channel resolves the bot's privacy flag once at startup and warns when it is on.

```ts
import { defaultTelegramRoute, telegramChannel, telegramEnvelope } from "@fastagent-sh/fastagent/telegram";

const botUsername = "my_bot";

telegramChannel({
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
- Documents, voice, video, and audio are downloaded to `<state root>/channels/telegram/files/<chat>/`. Their local paths are appended to the prompt so the agent can read them with tools.
- Download failures become `failed` events, never silent drops.

Downloaded files persist until the operator cleans them up. Treat `<state root>/channels/telegram/` like session state: git-ignored machine state that may need a volume or cleanup policy for long-running bots.

## State & restarts

The channel persists its state under `<state root>/channels/telegram/` (the state root resolves as `FASTAGENT_STATE_DIR` > `<dir>/.fastagent`; the channel-state convention puts engine state at the root, channel state under `channels/<kind>/`):

- `buffers.json` — the group-context buffer, written before each webhook ACK (an ACKed update is never redelivered, so ACK-then-persist would be a silent-loss window).
- `turns.json` — accepted turn intent, persisted pre-ACK and removed when the turn ends; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start.
- `files/<chat>/` — downloaded inbound files.

The per-session turn queue is **in-memory** (one turn at a time per session; a second summon waits instead of colliding on the engine lease), with a durable **intent** layer on top (`turns.json`). Turn durability is layered:

- **L1 (this channel).** An accepted turn's intent is persisted before the webhook ACK, then removed when the turn completes. `start` has no graceful drain, so a crash **or** a rolling deploy exits mid-turn — but the intent survives and is replayed on the next start (the ACKed-but-un-completed window Telegram won't redeliver). This is **at-least-once**: replay re-runs the whole turn, so side-effecting tools re-run (safe for a Q&A bot; the bar for adding side-effecting ones) and, in a narrow pre-ACK crash window, a turn can run twice. A turn that keeps being interrupted mid-run is dropped after a few attempts and its asker is told to re-ask (this cannot distinguish a process-crashing turn from one repeatedly caught by deploys). Two residual windows are deliberately not covered: an answer produced but not yet delivered when the process dies is committed to the session, not replayed (the asker re-asks; the answer is in history); and if a state write fails outright (disk full), the turn is deferred to the next start rather than run untracked, which can replay it after later turns in the same session (a rare, disk-degraded reorder).
- **L2 (a K-axis backend).** Exactly-once delivery and deterministic step-replay need a durable queue with distributed-locking recovery and the engine's resume hook — deferred to the backend, not the channel.

The state home self-ignores (a nested `.gitignore`), so buffered chat content is never committable. A corrupt `buffers.json` or `turns.json` logs a warning and starts empty — the bot boots, the loss is visible. Single-process semantics: two processes must not share a state dir.

## Sending messages and files back (`telegram-send`)

`fastagent add telegram` also scaffolds `tools/telegram-send.ts`. Because tool names come from filenames, the agent can call the `telegram-send` tool with a `chatId` from the `[telegram: chat …]` envelope to send a text message or a local file back through the bot. It is also the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up, whose plain reply is not delivered anywhere; those turns have no `[telegram: chat …]` line, so the schedule's prompt (or the wake's) must name the target chat id.

## Limits

- Telegram messages are split to the 4096-character limit as valid HTML: a tag spanning a boundary is closed at the chunk end and reopened (with its attributes) at the next chunk start, and the split never cuts through a tag token — so a long `<pre>` code block stays formatted instead of degrading to a plain-text fallback.
- HTML parse failures fall back to plain text so a model formatting mistake does not lose the reply.
- Bot API 429 responses are retried with Telegram's `retry_after` hint.
- Audio/video transcription is not built in; the agent must use its own tools if it needs media content.
