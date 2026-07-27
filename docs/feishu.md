---
title: Feishu channel (Lark compatibility)
status: current
---

# Feishu channel (Lark compatibility)

These channels turn a Feishu/Lark `im.message.receive_v1` event—received by webhook or WebSocket long connection—into an agent turn and send the reply back to the chat.

Feishu and Lark international are **one protocol on two clouds**—and each remains its own channel kind, the unit of ingress identity, env namespace, state home, and onboarding:

| | `feishu` | `lark` |
|---|---|---|
| Cloud / console | `open.feishu.cn` (飞书) | `open.larksuite.com` (Lark international) |
| Webhook factory | `feishuChannel` from `@fastagent-sh/fastagent/feishu` | `larkChannel` from `@fastagent-sh/fastagent/lark` |
| WebSocket factory | `feishuWebSocketChannel` | `larkWebSocketChannel` |
| Ingress | WebSocket long connection, or webhook at `POST /feishu` | WebSocket long connection, or webhook at `POST /lark` |
| Always required | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | `LARK_APP_ID`, `LARK_APP_SECRET` |
| Webhook only | `FEISHU_VERIFICATION_TOKEN`; optional `FEISHU_ENCRYPT_KEY` | `LARK_VERIFICATION_TOKEN`; optional `LARK_ENCRYPT_KEY` |
| State home | `<state root>/channels/feishu/` | `<state root>/channels/lark/` |
| Prompt envelope tag | `[feishu: chat …]` | `[lark: chat …]` |
| Send tool | `tools/feishu-send.ts` | `tools/lark-send.ts` |

**Feishu is the reference implementation.** Lark international reuses Feishu's event format, crypto,
cards, and turn engine through a compatibility profile, while degrading control-plane capabilities
that lag behind the primary cloud (currently app creation and application-config/webhook automation).
A tenant lives on exactly one cloud — pick the matching kind. One workspace can mount **both** (two
apps, two credential sets); they never share state.

Both ingress modes feed the same request/reply engine: the channel holds the app credentials, streams a **live card** while the turn runs, and settles the same card into the final answer. Replies render as **Markdown** (an interactive card), so code blocks, tables, and links render properly.

## Add the channel

From an agent workspace, first ensure `.env` is covered by `.gitignore` or `.fastagentignore` — both
commands refuse to write platform credentials into a committable file:

```bash
fastagent add feishu   # interactive ingress choice + scan-to-create
fastagent add lark     # interactive ingress choice + guided console setup

# Non-interactive / explicit:
fastagent add feishu --ingress websocket --group-behavior context
fastagent add lark --ingress webhook --group-behavior mentions
```

Onboarding also asks for group behavior. **Context-aware groups (recommended)** is selected first: bare
human replies in a thread the Agent is part of invoke it, while other unsummoned group discussion is
durably buffered for the next `@Agent` turn. It requires the tenant-admin-approved
`im:message.group_msg` scope, which makes the platform deliver all group messages to the app.
**Mention-only (least privilege)** skips that scope; users must @Agent on every group turn, and neither
bare thread replies nor background buffering is available. This choice configures the remote
App's visibility; it does not add a second runtime routing mode. Without an interactive terminal the
choice must be explicit: a run without `--group-behavior` assumes context-aware for guidance but only
inspects and reports — requesting the sensitive scope requires `--group-behavior context`.

The ingress choice is persisted in `channels/<kind>.ts` by its factory (`feishuChannel`/`larkChannel` for webhook, or the corresponding `*WebSocketChannel` factory):

| | WebSocket | Webhook |
|---|---|---|
| Public URL / `--tunnel` | Not needed | Required |
| Runtime credentials | App ID + Secret | App ID + Secret + Verification Token; Encrypt Key optional |
| Scale-to-zero / App Sleeping | Not supported; keep one process running | Supported when no other always-on producer exists |
| Platform configuration | Long connection + publish | Webhook mode + Request URL + publish |

This is an **app-level onboarding choice**, not a runtime failover switch. The platform delivers through
one subscription mode at a time. To migrate later, change the channel factory and the console mode
together, then publish a version; changing only one side makes the bot deaf. Use separate apps when dev
and production intentionally use different modes.

