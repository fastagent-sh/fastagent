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
A tenant lives on exactly one cloud — pick the matching kind. One agent can mount **both** (two
apps, two credential sets); they never share state.

Both ingress modes feed the same request/reply engine: the channel holds the app credentials, streams a **live card** while the turn runs, and settles the same card into the final answer. Replies render as **Markdown** (an interactive card), so code blocks, tables, and links render properly.

## Add the channel

From an agent directory, credentials land in `.secrets/.env` — excluded by the `.secrets/.gitignore` that `init` scaffolds; both
commands refuse to write platform credentials into a committable file:

```bash
fastagent add feishu   # interactive ingress choice + scan-to-create
fastagent add lark     # interactive ingress choice + guided console setup

# Non-interactive / explicit:
fastagent add feishu --ingress websocket
fastagent add lark --ingress webhook
```

The Agent takes part in its group chats like a colleague: bare human replies in a thread it is part of invoke
it, and each answered turn reads what was said in its place since the Agent last answered there. That takes the app
scopes below, and there is no mention-only variant. The created app asks for all of them (Feishu); onboarding
then checks what the app actually holds and names any scope your tenant withheld.

| Scope | Without it |
|---|---|
| `im:message.group_msg` (sensitive) | only @mentions arrive: no bare replies in the Agent's threads, no group discussion as context |
| `im:message:readonly` (or `im:message`) | the discussion before an ask cannot be read (the prompt says so), and a quoted message degrades to a marker |
| `im:chat.members:read` | people in the discussion the Agent reads are shown by open_id, not by name |

What a scope is for is the Agent's, not only the channel's: the Agent can call the Open API with the app's
credentials.

WebSocket is the default ingress. Choose webhook (`--ingress webhook`) when you plan to deploy to AgentCore,
which has no resident process, or to let a Fly/Railway machine scale to zero. An agent with a schedule keeps its
machine up anyway (see [deploy](deploy.md)), so WebSocket costs it nothing more. Choose at `add` time: `deploy`
does not switch it (`deploy agentcore --run` refuses a WebSocket channel), and switching later is a migration
in which a WebSocket app also lacks the app-config permission that automates the webhook steps. The choice is persisted in
`channels/<kind>.ts` by its factory (`feishuChannel`/`larkChannel` for webhook, or the corresponding
`*WebSocketChannel` factory):

| | WebSocket (default) | Webhook |
|---|---|---|
| Public URL / `--tunnel` | Not needed | Required |
| Runtime credentials | App ID + Secret | App ID + Secret + Verification Token; Encrypt Key optional |
| Deploy targets | local, Docker, Fly, Railway — one always-on process | all, AgentCore included |
| Scale-to-zero / App Sleeping | Not supported; keep one process running | Supported when no other always-on producer exists |
| App-config permission (`application:application:patch`) | Not requested | Requested: it registers the Request URL on every `dev --tunnel` and `deploy --run`; a tenant that reviews it holds the new app in review |
| Platform configuration | Long connection + publish | Webhook mode + Request URL + publish |

This is an **app-level onboarding choice**, not a runtime failover switch. The platform delivers through
one subscription mode at a time. To migrate later, change the channel factory and the console mode
together, then publish a version; changing only one side makes the bot deaf.

