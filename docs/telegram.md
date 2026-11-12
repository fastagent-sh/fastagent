---
title: Telegram channel
description: "Serve your agent as a Telegram bot: long polling or webhook, live streamed replies, group-chat behavior, and durable at-least-once turn replay."
status: current
---

# Telegram channel

The Telegram channel turns a Telegram Bot API update, polled or sent to a webhook, into a message to the agent and sends the agent's reply back to the chat.

Telegram is request/reply: the channel holds the bot token, streams a live preview message while the turn runs, and edits it into the final answer.

## Add the channel, then set up its bot

From an agent directory:

```bash
fastagent add telegram            # the program: the channel file and its send tool
fastagent channels setup telegram # the bot, and this instance's token for it
fastagent dev                     # polls Telegram: no tunnel, no public URL
```

`add telegram` changes the program only. It creates:

```txt
src/channels/telegram.ts      # inbound adapter (long polling or webhook) + routing policy
src/tools/telegram-send.ts    # optional outbound send tool for the agent (message or file)
```

and lists the variables they read in `.secrets/.env.example`. It asks nothing and creates no bot.

`channels setup telegram` sets up the bot for **one instance**: it opens [@BotFather](https://t.me/BotFather), where you send
`/newbot` and copy the token, asks for it (hidden input), checks it with Telegram (`getMe`), and keeps it in the
instance's value file, `.secrets/.env` for the development instance. A coding agent runs `channels setup telegram --json`:
the person pastes the token on a page on this machine, never in the agent's conversation. It is safe to run again: a token
Telegram still accepts is kept, one it refuses is asked for again. `fastagent dev` runs it for you the first time it finds
the bot without a token, at a terminal.

That is all `fastagent dev` needs: it polls Telegram (`getUpdates`), so there is no public URL, no tunnel and no webhook
secret. Message the bot.

## Long polling or webhook

How the channel receives is the instance's choice, `channels.telegram.ingress` in its configuration (`webhook` or
`connection`, which for Telegram is long polling; `channels setup telegram --ingress` writes it). Unset, `dev` polls and
everything else receives by webhook, since a host that scales to zero is woken by a request.

- **Long polling** needs only `TELEGRAM_BOT_TOKEN`. It takes the bot's webhook away first (`getUpdates` does not work
  while one is set) and says so. A bot is polled by one process or reached by one webhook, never both: a second process
  polling the same bot gets a 409 from Telegram, and the connection ends with `another process polls this bot` after three
  retries, five seconds apart. A network failure after it is running is retried with a growing wait; a refused token or a
  webhook set under the poll ends it with the reason.
- **Webhook** also needs `TELEGRAM_SECRET_TOKEN`, any random string that verifies inbound updates
  (`channels setup` makes one for an instance that receives by webhook and keeps it in its value file, such as
  `.secrets/.env`, gitignored by the scaffolded `.secrets/.gitignore`). At a public URL, `https://<host>/telegram`, the instance points Telegram at itself on every
  start (`http.publicUrl`); see [Deploy](deploy.md).

To try the webhook path locally, name `webhook` for the channel in the dev instance's `fastagent.json` and add
`--tunnel`: with `cloudflared` installed, FastAgent opens a public HTTPS URL and calls `setWebhook` with it. The tunnel
itself is independent of how a channel receives.

## Scaffolded channel

A minimal channel module looks like this:

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

`botToken` is required, and `secretToken` too for `telegramChannel`. Construction fails if either is empty, so a public endpoint never silently accepts forged updates or fails later without a bot token. The two channels take the same policy options (`route`, `onError`, `botUsername`); a channel that only ever receives one way can default-export `telegramChannel` or `telegramPollingChannel` alone.

## Routing policy

The channel routes only **fresh** `message` / `channel_post` updates. Everything else — edited messages (each typo fix would re-answer), edited channel posts, callback queries — is ACKed and dropped **before** `route` runs, so a custom route never sees them.

By default, `telegramChannel` uses `defaultTelegramRoute`:

- private chats always answer,
- groups answer when the message replies to THIS bot — matched by the bot id parsed from the token, so a reply to another bot in a multi-bot group stays silent, precisely from the first update (no getMe race),
- groups answer on an `@botname` mention when the bot username is known — detected from Telegram's own `mention` entities, not a text scan, so `@fast` never matches `@fastagent`, and an `@botname` inside a code block or a URL does not summon (it is not a mention entity).