Onboarding diverges by cloud on purpose: Feishu supports CLI app creation (scan-to-create), while Lark's
bound confirmation flow is broken and therefore uses the unbound launcher plus guided credential input.
Within either cloud, ingress determines the remaining work. WebSocket's runtime credential set stops at
the validated/persisted App ID/Secret pair; onboarding continues through group-permission guidance and
opens Events & Callbacks so the user can select long connection and publish.
Webhook continues through the existing temporary-tunnel challenge to capture the Verification Token and
configure the Request URL. For recommended context-aware groups, onboarding inspects the App's scopes,
adds `im:message.group_msg` to the draft through the application-config API when supported, and opens
Permissions for approval before publish. Lark's missing config API falls back to explicit manual
permission/Token/mode/URL steps. Re-running a partial setup reuses the complete App ID/Secret pair rather
than creating or attaching a different app.

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
creates an app from its agent template—bot capability, messaging scopes, and event subscriptions
pre-configured—and adds `im.message.receive_v1`. Onboarding requests
`application:application:patch` when it must configure webhook mode or the recommended group-context
scope. The CLI immediately persists App ID/Secret to the gitignored `.env` before starting later network
work.

For WebSocket, those two values are the complete runtime credential set. For webhook, the platform-
generated Verification Token has no read API; its only programmatic delivery is the `url_verification`
challenge, so the CLI captures it through a throwaway tunnel and persists it as a second stage. If that
stage is interrupted, re-running resumes Token capture for the same App rather than minting another.

Console completion remains: for context-aware groups, approve the sensitive `im:message.group_msg`
request first; then **create + publish a version**. The CLI adds the scope to the draft when the control
plane supports it and opens the Permissions page; a visible manual fallback handles unsupported Lark
config APIs. WebSocket keeps the template's long-connection mode; webhook flips it and registers a
Request URL. Mode and scope changes take effect only after publish, while later webhook URL changes apply
immediately. Version publishing and tenant-admin approval have no general automatic completion path.

## Configure the app by hand (developer console)