**Use one app per environment** (your laptop's `dev`, each deployment). Two processes on one app take each
other's messages, in either mode: two WebSocket clients split the events between them rather than each
receiving all of them, and a webhook `dev --tunnel` re-registers the Request URL to itself, so the deployment
stops receiving any. `dev` and `deploy` read the same `.secrets/.env` unless `FASTAGENT_SECRETS_DIR` points one
of them at another directory; put the second app's App ID and Secret there. Both apps use the ingress
`channels/<kind>.ts` names, so a WebSocket app on your laptop and a webhook app in the cloud cannot yet share
one agent directory.

Onboarding differs by cloud: Feishu supports CLI app creation (scan-to-create); Lark uses the unbound launcher plus
guided credential input, because its bound confirmation flow does not work.
Within either cloud, ingress determines the remaining work. WebSocket's runtime credential set stops at
the validated/persisted App ID/Secret pair; onboarding continues through the permission check and
opens Events & Callbacks so the user can select long connection and publish.
Webhook continues through the existing temporary-tunnel challenge to capture the Verification Token and
configure the Request URL. Onboarding then reads the App's scopes and, for any that is missing, opens the
console page that requests it, pre-filled. Lark's missing config API falls back to explicit manual
Token/mode/URL steps. Re-running a partial setup reuses the complete App ID/Secret pair rather
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
pre-configured—and adds `im.message.receive_v1` and the scopes in the table above. A webhook app also gets
`application:application:patch`, which the webhook bootstrap registers the Request URL through; when the app is
not granted it (a tenant that reviews it, or an app born WebSocket), onboarding names it and leaves the
Verification Token and Request URL to the console instead of trying. A WebSocket app
does not: a tenant that reviews that scope holds the app's whole first version in review, for a scope WebSocket
never uses. A tenant may withhold any requested scope; onboarding names what it withheld. The CLI immediately persists App ID/Secret to
`.secrets/.env` before starting later network work.

For WebSocket, those two values are the complete runtime credential set. For webhook, the platform-
generated Verification Token has no read API; its only programmatic delivery is the `url_verification`
challenge, so the CLI captures it through a throwaway tunnel and persists it as a second stage. If that
stage is interrupted, re-running resumes Token capture for the same App rather than minting another.

What is left for the console depends on the tenant. A tenant that grants the requested scopes at creation
gets an app that holds them at once; one that withholds some needs them requested (the CLI opens that page)
and approved, then a version created and published. WebSocket keeps the template's long-connection mode;
webhook flips it and registers a Request URL. Mode and scope changes take effect only after publish, while
later webhook URL changes apply immediately. Version publishing and tenant-admin approval have no general
automatic completion path.

## Configure the app by hand (developer console)

Create a **custom app** in the developer console ([open.feishu.cn/app](https://open.feishu.cn/app) or [open.larksuite.com/app](https://open.larksuite.com/app)), then:

1. **Enable the bot capability** (App Features → Bot).
2. **Permissions** — add:
   - `im:message.p2p_msg:readonly` — receive direct messages,
   - `im:message.group_at_msg:readonly` — receive group messages that @mention the bot,
   - the agent scopes in the table under [Add the channel](#add-the-channel),
   - `im:message:send_as_bot` — send replies,
   - `im:resource` — download message images/files,
   - the card scope ("Create and update card") — the live preview streams through a card entity.
3. **Events & Callbacks** — subscribe to `im.message.receive_v1`, then choose one mode:
   - **WebSocket:** choose long connection. No Verification Token, Encrypt Key, or Request URL is needed.
   - **Webhook:** choose webhook, copy the Verification Token, and optionally set an Encrypt Key.
4. Put the matching credentials in the agent's `.secrets/.env`:

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
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
  channel: (secrets) =>
    feishuChannel({
      appId: secrets.FEISHU_APP_ID,
      appSecret: secrets.FEISHU_APP_SECRET,
      verificationToken: secrets.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
      onError: (failed) => `⚠️ ${failed.details}`, // dev transparency; drop for a public bot
    }),
});
```

The WebSocket form uses its transport-specific factory and has no webhook-only options:

```ts
import { feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
  channel: (secrets) =>
    feishuWebSocketChannel({
      appId: secrets.FEISHU_APP_ID,
      appSecret: secrets.FEISHU_APP_SECRET,
    }),
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
and resolves `closed`. See Feishu's
[long-connection guide](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode).

## Webhook event verification

WebSocket authentication happens once while establishing the official-SDK connection. Webhook has two
security modes, decided by the console's Encrypt Key setting and mirrored by `encryptKey`:

- **Encrypt Key set (recommended):** ordinary events arrive AES-256-CBC encrypted with `X-Lark-Signature` headers. The channel verifies the signature over the raw body, decrypts, and **refuses plaintext events entirely** — accepting both would let a forger skip the stronger check. It also refuses an `X-Lark-Request-Timestamp` more than 7 hours from now: a signature commits to its timestamp but does not make it recent. The window covers the platform's whole retry chain (15s / 5min / 1h / 6h), so a redelivery is never rejected as stale.
- **No Encrypt Key:** events arrive in plaintext and are authenticated by the Verification Token (constant-time compare). There is no signature and therefore no replay window — the channel warns about this at startup.

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
- in an **Agent-created group thread**, a bare user continuation answers without another @mention; a message that explicitly mentions only other people is instead left as discussion, while `@bot + @others` still answers,
- in a main group chat or a thread the Agent did not create, human messages without `@bot` are left as discussion, which the next explicit `@bot` turn in that same place reads (see [Place history](#place-history)),
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
authoritative: its `null` does not fall through to the built-in thread rule, and a routed turn reads no place
history (the router decides what a session's place is). The canonical `feishuEnvelope(event)` builds the default prompt envelope (chat/sender metadata, group note, reply
marker, decoded body) for custom Feishu routes. The Lark subpath exposes `larkEnvelope(event)`, which
reuses that builder with the `[lark: …]` compatibility tag.

### Group visibility is scope-gated

With only `im:message.group_at_msg:readonly`, the platform delivers **only messages that @mention the bot** — unmentioned group/thread discussion never reaches the channel. The sensitive `im:message.group_msg` scope (custom apps only; some tenants approve it by hand) delivers all group messages once the app holds it. FastAgent then invokes explicit `@bot` turns, plus bare messages in a thread where it takes part and has not heard a second human — both facts being what the channel itself observed, so a thread it joined before this deployment takes one mention to re-enter. Everything else is discussion, which that place's next answered turn reads from the platform.

Practical consequences in groups:

- without `im:message.group_msg`, a **bare image/file** cannot summon (it has no mention) and is not delivered — put the ask and attachment in one rich-text `post`, or reply to the attachment and @mention the bot,
- with that scope, a bare attachment inside a thread the Agent is part of is primary input and answered immediately; elsewhere it is discussion, and its image/file rides the next `@bot` turn in that place as background input,
- background attachment failures degrade per resource with a visible prompt note; primary attachment failures still fail the turn visibly.

### Place history

A place is a chat (a group or a DM) or a thread in one. When a turn runs, the channel reads the place's messages from
the platform (`GET /im/v1/messages`) and folds what was said since the Agent last answered there into the prompt, as
`[recent discussion here: …]`. The first turn in a place reads its newest 20 messages. The read ends at the turn's
own ask: an ask queued behind it, and anything said after it, are read by their own turn. Within that, the read leaves
out what the session already holds: every message the channel posted as a turn's output (answers, queue notices, stop
feedback), and the messages it took as input (`/stop`). What the Agent posted itself, with `feishu-send` from a
schedule for example, stays, labelled `you`, so a later "what did point 3 mean?" has it.

- People are named from the chat's member list (`im:chat.members:read`), other bots as `bot <app_id>`. Only the speakers
  a fold shows are looked up, and names are reused for 10 minutes. A chat larger than 1,000 members may leave a speaker
  unnamed (shown by open_id, with a warning); a failed name read is retried after the 10 minutes, not on every turn.
- Cards are read as they were sent (`card_msg_content_type=user_card_content`), so a Card 2.0 digest reads as its text.
- In a topic group, the main chat's history is each topic's first post; a reply inside a topic belongs to that topic.
- A thread's first turn also reads its room's discussion, read-only: the room's own next turn still reads it.
- The fold is bounded: 4,000 characters, 280 per message (2,000 for the Agent's own post), the newest kept, and what it
  leaves out is counted in the prompt. A place with more than 50 messages since its last answer says earlier ones
  are not shown.
- A read that fails costs the turn its discussion, never the turn: the prompt says the discussion could not be read,
  a warning is logged, and the next turn reads the same messages again. A rate-limited read is not waited out, since
  the turn waits for it.
- A direct message is a place too: its turns read what was posted there since the last answer, which in practice is
  what the agent sent there itself with a send tool (a schedule's digest). Turns from a custom `route` read no history.

### Reading threads

`fastagent add feishu` (lark: `add lark`) also scaffolds `tools/feishu-threads.ts` (`tools/lark-threads.ts`). In a
group turn, the agent calls it with no arguments to list the group's recent threads, and with a thread id to read one.
That is how a question in the group about a topic ("was the deploy failure resolved?") reaches what a person wrote
in that topic.

- Only the group the turn was asked in: the tool takes no chat id, and a thread id from another chat is refused. In a
  DM, a scheduled turn or a turn from a custom `route` it answers that it cannot read threads.
- The list is the threads among the group's newest 50 messages, newest first, at most 20. Feishu lists an ordinary
  group's thread by its first message only, so the list shows when such a thread started, not its last reply (it may
  have gone on since, and the list says so), and a thread started before those 50 messages does not appear. A topic
  group lists every message, so there a thread shows its last activity.
- A read is the thread's newest 20 messages, bounded like the place history above, the agent's own answers included.
- An agent created before this release gets the tool with `fastagent add feishu --no-onboard`: it keeps the channel
  file and writes the package's tools.

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
can follow up on someone else's question; a thread is a separate place with its own — **started from
what the room knew**: a new thread's session inherits the room's recent history (up to the message the
thread branched from, windowed to the newest ≈50 exchanges), including images and tool results. The
inheritance happens once, when the thread's session is created; after that the two places are
independent, and the room never sees what the thread discusses.

Discussion the room heard but never answered has not entered its session yet, so the fork cannot
carry it — the thread's first turn reads that pending discussion instead, attachments included.
Reading it does not consume it: the room's own next answer still folds the same messages, so each
place sees the discussion once.

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

Card snapshots use the cardkit quota (50 QPS per app, 10 QPS per card, no edit cap), not the 5 QPS per-chat message quota or the 20-edit cap on text messages.

Degrade tiers, all visible in the operator log:

- card creation/mount fails → a static text placeholder; the final answer lands as ONE text edit (or fresh sends),
- the platform closes streaming mid-turn (idle timeout) → the preview freezes; the settle still lands,
- an answer longer than one card (~20 KB) settles the card with the first chunk and sends the rest as follow-up messages,
- an empty answer leaves `(no reply)`; a suppressed error notice deletes the card, leaving no residue.

## Failures

Two audiences, like the Telegram channel:

- **Operator log**: always receives the full diagnostic details.
- **Chat user**: every answered turn receives `onError(failed)` if provided, otherwise a neutral default keyed on `retryable`.

A summon whose whole message is "stop" or "cancel" aborts the session's active turn instead of
becoming a turn (queued asks keep running). No configuration is needed: stopping the running turn is
part of serving, not part of `/control/*`.

## Files and images

Message payloads are resolved by the channel before the agent turn runs — all as **primary** inputs (a load failure becomes a `failed` event, never a silent drop):

- images (`image` messages, or images inside a rich-text `post`) are downloaded and passed as `prompt.images` — the selected model must support vision,
- files / audio / video are downloaded to `<state root>/channels/<kind>/files/c-<chat>/` — `c-` plus the URL-encoded chat id, so a thread id keeps its `:` and `/` as one directory (`oc_x:thread/1` → `c-oc_x%3Athread%2F1`) — and listed in the prompt so the agent reads them with its tools,
- a **reply summon** fetches the replied-to message (its content is not in the event), injects its text into the prompt, and loads its attachments too — "@bot summarize this" as a reply to a file works,
- the **reply chain above** the quoted message is resolved as background context: up to 8 ancestors, oldest first, sharing one referent-sized text budget; their images/files load degradably like background attachments (a failure becomes a note, not an error). A chain cut short for any reason — cap, budget, an unreadable message — is marked visibly in the prompt so a partial chain never reads as the whole conversation.

## State & restarts

The channel persists its state under `<state root>/channels/<kind>/` (`channels/feishu/` or `channels/lark/` — two mounted kinds never share stores):

- `turns.json` — accepted turn intent, persisted pre-ACK and removed once the reply has been delivered; an entry a crash (or a SIGTERM deploy) leaves behind is replayed on the next start, and one that already carries its answer is re-delivered instead of re-run (L1, at-least-once, with a poison-turn ceiling — the same lifecycle semantics as Telegram, see [design/core.md](design/core.md)),
- `seen.json` — the most recent 2,000 `message_id`s the channel took as input (a turn, a `/stop`); Feishu/Lark document duplicate pushes even after a successful ACK and recommend this idempotency key. A place's history read leaves these out,
- `history.json` — per place, the newest message its last answered turn read (the next read starts after it) and the messages turns posted there that no read has passed yet (answers, queue notices, stop feedback; the next read leaves them out). Losing it costs one re-read of a place's newest 20 messages, the Agent's earlier answers among them,
- `bot.json` — the bot's own `open_id`, bound to its `appId` and cached from `bot/v3/info` so a cold start recognizes @mentions immediately,
- `thread-participants.json` — per thread, the humans the Agent heard (at most two) and whether it has answered there. Losing the file costs one mention per thread to re-enter it,
- `files/c-<chat>/` — downloaded inbound resources, one directory per chat. Never pruned by FastAgent; size and prune it yourself.

The seen ring is best-effort dedup, not exactly-once: a crash between writes, a failed ring write, or a duplicate
older than the cap can still re-run a turn. Interrupted-turn recovery is at-least-once and can repeat tool side
effects.

The state home lives under `.state/`, which the agent `.gitignore` excludes. Single-process semantics: two processes must not share a state dir.

## Sending messages back (`feishu-send` / `lark-send`)

`fastagent add feishu` also scaffolds `tools/feishu-send.ts` (lark: `tools/lark-send.ts`): the agent can send plain text or a Markdown card to any chat by id. It is the delivery path for turns no channel is carrying — a cron schedule or a self-scheduled wake-up; those turns have no `[feishu: chat …]` envelope line, so the schedule's prompt must name the target chat id.

**Use it for proactive delivery only.** The channel delivers the current turn's reply; calling the tool
as well posts it twice.

The tools use `feishuTransport(ctx.cwd)` / `larkTransport(ctx.cwd)` from their respective package
subpaths. Within a serving process, they share the mounted channel's credentials, custom gateway,
token cache, bounded retries, and UTF-8 text splitting. Feishu and Lark remain isolated even in one
agent. With no channel mounted (`invoke`, `tool`, or an embedded agent), the transport
reads the matching `FEISHU_*` / `LARK_*` environment credentials and uses that cloud's default gateway.
Standalone sending requires no `fastagent.config.ts`: the transport is keyed to the state root of the tool's `cwd`,
the agent directory.

`tools/feishu-send.ts` / `tools/lark-send.ts` are the package's, not authored glue: re-running
`fastagent add feishu|lark` rewrites the tool, keeps `channels/<kind>.ts` and the credentials already in
`.env`, and re-checks the app's permissions. That is how an agent scaffolded by an earlier release
picks up the current tool.

## Limits

- One app uses one subscription mode. FastAgent cannot fail over from WebSocket to webhook at runtime;
  changing mode requires coordinated channel-source + console changes and a published app version.
- WebSocket requires one continuously running process. Fly disables scale-to-zero and Railway forbids
  App Sleeping. Multiple clients for one app are cluster/load-balanced, not broadcast.
- The official SDK currently carries event subscriptions over long connection; callback subscriptions
  are not part of this FastAgent ingress. Card streaming remains outbound HTTP and is unaffected.
- Subscription mode cannot travel as creation-link config, and a tenant may withhold any requested scope.
  Onboarding names a withheld scope and opens the page that requests it; tenant-admin approval and version
  publishing remain console actions.
- Bound CLI app creation is feishu-only: the intl cloud's confirm-page ack endpoint is broken (every
  ack renders as "Link expired"). `add lark` therefore uses the unbound launcher + guided credential
  paste, then actively probes the config API: automatic mode/token bootstrap on success; manual
  Token + Subscription mode/URL only on an explicit route-level 404.
- Without the sensitive `im:message.group_msg` scope the platform never delivers unsummoned messages, so only @mentions summon.
- A read of a place's history adds about 300–400 ms before a group turn starts.
- Sessions are one per chat and one per thread, with no TTL or GC, so session storage grows with the number of chats and threads the Agent has taken part in. Thread participation is capped and evicts BYSTANDER threads first (ones the Agent only listened to — losing one costs nothing, since the summon rule refuses such a thread anyway); age decides only among threads it takes part in. The rest is unbounded.
- `feishu-send` / `lark-send` currently target only `chatId`; schedules and wake-ups cannot select a thread until those tools accept a reply target plus `reply_in_thread`.
- The sender in events carries only ids (no display name), so the ask's own envelope attributes it as `user <open_id>`; only the discussion read from history is named. A custom `route` can enrich the envelope.
- Events must be ACKed within ~3 seconds in either mode. The channel persists/enqueues synchronously;
  webhook returns HTTP 200 and the SDK returns its ACK frame without waiting for the Agent turn. A
  persistence throw becomes HTTP/WS 500 and asks the platform to re-push.
- Rate-limit rejects are retried (bounded); message sends to one chat are capped by the platform at 5 QPS.
