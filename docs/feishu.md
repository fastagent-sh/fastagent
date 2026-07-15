---
title: Feishu channel (Lark compatibility)
status: current
---

# Feishu channel (Lark compatibility)

These channels turn a Feishu/Lark event-subscription webhook (`im.message.receive_v1`) into an agent turn and send the agent's reply back to the chat.

Feishu and Lark international are **one protocol on two clouds** — and in fastagent each cloud is its **own channel kind**, because a kind is the unit of route path, env namespace, state home, and onboarding:

| | `feishu` | `lark` |
|---|---|---|
| Cloud / console | `open.feishu.cn` (飞书) | `open.larksuite.com` (Lark international) |
| Factory / import | `feishuChannel` from `@fastagent-sh/fastagent/feishu` | `larkChannel` from `@fastagent-sh/fastagent/lark` |
| Webhook route | `POST /feishu` | `POST /lark` |
| Env vars | `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY` | `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`, `LARK_ENCRYPT_KEY` |
| State home | `<state root>/channels/feishu/` | `<state root>/channels/lark/` |
| Prompt envelope tag | `[feishu: chat …]` | `[lark: chat …]` |
| Send tool | `tools/feishu-send.ts` | `tools/lark-send.ts` |

**Feishu is the reference implementation.** Lark international reuses Feishu's event format, crypto,
cards, and turn engine through a compatibility profile, while degrading control-plane capabilities
that lag behind the primary cloud (currently app creation and application-config/webhook automation).
A tenant lives on exactly one cloud — pick the matching kind. One workspace can mount **both** (two
apps, two credential sets); they never share state.

Like the Telegram channel, the engine is request/reply: the channel holds the app credentials, streams a **live card** while the turn runs, and settles the same card into the final answer. Replies render as **Markdown** (an interactive card), which is the natural output format for an LLM — code blocks, tables, and links render properly.

## Add the channel

From an agent workspace, first ensure `.env` is covered by `.gitignore` or `.fastagentignore` — both
commands refuse to write platform credentials into a committable file:

```bash
fastagent add feishu   # 飞书: scaffolds + creates/configures the app; one version-publish action remains
fastagent add lark     # Lark international: scaffolds, opens the console, then collects the three credentials
```

Onboarding diverges by cloud on purpose: the feishu cloud supports CLI app creation (scan-to-create),
so `add feishu` creates an app only when no complete `FEISHU_APP_ID` / `FEISHU_APP_SECRET` pair exists.
A persisted pair with a missing Verification Token resumes Token capture for that same App; a complete
three-value set is kept. The intl cloud cannot complete that bound flow (its confirm-page ack endpoint
is broken), so a new/partial `add lark` setup opens Lark's unbound one-click launcher
(`/page/launcher?from=backend_oneclick`), then waits for App ID and App Secret and validates the pair.
A complete existing ID/Secret pair skips the launcher and opens that App's Events & Callbacks → Security
page directly (`/app/<id>/event?tab=safe`). Only that complete pair may reuse its existing Verification
Token; an orphaned Token is never attached to newly entered App credentials. A complete three-value set
already active in `.env` is kept as-is without reopening onboarding or revalidating it. After validation,
the CLI starts the same temporary tunnel as Feishu and tries the webhook-mode PATCH against this actual
app. Success switches the draft's Subscription mode and captures the Verification Token from the
challenge; only an explicit config-route HTTP 404 falls back to a hidden Token prompt plus manual
mode/URL setup. During `dev --tunnel`, that fallback opens the exact app's Events & Callbacks page and
prints the new Request URL on its own line for copying. A successfully completed onboarding writes all
three values to the gitignored `.env`.

This creates (for the feishu kind; lark mirrors it):

```txt
channels/feishu.ts      # inbound event adapter + routing policy
tools/feishu-send.ts    # optional outbound send tool for the agent (text or markdown card)
```

It also appends the required env vars to `.env.example` when possible.

## How `add feishu` creates the app