A slash command does **not** summon in a group (bare or directed like `/cmd@botname`) — it was noise; a bot that wants commands adds a custom `route`. The one exception is a `/stop` [addressed to this bot](#stopping-a-running-turn): refusing it would leave the stop buffered as ordinary discussion while the run it meant to stop kept going. Override `route` to decide whether and where to answer; a custom route owns its own group-summon policy — including `/stop`, which is gated by the route like any other message and aborts the session of the conversation the route returns. Reuse `defaultTelegramRoute` (as below) or the exported `telegramStop(update, { botUsername, botId })` to keep the command working. When reusing `defaultTelegramRoute`, pass your bot's identity (`botUsername` and/or `botId`) — group summon needs it, and a bare call answers only private chats (fail-closed: "is this addressed to me?" cannot be yes without knowing who "me" is).

## Group chats

A group's main timeline is one conversation per sender (`<chat>#<sender>`), each with a session of its own, and a topic (`<chat>:<thread>`) is one shared conversation. A sender is told what the others said (the buffer below) and what the agent answered them, attributed, but another sender's request is not part of their task. To keep it coherent:

- **A reply belongs to the session of the message it replies to.** A reply in a group's main timeline to an answer, or to a request the agent took, is steered into the session that holds it, whoever sends it: Carol replying "what time?" to Bob's answer reaches Bob's session. The channel remembers the most recent ~1000 such messages (`owners.json`); a reply to anything else, or to a message older than that, is an ordinary message of its sender. A topic and a private chat have one session already.
- **A stop is the sender's own.** `/stop` stops the sender's session in a group's main timeline, not another sender's task.
- **Steered turns.** A summon that lands while the session is busy is sent at once, in arrival order, with `whenBusy: "steer"`: the agent takes it at its next step, after its current tool calls. If it takes it before the run ends, the two messages end with one shared answer, which is delivered once; a message taken after the run ended gets its own answer. In a group the answer quotes the first asker's message, so a later asker whose input was answered with it gets a short "Answered together with an earlier message above" reply under their own message. The discussion a steered input would fold is read once, by the turn that started first; what arrived since is read by the next turn. While an input waits for that answer, the bot marks its message with 👀 and replaces it with 👌 when it is answered (a failed turn clears the mark); Telegram does not let a bot react with ✅, and the first message of a run shows its own preview instead. Different conversations run in parallel.
- **Sender attribution.** Each message is prefixed with its sender, and a group is flagged in the prompt, so the model can tell participants apart and answer "summarize the discussion".
- **Context buffer.** The channel keeps a per-chat buffer of **un-summoned** messages, **for 14 days** and not by size, and folds what came after the ask its session was last sent, up to the turn's own ask, into each turn — annotated with message ids and reply relations, so "the one Alex replied to" resolves. Attachments posted without summoning ride along too: the next summon downloads the most recent few files (readable by the agent's tools) and includes recent photos as vision inputs (photos ride along without per-photo attribution — the fold marks every attachment line with `[photo]`/`[document: …]` next to its sender, caption or not), so "summarize the file from earlier" actually works; a stale or cap-skipped earlier attachment is counted in a visible note instead of silently missing or failing the ask. The buffer is durable: persisted before the update is acknowledged (a webhook's 200, or the next `getUpdates` offset) and reloaded on start, so a restart keeps the discussion. Nothing is cleared when a turn folds it: the folded discussion lives in the session, in the instance's storage, and the buffer only drops what is older than 14 days. How much of it one turn folds is a share of the model's context window (a tenth of it, at two characters a token; 40,000 characters for a 200,000-token model), newest first, and the prompt says how many earlier messages it left out. A chat that lost messages to the 14 days says so to the next turn that reads it (`messages here older than 14 days are no longer kept`), so a quiet chat is never taken for an empty one.

The buffer needs Telegram **group privacy mode off** to receive un-summoned messages at all: with it on, a bot in a group only sees @mentions, replies to it and commands. In @BotFather send `/setprivacy`, choose the bot, choose Disable, **then remove the bot from each group and add it again**: Telegram applies the change to a group only when the bot joins it. A bot that is a group administrator receives every message of that group whatever the setting says.

`fastagent channels setup telegram` reads the bot's flag (`getMe`'s `can_read_all_group_messages`) when it checks the token and lists this among the steps left when the mode is on, or when Telegram did not report it. The channel reads it once at startup and warns with the same steps when it is on. The flag is the bot's own setting, so it does not say whether a particular group delivers everything: an administrator group does with it on, and a group the bot was in before the change does not with it off, until the bot is added again. If `getMe` fails at startup, the warning says the privacy check was skipped.

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