Create a **custom app** in the developer console ([open.feishu.cn/app](https://open.feishu.cn/app) or [open.larksuite.com/app](https://open.larksuite.com/app)), then:

1. **Enable the bot capability** (App Features → Bot).
2. **Permissions** — add:
   - `im:message.p2p_msg:readonly` — receive direct messages,
   - `im:message.group_at_msg:readonly` — receive group messages that @mention the bot,
   - `im:message.group_msg` — sensitive, tenant-admin-approved; required to buffer unsummoned group/thread context and accept bare replies in threads the Agent is part of,
   - `im:message:send_as_bot` — send replies,
   - `im:resource` — download message images/files,
   - `im:message:readonly` — OPTIONAL, and independent of the scope above: the channel fetches a replied-to message by id, so an ask can carry what it quotes. `add feishu|lark --group-behavior context` requests it alongside `im:message.group_msg` because they share one approval round. Without it group messages are still delivered and the thread rule still works; a quoted message degrades to a marker in the prompt. `im:message` (the read/write superset) also satisfies it,
   - the card scope ("Create and update card") — the live preview streams through a card entity.
3. **Events & Callbacks** — subscribe to `im.message.receive_v1`, then choose one mode:
   - **WebSocket:** choose long connection. No Verification Token, Encrypt Key, or Request URL is needed.
   - **Webhook:** choose webhook, copy the Verification Token, and optionally set an Encrypt Key.
4. Put the matching credentials in the run-root `.env`:

```bash
# Both modes
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...

# Webhook only
FEISHU_VERIFICATION_TOKEN=...
FEISHU_ENCRYPT_KEY=...   # optional but recommended; must match the console exactly
```

5. For webhook, `fastagent dev --tunnel` and `deploy … --run` register the Request URL. Feishu's API
   path needs `application:application:patch`; Lark may require manual mode/URL setup when its config API
   returns 404. WebSocket runs with ordinary `fastagent dev` and makes no registration call.
6. **Create a version and publish** the app, then add the bot to a chat.

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

The WebSocket form uses its transport-specific factory and has no webhook-only options:

```ts
import { feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";

export default feishuWebSocketChannel({
  appId: process.env.FEISHU_APP_ID ?? "",
  appSecret: process.env.FEISHU_APP_SECRET ?? "",
});
```

Credentials are checked when serving starts, before the host reports ready. Deployment planning can
therefore import the module and inspect its function/object shape before secrets have been provisioned.

## WebSocket lifecycle

`feishuWebSocketChannel` / `larkWebSocketChannel` wrap the official SDK lifecycle. `connect()` starts
`WSClient`, `ready` settles on its first successful handshake, and the SDK owns ordinary reconnects.
A transient disconnect therefore does not settle `closed` or make the already-ready health probe flap.
Exhausted retries or a non-retryable setup error reject `closed` and fail serving visibly. Framework
shutdown aborts the supplied signal; the adapter translates that single command into `WSClient.close()`
and resolves `closed`. There is deliberately no second public `close()` path. See Feishu's
[long-connection guide](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode).

## Webhook event verification

WebSocket authentication happens once while establishing the official-SDK connection. Webhook has two
security modes, decided by the console's Encrypt Key setting and mirrored by `encryptKey`:

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
- **an explicit group @mention always answers** — matched from the platform's `mentions` array by the bot's `open_id` (resolved once at startup via `bot/v3/info`), never a text scan, so a pasted `@bot` in a code block does not summon,
- in an **Agent-created group thread**, a bare user continuation answers without another @mention; a message that explicitly mentions only other people is instead buffered, while `@bot + @others` still answers,
- in a main group chat or a thread the Agent did not create, human messages without `@bot` are buffered and folded into the next explicit `@bot` turn in that same place,
- all non-user senders are ignored, preventing two bots from answering each other forever.

Override `route(event)` to customise; it returns:

```ts
type FeishuRoute = {
  session?: string;
  chatId?: string;
  text?: string;
} | null;
```

Return `null` to ignore the event. Omitted fields default from the message. A custom route is
authoritative: its `null` neither falls through to the built-in thread rule nor
enters the default context buffer. The canonical `feishuEnvelope(event)` builds the default prompt envelope (chat/sender metadata, group note, reply
marker, decoded body) for custom Feishu routes. The Lark subpath exposes `larkEnvelope(event)`, which
reuses that builder with the `[lark: …]` compatibility tag.

### Group visibility is scope-gated

With only `im:message.group_at_msg:readonly`, the platform delivers **only messages that @mention the bot** — unmentioned group/thread discussion never reaches the channel and therefore cannot be buffered. The sensitive `im:message.group_msg` scope (custom apps only, tenant-admin approval) plus a newly published app version delivers all group messages. FastAgent then invokes explicit `@bot` turns, plus bare messages in a thread where it takes part and has not heard a second human — both facts being what the channel itself observed, so a thread it joined before this deployment takes one mention to re-enter. Other human discussion is durably buffered per place (the chat, or a thread) and folded into that place's next answered turn.

Practical consequences in groups:

- without `im:message.group_msg`, a **bare image/file** cannot summon (it has no mention) and is not delivered — put the ask and attachment in one rich-text `post`, or reply to the attachment and @mention the bot,
- with that scope, a bare attachment inside a thread the Agent is part of is primary input and answered immediately; elsewhere it is buffered as background input for the next `@bot` turn in that place,
- buffered attachment failures degrade per resource with a visible prompt note; primary attachment failures still fail the turn visibly.

## Threads and sessions

The Agent behaves as a participant in the room, so where it answers and what it remembers follow the
place rather than the individual ask ([design note](design/participant-model.md)):

| Place | Session | Where the answer appears | Bare messages (no @) |
|---|---|---|---|
| Direct message | `<kind>:<chat_id>` | in the chat, unquoted | always answered |
| Group main timeline | `<kind>:<chat_id>` | in the room, quoting the ask | never — mention the bot |
| Group thread | `<kind>:<chat_id>:<thread_id>` | inside the thread | answered while the Agent takes part and no second human has been heard |
| Direct-message thread | `<kind>:<chat_id>:<thread_id>` | inside the thread | always answered — a p2p chat has one human, so there is nothing to disambiguate and no participation is recorded |

There are no session modes to choose. A room has one memory that everyone in it shares, so a colleague
can follow up on someone else's question; a thread is a separate place with its own.

**Starting a thread.** Mention the Agent inside a thread once (typically by replying to one of its
messages and creating a topic). It answers there, which makes it a participant, and every later bare
message in that thread reaches it. When a second person speaks in the thread, addressing becomes
ambiguous again and the Agent goes back to requiring a mention — while still listening, so the
discussion is folded into its next answered turn there.

Both halves are what the Agent HEARD, not a claim about who is really in the thread: nothing is read
back from the platform, so a thread it joined before this deployment — or before a lost
`thread-participants.json` — takes one mention to re-enter. Observations accumulate and are never
shed, so a thread in which two people have spoken keeps requiring a mention. A consequence worth
knowing: a thread where several people are present but only one has spoken *while the Agent was
listening* counts as two-party.

The thread's identity is `thread_id`. Feishu's `root_id` is NOT stable within a thread — it tracks the
reply chain and can differ between messages of one thread — so it is used for neither the session key
nor the context bucket. A message that quotes another always loads it as referenced input,
inside a thread or out of it — a quote is the user pointing at something that may predate the session.
An unreadable referent degrades to a marker instead of failing the turn.

Turns are serialized per session (FIFO) instead of failing fast as `session busy`. Since the session is
the place, **a whole group room is one queue**: a second person's `@Agent` in a busy room waits behind
an unrelated multi-minute turn (they see the "⏳ Queued" card). Different places
run concurrently, which is why a thread is the way to start work that should not queue behind the
room. Any turn queued behind another one immediately gets a
reply-quoted "⏳ Queued" card (configure `queueNoticeDelayMs` only if an intentional delay is desired).
The running turn takes over its queue card and settles the final answer in place: no second reply and no
visible "recalled a message" tombstone.

## Streaming behavior

Every answered turn uses ONE **streaming card** (a card entity in streaming mode):

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
- **Chat user**: every answered turn receives `onError(failed)` if provided, otherwise a neutral default keyed on `retryable`.

When the serve runs with `sessionControl: true`, a summon whose whole message is "stop" or "cancel"
aborts the session's active turn instead of becoming a turn (queued asks keep running; without
session control it answers with a visible "not enabled" notice).

## Files and images

Message payloads are resolved by the channel before the agent turn runs — all as **primary** inputs (a load failure becomes a `failed` event, never a silent drop):

- images (`image` messages, or images inside a rich-text `post`) are downloaded and passed as `prompt.images` — the selected model must support vision,
- files / audio / video are downloaded to `<state root>/channels/<kind>/files/<chat>/` and listed in the prompt so the agent reads them with its tools,
- a **reply summon** fetches the replied-to message (its content is not in the event), injects its text into the prompt, and loads its attachments too — "@bot summarize this" as a reply to a file works.

## State & restarts

The channel persists its state under `<state root>/channels/<kind>/` (`channels/feishu/` or `channels/lark/` — two mounted kinds never share stores):

- `turns.json` — accepted turn intent, persisted pre-ACK and removed when the turn ends; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start (L1, at-least-once, with a poison-turn ceiling — the same lifecycle semantics as Telegram, see [design/core.md](design/core.md)),
- `seen.json` — the most recent 2,000 `message_id`s whose turn intent or buffered context was persisted; Feishu/Lark document duplicate pushes even after a successful ACK and recommend this idempotency key,
- `thread-participants.json` — a bounded record of what the Agent HEARD in each thread, written for every group thread the channel can see, in every posture — including ones where the summon rule cannot read it, because the posture is configuration and a record outlives a change to it: the humans it saw speak (capped at two, since the rule only asks whether a second one exists) and whether it has answered there. Nothing is read back from the platform, so losing the file costs one mention per thread to re-enter it,
- `buffers.json` — unsummoned human group/thread discussion, persisted before the transport ACK and consumed only after an Agent turn completes,
- `files/<chat>/` — downloaded inbound files.

An upgrade from the earlier session-mode model cleans itself up on the next start: the obsolete
`owned-threads.json` is removed, and `buffers.json` buckets keyed `<chat>:root:<id>` are dropped at
load, since the re-keying means nothing can ever fold or clear them again. That old shape covered every
thread bucket, so **buffered discussion in threads does not survive the upgrade** — a chat's own bucket
does. The dropped count is logged.

The seen ring is bounded, best-effort delivery dedup rather than exactly-once execution. It is written
after the turn/buffer state so a failed pre-ACK state write can still be redelivered safely; a crash
between those writes, a failed ring write, or a duplicate older than the cap can therefore still re-run
or re-fold. Interrupted-turn recovery also remains L1 at-least-once and can repeat tool side effects.

The state home self-ignores (a nested `.gitignore`). Single-process semantics: two processes must not share a state dir.

## Sending messages back (`feishu-send` / `lark-send`)

`fastagent add feishu` also scaffolds `tools/feishu-send.ts` (lark: `tools/lark-send.ts`): the agent can send plain text or a Markdown card to any chat by id. It is the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up; those turns have no `[feishu: chat …]` envelope line, so the schedule's prompt must name the target chat id.

**Do not use it to answer the current turn** — the channel already delivers the reply, so calling the tool as well posts it twice. The scaffolded description says so; a workspace scaffolded before that was added keeps its own copy, so paste the boundary into the tool's `description` (or re-run `fastagent add` in a scratch dir and copy the file) if the Agent is double-posting.

## Upgrading from the session-mode releases

Three behaviour changes, none of them opt-in:

- **Direct messages become one continuous conversation** instead of one session per top-level message,
  and a group summon is answered **in place** instead of opening a thread.
- **Sessions are re-keyed** to the place (`<kind>:<chat_id>`, or `<kind>:<chat_id>:<thread_id>` in a
  thread). Existing history is NOT migrated — every conversation starts fresh, which reads to users as
  the Agent forgetting. The old session records stay in the store unreferenced; deleting them is
  optional and safe.
- **The concurrency unit changes with it.** Turns serialize per session, so a whole room is now one
  queue: a second person's `@Agent` in a busy room waits behind an unrelated multi-minute turn (they
  see the "⏳ Queued" card). Open a thread to run something alongside it.

