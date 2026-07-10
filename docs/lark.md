---
title: Lark / Feishu channel
status: current
---

# Lark / Feishu channel

The Lark channel turns a Feishu/Lark event-subscription webhook (`im.message.receive_v1`) into an agent turn and sends the agent's reply back to the chat.

Like the Telegram channel, it is request/reply: the channel holds the app credentials, streams a **live card** while the turn runs, and settles the same card into the final answer. Replies render as **Markdown** (a Feishu interactive card), which is the natural output format for an LLM — code blocks, tables, and links render properly.

It works with both brands of the platform: Feishu (`open.feishu.cn`, the default) and Lark international (`open.larksuite.com`, via the `baseUrl` option).

## Add the channel

From an agent workspace:

```bash
fastagent add lark --create-app   # recommended: creates + configures the app itself, no developer console
fastagent add lark          # scaffold only; configure the app by hand (next section)
```

This creates:

```txt
channels/lark.ts      # inbound event adapter + routing policy
tools/lark-send.ts    # optional outbound send tool for the agent (text or markdown card)
```

It also appends the required env vars to `.env.example` when possible.

## Create the app from the CLI (`--create-app`)

`fastagent add lark --create-app` runs the platform's **scan-to-create** flow (its official name; an
OAuth 2.0 device-authorization grant). The CLI first asks which platform your account is on — the two
brands have separate accounts hosts, and each confirm page accepts only its own app (the Feishu page
refuses a Lark scan and vice versa); an existing `LARK_BASE_URL` skips the question. It then prints a
one-time link (valid ~10 minutes); open it in Feishu or Lark — scan it as a QR code or just click it —
and confirm; the platform creates an app from its agent template — bot capability, messaging scopes,
and event subscriptions pre-configured — and hands the credentials back. fastagent then reads the
platform-generated Verification Token over the API and writes everything to `.env`:

- `LARK_APP_ID` / `LARK_APP_SECRET` — from the created app,
- `LARK_VERIFICATION_TOKEN` — read back via the app-config API,
- `LARK_BASE_URL` — set to `https://open.larksuite.com` automatically when the confirming user is on
  a Lark (international) tenant.

The scan refuses to run when `.env` is not gitignored (real credentials must never land in a
committable file). After the scan: `fastagent dev --tunnel` — the event Request URL is registered
automatically (next section); no console visit at any step.

## Configure the app by hand (developer console)