`fastagent add feishu` runs the platform's **scan-to-create** flow (its official name; an OAuth 2.0
device-authorization grant) as its default behavior. The CLI opens a one-time confirmation link in your browser (valid ~10 minutes) — also
printed, so you can open it in the app or scan it as a QR code instead — and you confirm; the platform
creates an app from its agent template — bot capability, messaging scopes, and event subscriptions
pre-configured, plus the `application:application:patch` scope and the `im.message.receive_v1` event
fastagent piggybacks onto the creation link — and hands the credentials back. The CLI immediately
persists App ID/Secret to the gitignored `.env` before starting any later network work. The
platform-generated Verification Token has no read API; its only programmatic delivery is the
`url_verification` challenge sent during webhook registration, so the CLI captures it by running a
throwaway registration against an ephemeral tunnel (needs `cloudflared`, same as `dev --tunnel`) and
persists it as a second stage. On a successful capture, `.env` contains:

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` — from the created app,
- `FEISHU_VERIFICATION_TOKEN` — captured from the registration challenge.

If the process is interrupted or the temporary tunnel/token capture fails, the already-created App ID
and Secret remain durable. Re-running `add feishu` resumes Token capture for that App instead of minting
a second one; the CLI also prints the exact console location for manually copying the Token into `.env`.

One console action remains, and the CLI opens the page for it at the end of the scan: **create + publish
a version** (self-approved on your own tenant). The switch from the
template's long-connection mode to webhook only takes effect on publish; the subscription mode cannot
be set at creation (the platform excludes it from the creation link — official SDK: "sensitive
config … cannot travel") and version publishing has no open API (see Limits). It is ONE click ever:
after it, `fastagent dev --tunnel` / `deploy --run` re-register only the Request URL, which applies
immediately.

## Configure the app by hand (developer console)

Create a **custom app** in the developer console ([open.feishu.cn/app](https://open.feishu.cn/app) or [open.larksuite.com/app](https://open.larksuite.com/app)), then:

1. **Enable the bot capability** (App Features → Bot).
2. **Permissions** — add:
   - `im:message.p2p_msg:readonly` — receive direct messages,
   - `im:message.group_at_msg:readonly` — receive group messages that @mention the bot,
   - `im:message:send_as_bot` — send replies,
   - `im:resource` — download message images/files,
   - the card scope ("Create and update card") — the live preview streams through a card entity.
3. **Events & Callbacks** — subscribe to `im.message.receive_v1`, copy the **Verification Token**, and (recommended) set an **Encrypt Key**.
4. Put the credentials in the run-root `.env` (the kind's namespace):

```bash
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_VERIFICATION_TOKEN=...
FEISHU_ENCRYPT_KEY=...   # optional but recommended; must match the console exactly
```

5. **The event Request URL registers itself** (Feishu tenants): `fastagent dev --tunnel` (and
   `fastagent deploy … --run`) call the application-config API to point the app's event subscription at
   `https://<host>/feishu` (or `/lark`) — webhook mode. This needs the
   `application:application:patch` scope — `add feishu` requests it at creation; for a hand-made app
   add it under Permissions in the console. Lark is probed rather than pre-judged: `add lark` and the
   registrar both try the same API. If this app receives the previously observed config-route 404,
   switch **Subscription mode to webhook** and set the URL in the console by hand — with the server
   **running** (the platform verifies it with a `url_verification` challenge this channel answers).
   `dev --tunnel` opens this app page automatically on that 404 fallback and prints the Request URL as
   a standalone copy target.

6. **Create a version and publish** the app (a tenant admin approves it), then add the bot to a chat.

## Scaffolded channel

A minimal channel module looks like this (`channels/feishu.ts`; the lark kind mirrors it with `larkChannel` from `@fastagent-sh/fastagent/lark` and `LARK_*` vars):

```ts
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";

export default feishuChannel({
  appId: process.env.FEISHU_APP_ID ?? "",
  appSecret: process.env.FEISHU_APP_SECRET ?? "",
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "",
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
  onError: (failed) => `⚠️ ${failed.details}`, // dev transparency; drop for a public bot
});
```

`appId`, `appSecret`, and `verificationToken` are required; construction fails when any is empty, so a public endpoint never silently accepts forged events or fails later without credentials.

## Event verification

Two modes, decided by the console's Encrypt Key setting and mirrored by the `encryptKey` option:

- **Encrypt Key set (recommended):** ordinary events arrive AES-256-CBC encrypted with `X-Lark-Signature` headers. The channel verifies the signature over the raw body, decrypts, and **refuses plaintext events entirely** — accepting both would let a forger skip the stronger check.
- **No Encrypt Key:** events arrive in plaintext and are authenticated by the Verification Token (constant-time compare).

Request URL verification is the platform-documented narrow exception to event signatures. With an
Encrypt Key, its `url_verification` body is encrypted but carries no event-signature headers: the
channel decrypts it, admits only that exact type, constant-time checks the Verification Token, and
returns the challenge. Every ordinary encrypted event still requires a valid signature. See Feishu's
[webhook setup](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server)
and [event security](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case)
documentation.

## Routing policy

The channel consumes only `im.message.receive_v1`; every other event type is ACKed and dropped before `route` runs.

By default, Feishu uses the canonical `defaultFeishuRoute`; the Lark subpath exposes the same policy as
its branded `defaultLarkRoute` compatibility alias:

- **p2p chats always answer**,
- **groups answer only on an @mention of THIS bot** — matched from the platform's `mentions` array by the bot's `open_id` (resolved once at startup via `bot/v3/info`), never a text scan, so a pasted `@bot` in a code block does not summon,
- **non-user senders are ignored** — a message from another bot/app never summons (two bots answering each other loop forever).

Override `route(event)` to customise; it returns:

```ts
type FeishuRoute = {
  session?: string;
  chatId?: string;
  text?: string;
} | null;
```

Return `null` to ignore the event. Omitted fields default from the message. The canonical
`feishuEnvelope(event)` builds the default prompt envelope (chat/sender metadata, group note, reply
marker, decoded body) for custom Feishu routes. The Lark subpath exposes `larkEnvelope(event)`, which
reuses that builder with the `[lark: …]` compatibility tag.

### Group visibility is scope-gated