- **Unrelated to the model, but in the same release:** the scaffolded send tool's description gained a
  "do not use this to answer the current turn" boundary (without it the Agent posts its reply twice).
  Scaffolded files are copies, so an existing workspace keeps the old text — see the send-tool section
  above for the one-line fix.

State cleans itself up on the first start: `owned-threads.json` is removed, and `buffers.json` buckets
under the retired key shape are dropped — which means **buffered discussion in threads does not survive
the upgrade** (a chat's own bucket does). The dropped count is logged.

Derivation in [design/participant-model.md](design/participant-model.md) §3 and §12.

## Limits

- One app uses one subscription mode. FastAgent cannot fail over from WebSocket to webhook at runtime;
  changing mode requires coordinated channel-source + console changes and a published app version.
- WebSocket requires one continuously running process. Fly disables scale-to-zero and Railway forbids
  App Sleeping. Multiple clients for one app are cluster/load-balanced, not broadcast.
- The official SDK currently carries event subscriptions over long connection; callback subscriptions
  are not part of this FastAgent ingress. Card streaming remains outbound HTTP and is unaffected.
- Subscription mode and `im:message.group_msg` cannot travel as arbitrary sensitive creation-link
  config. Feishu onboarding therefore adds the chosen scope to the post-creation app draft through the
  application-config API; Lark falls back to a manual console step when that API is unavailable.
  Tenant-admin approval and version publishing remain console actions.
- Bound CLI app creation is feishu-only: the intl cloud's confirm-page ack endpoint is broken (every
  ack renders as "Link expired"). `add lark` therefore uses the unbound launcher + guided credential
  paste, then actively probes the config API: automatic mode/token bootstrap on success; manual
  Token + Subscription mode/URL only on an explicit route-level 404.
- The group context buffer is gated on the sensitive `im:message.group_msg` scope; without it the platform never delivers unsummoned messages.
- Sessions are one per chat and one per thread, with no TTL or GC, so session storage grows with the number of chats and threads the Agent has taken part in. Thread participation is capped and evicts BYSTANDER threads first (ones the Agent only listened to — losing one costs nothing, since the summon rule refuses such a thread anyway); age decides only among threads it takes part in. The rest is unbounded.
- `feishu-send` / `lark-send` currently target only `chatId`; schedules and wake-ups cannot select a thread until those tools accept a reply target plus `reply_in_thread`.
- The sender in events carries only ids (no display name) — prompts attribute messages as `user <open_id>`. Resolving names needs a contacts scope; a custom `route` can enrich the envelope.
- Events must be ACKed within ~3 seconds in either mode. The channel persists/enqueues synchronously;
  webhook returns HTTP 200 and the SDK returns its ACK frame without waiting for the Agent turn. A
  persistence throw becomes HTTP/WS 500 and asks the platform to re-push.
- Rate-limit rejects are retried (bounded); message sends to one chat are capped by the platform at 5 QPS.