Create a **custom app** in the [Feishu developer console](https://open.feishu.cn/app) (or the Lark equivalent), then:

1. **Enable the bot capability** (App Features → Bot).
2. **Permissions** — add:
   - `im:message.p2p_msg:readonly` — receive direct messages,
   - `im:message.group_at_msg:readonly` — receive group messages that @mention the bot,
   - `im:message:send_as_bot` — send replies,
   - `im:resource` — download message images/files,
   - the card scope ("Create and update card") — the live preview streams through a card entity.
3. **Events & Callbacks** — subscribe to `im.message.receive_v1`, copy the **Verification Token**, and (recommended) set an **Encrypt Key**.
4. Put the credentials in the run-root `.env`:

```bash
LARK_APP_ID=cli_...
LARK_APP_SECRET=...
LARK_VERIFICATION_TOKEN=...
LARK_ENCRYPT_KEY=...   # optional but recommended; must match the console exactly
```

5. **The event Request URL registers itself** (Feishu tenants): `fastagent dev --tunnel` (and
   `fastagent deploy … --run`) call the application-config API to point the app's event subscription at
   `https://<host>/lark` — webhook mode, applied immediately, no version publish. This needs the
   `application:application:self_manage` scope (the agent template includes it). **Lark international
   lags here**: `open.larksuite.com` does not expose the config API yet, so intl tenants set the URL in
   the console by hand — with the server **running** (the platform verifies the URL with a
   `url_verification` challenge this channel answers). The registrar keeps attempting the API and
   degrades to that instruction, so intl registration starts working the day the platform ships it.

6. **Create a version and publish** the app (a tenant admin approves it), then add the bot to a chat.

## Scaffolded channel

A minimal channel module looks like this:

```ts
import { larkChannel } from "@fastagent-sh/fastagent/lark";

export default larkChannel({
  appId: process.env.LARK_APP_ID ?? "",
  appSecret: process.env.LARK_APP_SECRET ?? "",
  verificationToken: process.env.LARK_VERIFICATION_TOKEN ?? "",
  encryptKey: process.env.LARK_ENCRYPT_KEY || undefined,
  // Lark international tenants:
  // baseUrl: "https://open.larksuite.com",
  onError: (failed) => `⚠️ ${failed.details}`, // dev transparency; drop for a public bot
});
```

`appId`, `appSecret`, and `verificationToken` are required; construction fails when any is empty, so a public endpoint never silently accepts forged events or fails later without credentials.

## Event verification

Two modes, decided by the console's Encrypt Key setting and mirrored by the `encryptKey` option:

- **Encrypt Key set (recommended):** every event arrives AES-256-CBC encrypted with `X-Lark-Signature` headers. The channel verifies the signature over the raw body, decrypts, and **refuses plaintext events entirely** — accepting both would let a forger skip the stronger check.
- **No Encrypt Key:** events arrive in plaintext and are authenticated by the Verification Token (constant-time compare).

The `url_verification` challenge is answered in both modes (it arrives encrypted too when a key is set).

## Routing policy

The channel consumes only `im.message.receive_v1`; every other event type is ACKed and dropped before `route` runs.

By default, `larkChannel` uses `defaultLarkRoute`:

- **p2p chats always answer**,
- **groups answer only on an @mention of THIS bot** — matched from the platform's `mentions` array by the bot's `open_id` (resolved once at startup via `bot/v3/info`), never a text scan, so a pasted `@bot` in a code block does not summon,
- **non-user senders are ignored** — a message from another bot/app never summons (two bots answering each other loop forever).

Override `route(event)` to customise; it returns:

```ts
type LarkRoute = {
  session?: string;
  chatId?: string;
  text?: string;
} | null;
```

Return `null` to ignore the event. Omitted fields default from the message. The exported `larkEnvelope(event)` builds the default prompt envelope (chat/sender metadata, group note, reply marker, decoded body) for reuse in a custom route.

### Group visibility is scope-gated

With the default `im:message.group_at_msg:readonly` scope, the platform delivers **only messages that @mention the bot** — un-mentioned group discussion never reaches the channel at all. Receiving every group message requires the sensitive `im:message.group_msg` scope (custom apps only, tenant-admin approval). This is why the Telegram channel's un-summoned context buffer has no counterpart here yet: it becomes meaningful exactly when that scope is granted.

Practical consequences in groups:

- a **bare image/file** posted without text cannot summon (an image message has no mentions) and, under the default scope, is not even delivered — put the ask and the attachment in ONE message (typing text and pasting an image together sends a rich-text `post` message, which carries text + images + @mentions),
- or **reply to the attachment** and @mention the bot — the channel fetches the replied-to message and loads its attachments (see below).

## Threads and sessions

Topic groups are handled automatically:

- if the message carries a `thread_id` (a topic group), the default session is `chat:thread` and the reply stays inside the topic (`reply_in_thread`),
- otherwise the default session is `chat`, and group replies quote the summoning message.

A group answers one shared session: turns are serialized per session (FIFO) instead of failing fast as `session busy`. A summon that keeps waiting gets a "⏳ Queued" notice — **delayed** (default 5s, `queueNoticeDelayMs`): the notice cannot morph into the answer (text vs card), so its cleanup is a recall, which Lark renders as a visible "recalled a message" line — a fast turnover therefore sends no notice at all, and only a genuinely long wait pays that tombstone. Different sessions run in parallel.

## Streaming behavior

The live preview is ONE **streaming card** (a Feishu card entity in streaming mode):

- an immediate "💭 Thinking…" card, reply-quoted under the asker in groups,
- tool-call previews + partial answer text, pushed as full-text snapshots (the client renders the typewriter effect),
- on completion, the same card settles into the final answer as Markdown (streaming off).

Card snapshots ride the cardkit quota (50 QPS, no edit ceiling) — deliberately **not** the 5 QPS per-chat message quota or the 20-edit cap on text messages, which is what makes a live preview viable on this platform at all.

Degrade tiers, all visible in the operator log:

- card creation/mount fails → a static text placeholder; the final answer lands as ONE text edit (or fresh sends),
- the platform closes streaming mid-turn (idle timeout) → the preview freezes; the settle still lands,
- an answer longer than one card (~20 KB) settles the card with the first chunk and sends the rest as follow-up messages,
- an empty answer leaves `(no reply)`; a suppressed error notice deletes the card, leaving no residue.

## Failures

Two audiences, like the Telegram channel:

- **Operator log**: always receives the full diagnostic details.
- **Chat user**: receives `onError(failed)` if provided; otherwise a neutral default keyed on `retryable`.

## Files and images

Message payloads are resolved by the channel before the agent turn runs — all as **primary** inputs (a load failure becomes a `failed` event, never a silent drop):

- images (`image` messages, or images inside a rich-text `post`) are downloaded and passed as `prompt.images` — the selected model must support vision,
- files / audio / video are downloaded to `<state root>/channels/lark/files/<chat>/` and listed in the prompt so the agent reads them with its tools,
- a **reply summon** fetches the replied-to message (its content is not in the event), injects its text into the prompt, and loads its attachments too — "@bot summarize this" as a reply to a file works.

## State & restarts

The channel persists its state under `<state root>/channels/lark/`:

- `turns.json` — accepted turn intent, persisted pre-ACK and removed when the turn ends; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start (L1, at-least-once, with a poison-turn ceiling — same layering as the Telegram channel, see [design/core.md](design/core.md)),
- `seen.json` — a bounded dedup ring of accepted `message_id`s: the platform documents duplicate pushes and its own guidance is to dedup on `message_id`; without this, a late redelivery after a completed turn would re-run it,
- `files/<chat>/` — downloaded inbound files.

The state home self-ignores (a nested `.gitignore`). Single-process semantics: two processes must not share a state dir.

## Sending messages back (`lark-send`)

`fastagent add lark` also scaffolds `tools/lark-send.ts`: the agent can send plain text or a Markdown card to any chat by id. It is the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up; those turns have no `[lark: chat …]` envelope line, so the schedule's prompt must name the target chat id.

## Limits

- Webhook (event subscription) mode only. The platform's WebSocket long-connection mode — attractive because it needs no public URL — requires the official SDK and a non-HTTP channel seam; a later tier.
- `--create-app` creates the app with the platform's agent template, whose event subscription starts in
  long-connection mode — the first `dev --tunnel` / `deploy --run` flips it to webhook automatically.
- The un-summoned group context buffer (Telegram parity) is gated on the sensitive `im:message.group_msg` scope; not yet implemented.
- The sender in events carries only ids (no display name) — prompts attribute messages as `user <open_id>`. Resolving names needs a contacts scope; a custom `route` can enrich the envelope.
- Events must be ACKed within ~3 seconds; the channel persists the turn intent and ACKs immediately, so slow turns are never the webhook's problem.
- Rate-limit rejects are retried (bounded); message sends to one chat are capped by the platform at 5 QPS.