With the default `im:message.group_at_msg:readonly` scope, the platform delivers **only messages that @mention the bot** — un-mentioned group discussion never reaches the channel at all. Receiving every group message requires the sensitive `im:message.group_msg` scope (custom apps only, tenant-admin approval). This is why the Telegram channel's un-summoned context buffer has no counterpart here yet: it becomes meaningful exactly when that scope is granted.

Practical consequences in groups:

- a **bare image/file** posted without text cannot summon (an image message has no mentions) and, under the default scope, is not even delivered — put the ask and the attachment in ONE message (typing text and pasting an image together sends a rich-text `post` message, which carries text + images + @mentions),
- or **reply to the attachment** and @mention the bot — the channel fetches the replied-to message and loads its attachments (see below).

## Threads and sessions

Topic groups are handled automatically:

- if the message carries a `thread_id` (a topic group), the default session is `chat:thread` and the reply stays inside the topic (`reply_in_thread`),
- otherwise the default session is `chat`, and group replies quote the summoning message.

A group answers one shared session: turns are serialized per session (FIFO) instead of failing fast as `session busy`; different sessions run in parallel. A summon queued behind another turn immediately gets a reply-quoted "⏳ Queued" card (configure `queueNoticeDelayMs` only if an intentional delay is desired). Each queued card quotes its own source message, including in p2p, so concurrent card mounts remain attributable. When that turn starts, its live preview takes over the same card entity and settles the final answer there: no second reply and no visible "recalled a message" tombstone.

## Streaming behavior

The live preview is ONE **streaming card** (a card entity in streaming mode):

- an immediate "💭 Thinking…" card, reply-quoted under the asker in groups; or, for a queued turn, the already-mounted reply-quoted "⏳ Queued" card updated in place,
- tool-call previews + partial answer text, pushed as full-text snapshots (the client renders the typewriter effect),
- on completion, the same card settles into the final answer as Markdown (streaming off).

Card snapshots ride the cardkit quota (50 QPS per app, 10 QPS per card entity, no edit ceiling) — deliberately **not** the 5 QPS per-chat message quota or the 20-edit cap on text messages, which is what makes a live preview viable on this platform at all.

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
- files / audio / video are downloaded to `<state root>/channels/<kind>/files/<chat>/` and listed in the prompt so the agent reads them with its tools,
- a **reply summon** fetches the replied-to message (its content is not in the event), injects its text into the prompt, and loads its attachments too — "@bot summarize this" as a reply to a file works.

## State & restarts

The channel persists its state under `<state root>/channels/<kind>/` (`channels/feishu/` or `channels/lark/` — two mounted kinds never share stores):

- `turns.json` — accepted turn intent, persisted pre-ACK and removed when the turn ends; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start (L1, at-least-once, with a poison-turn ceiling — the same lifecycle semantics as Telegram, see [design/core.md](design/core.md)),
- `files/<chat>/` — downloaded inbound files.

Like Telegram, this L1 layer has no completed-delivery ledger. Feishu/Lark document that duplicate
pushes can occur, so a duplicate arriving after its turn was removed can run again. The channel keeps
that at-least-once limitation shared rather than adding a platform-specific reliability mechanism.

The state home self-ignores (a nested `.gitignore`). Single-process semantics: two processes must not share a state dir.

## Sending messages back (`feishu-send` / `lark-send`)

`fastagent add feishu` also scaffolds `tools/feishu-send.ts` (lark: `tools/lark-send.ts`): the agent can send plain text or a Markdown card to any chat by id. It is the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up; those turns have no `[feishu: chat …]` envelope line, so the schedule's prompt must name the target chat id.

## Limits

- Webhook (event subscription) mode only. The platform's WebSocket long-connection mode — attractive because it needs no public URL — requires the official SDK and a non-HTTP channel seam; a later tier.
- `add feishu` creates the app from the platform's agent template, whose event subscription starts in
  long-connection mode — the CLI flips the config to webhook during the token capture, but the flip
  only takes effect once a **version is published** (the dispatcher serves the published snapshot; a
  pure URL change applies immediately, a mode change does not). The subscription mode cannot travel on
  the creation link (the platform excludes sensitive config from addons) and version publishing has no
  open API — so this is the one console click, spent right at `add` time (the CLI opens the page).
- Bound CLI app creation is feishu-only: the intl cloud's confirm-page ack endpoint is broken (every
  ack renders as "Link expired"). `add lark` therefore uses the unbound launcher + guided credential
  paste, then actively probes the config API: automatic mode/token bootstrap on success; manual
  Token + Subscription mode/URL only on an explicit route-level 404.
- The un-summoned group context buffer (Telegram parity) is gated on the sensitive `im:message.group_msg` scope; not yet implemented.
- The sender in events carries only ids (no display name) — prompts attribute messages as `user <open_id>`. Resolving names needs a contacts scope; a custom `route` can enrich the envelope.
- Events must be ACKed within ~3 seconds; the channel persists the turn intent and ACKs immediately, so slow turns are never the webhook's problem.
- Rate-limit rejects are retried (bounded); message sends to one chat are capped by the platform at 5 QPS.