`route(update)` returns:

```ts
type TelegramRoute = {
  conversation?: string; // which conversation, and so which session; default `<chat>` or `<chat>:<thread>`
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

- if `message_thread_id` is present, the default conversation is `<chat>:<thread>`, shared by everyone in the topic,
- in a private chat it is `<chat>`,
- in a group's main timeline it is `<chat>#<sender id>`: one per sender, so one person's long task does not hold up
  another's question. A message with no `from` (a channel post) shares `<chat>`. A message an anonymous admin sends
  on behalf of the group carries a fake `from` that is the same for every such admin, so they share one session,
  `<chat>#<that id>`, and can hold each other up like any one sender's follow-ups.

Each conversation has its own session, which the channel creates the first time it is asked there and records in
`<state root>/channels/telegram/sessions.json`. A new topic starts a session of its own.

Replies are sent back to the same thread unless `route` overrides `threadId`.

Messages for one chat are sent to its session in arrival order and steered into whatever is running there, including work the channel did not start, such as a self-scheduled wake-up. A refusal (the session already holds 20 queued messages) is told to the asker. Different conversations run concurrently.

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

## Stopping a running turn

A `/stop` **addressed to this bot** aborts the chat's active turn (asks not yet taken are independent and keep
running — send `/stop` again when one starts). No configuration is needed: stopping the running turn is
part of serving.

Four ways to address it, all equivalent: a bare `/stop` in a private chat, `/stop@<thisbot>`,
`@<thisbot> /stop`, and a bare `/stop` replying to one of the bot's own messages.

**In a group, a bare `/stop` is not the command** — it stays ordinary discussion and lands in the
context buffer like any other message. Telegram hands a bare command to every bot in the group, and
only promises to deliver it when this bot spoke last, so it addresses no one: acting on it would let a
bystander's ask for a different bot abort this bot's run. Say `@<thisbot> /stop`, or reply to the bot
with `/stop`, instead. `/stop@<otherbot>` is likewise not this bot's.

"Stays discussion" is what `defaultTelegramRoute` does with it. A permissive custom `route` that
answers every group message will instead run the bare `/stop` as an ordinary turn — queued behind the
run it meant to stop. If your route is that permissive, decide what to do with an unaddressed stop
yourself: `telegramStop(update, { botUsername, botId })` tells you whether a stop is addressed to this
bot, and returning `null` for the rest keeps them out of the queue.

`/stop` runs through `route` like any other message: it aborts the session of the conversation the route resolves
(so a route that remaps `conversation` stops the session it actually runs), and a route that returns `null` for
the chat silences the command there too. Pass `botUsername` to `telegramChannel` whenever you also
pass a custom `route` (as the example above does) — the channel matches an addressed stop against its
OWN identity, which it otherwise only learns from `getMe`, and not at all if that call fails.

## Files and images

Telegram media are handled by the channel before the agent turn runs.

- Photos are downloaded, sent as image content, and resized by the harness before reaching the model. The selected model must support vision.
- Documents, voice, video, and audio are downloaded to `<state root>/channels/telegram/files/c-<chat>/` (`c-` plus the URL-encoded chat id). Their local paths are appended to the prompt so the agent can read them with tools.
- A download failure fails the turn with the reason, never a silent drop.

Downloaded files are kept: the path the agent was given stays readable for as long as the conversation can refer back to it, and nothing removes them. Treat `<state root>/channels/telegram/` like session state — git-ignored machine state that wants a volume, and a cleanup policy you choose, on a long-running bot that receives a lot of files.

## State & restarts

The channel persists its state under `<state root>/channels/telegram/`:

- `buffers/<chat>.json` — the group-context buffer, one file per chat (the chat id URL-encoded), written before each webhook ACK: that chat's un-summoned messages from the last 14 days (each with the time it was said) and the newest message the 14 days dropped. A push rewrites only its own chat's file, so what it costs depends on that chat and not on how many chats the bot is in. A file that cannot be read as a chat's record, an older shape included, is ignored with a warning and that chat starts empty. A chat's file is also tidied of what has expired when another chat's push comes at least an hour after the last tidy; one whose rewrite failed is left as it was, said in the log, and tried again at the next tidy. A chat with nothing left keeps its note of what it lost for one more 14 days, then its file is removed, so a bot does not keep a file for every chat it has ever seen.
- `asks.json` — per conversation and chat, its newest asks (message key and the message's id, which counts only within its chat); the Agent says which one the session holds, and a turn's fold starts after it. A `buffers.json` entry of an older shape (no message id) costs only its own chat's buffer.
- `sessions.json` — which session each conversation talks in.
- `turns.json` — accepted turn intent, persisted pre-ACK and removed once the reply has been delivered; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start, and one that already carries its answer is re-delivered instead of re-run.
- `files/c-<chat>/` — downloaded inbound files, one directory per chat. Kept across restarts, and never pruned by FastAgent (see above).

Each accepted turn is recorded in `turns.json` before the webhook ACK, and the answers already delivered in `delivered.json`:

- A crash or rolling deploy mid-turn replays the turn on the next start. Its message was sent with the update's id as
  its key, so the replay finds the message already sent and reads its end rather than sending it again; the agent
  answers an accepted message after a restart too. In a narrow pre-ACK window a turn can still be accepted twice, and
  a message the agent was answering when the process died may run its tools again: this is **at-least-once**.
- A turn interrupted repeatedly is dropped after a few attempts and its asker is told to ask again (or, if its
  answer was already recorded, the answer is sent).
- An answer produced but not delivered is re-sent on the next start without re-running the model. When Telegram
  cannot confirm a send, it may be sent twice rather than lost.
- If a state write fails (disk full), the turn is deferred to the next start, which can reorder it after later
  turns.

Exactly-once execution is not provided.

The state home lives under `.state/`, which the agent `.gitignore` excludes, so buffered chat content is not committable.

**What stays where, and for how long.** The buffer is a copy of what Telegram will not show a bot again, kept only so a later ask can read what was said before it. It is not the chat's history: the Bot API has no way to read that, and FastAgent does not become its store.

| | Kept | Until |
|---|---|---|
| Un-summoned messages (`buffers/`) | on the state volume | 14 days after they were said; a chat with nothing left, 14 more days |
| What a turn folded | in the session, in the instance's storage | as long as the session; FastAgent deletes no session |
| Downloaded files (`files/`) | on the state volume | never pruned (see above) |
| Docker, Fly, Railway | the `/data` volume | across deploys and restarts |
| AgentCore | managed storage at `/mnt/data` | reset by every deploy: the buffer and the sessions go together |

A person who asks the bot to forget what a group said cannot do it from the chat: delete `buffers/` (or one chat's file in it) and, for what a turn already folded, the session in the instance's storage. A corrupt `buffers.json` or `turns.json` logs a warning and starts empty — the bot boots, the loss is visible. One process owns the state root: a second `dev` or `start` of the same agent is refused.

## Sending messages and files back (`telegram-send`)

`fastagent add telegram` also scaffolds `src/tools/telegram-send.ts`, a tool named `telegram_send`: the agent calls it with a `chatId` from the `[telegram: chat …]` envelope to send a text message or a local file back through the bot. It is also the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up, whose plain reply is not delivered anywhere; those turns have no `[telegram: chat …]` line, so the schedule's prompt (or the wake's) must name the target chat id.

What the tool sends becomes part of that chat's discussion: Telegram never delivers a bot its own messages, so a digest a schedule posted would otherwise be unknown to the chat it went to. The next answered turn there sees it as `you (sent by the agent) (msg …): …`, up to 2,000 characters (longer is cut and marked `… (truncated)`), and like any buffered line it is evicted oldest-first when later discussion fills the buffer. It is recorded only when the channel is mounted in the same process as the tool — a serve, where schedules run. A process with no channel mounted (`fastagent invoke`) sends with `TELEGRAM_BOT_TOKEN`, and the tool's result says the message was not recorded. On AgentCore the channel is built on the first webhook, so a schedule that wakes a cold session sends without recording, and says so.

**Do not use it to answer the current turn** — the channel already delivers the reply, so calling the tool as well posts it twice. The scaffolded description says so. `src/tools/telegram-send.ts` is the package's, not authored glue: re-running `fastagent add telegram` rewrites it and keeps `src/channels/telegram.ts`, which is how an agent scaffolded by an earlier release picks up the current tool if it is double-posting.

## Limits

- Telegram messages are split to the 4096-character limit as valid HTML: a tag spanning a boundary is closed at the chunk end and reopened (with its attributes) at the next chunk start, and the split never cuts through a tag token — so a long `<pre>` code block stays formatted instead of degrading to a plain-text fallback.
- HTML parse failures fall back to plain text so a model formatting mistake does not lose the reply.
- Bot API 429 responses are retried with Telegram's `retry_after` hint.
- Audio/video transcription is not built in; the agent must use its own tools if it needs media content.
