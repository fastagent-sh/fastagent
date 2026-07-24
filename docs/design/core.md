---
title: Core design
description: "Architecture of FastAgent's pi reference implementation: the assembly ladder, prompt assembly, event translation, sessions, channels, schedules, and state."
type: design-doc
status: current
updated: 2026-07-19
---

# Core design

This document explains the architecture of FastAgent's pi reference implementation. The normative
protocol is [Agent Handler SPEC v0.1](../SPEC.md); code in `src/` is the implementation source of
truth. User behavior belongs in the other `docs/` guides, not here.

## 1. Product boundary

FastAgent serves file-defined agents. Its stable center is the engine-neutral Agent Handler:

```ts
agent.invoke(scope, prompt) => AsyncIterable<AgentEvent>
```

The contract separates three things that otherwise form an integration matrix:

| Concern | FastAgent seam |
|---|---|
| Trigger: HTTP, channel, schedule | Calls an `Agent` |
| Engine/model implementation | Implements `Agent` |
| Host/runtime | Supplies process, storage, credentials, and deployment |

Pi is the reference implementation. The contract does not require pi, but pi-specific assembly,
sessions, models, and tool types live under `src/engines/pi/` and the public `/pi` subpath.
Engine-neutral consumers use `/core`.

## 2. Workspace shape and prompt assembly

There is ONE workspace shape, with two placements. The shape:

```txt
<workspace root>/
├── persona.md              # optional identity
├── AGENTS.md               # optional project context
├── skills/
├── tools/
├── channels/
├── schedules/
├── fastagent.config.mjs
├── .secrets/               # fastagent-managed secrets: .env + auth.json (self-gitignored;
│                           # .env.example travels)
├── .state/                 # mutable machine state: sessions, channel state, schedule state
└── .cache/                 # reserved: re-derivable content
```

**Flat** places it directly in the directory ("a directory is an agent"): root = workbench.
**Standalone** nests the identical shape into `<dir>/.fastagent/` — the host tree gets ZERO writes;
the parent directory is the WORKBENCH (the agent's cwd, whose `AGENTS.md` ancestors are ② context):

```txt
repo/                       # the workbench — what the agent works ON, untouched
├── AGENTS.md               # host project context, read as ②
└── .fastagent/             # the WHOLE workspace — the flat shape, nested one level down
    ├── persona.md
    ├── skills/  tools/  channels/  schedules/
    ├── fastagent.config.mjs
    ├── .secrets/  .state/
    └── package.json
```

Layout is STRUCTURAL, never configured: `resolveWorkspace(dir)` finds a `fastagent.config.*` at the
dir root (flat) or under `<dir>/.fastagent/` (standalone); both at once is a refused ambiguity. The
machinery dirs map onto deploy lifecycles: `.secrets/` travels through the host's secret store (never
an image), `.state/` through a volume (`FASTAGENT_STATE_DIR`/`FASTAGENT_SECRETS_DIR` point both at it
in a container), `.cache/` is re-derivable.

The pi reference prompt has four segments:

| Segment | Source |
|---|---|
| ① engine base + identity | `piBasePrompt`; `persona.md` replaces its default identity line |
| ② project context | `AGENTS.md` files loaded by pi from the workspace root and the workbench ancestor walk |
| ③ skills listing | definition-local Agent Skills |
| ④ runtime context | cwd only — no date, deliberately: a date line would invalidate the provider prefix cache at every day boundary (mirrors pi ≥0.80.7) |

`persona.md` and `AGENTS.md` are deliberately different slots: persona is authored identity;
`AGENTS.md` is project context. The definition is re-read for every invocation, so persona/context/
skill edits take effect on the next turn. Code modules are reloaded by the dev supervisor instead.

The low-level `createPiAgent({ instructions })` path is different on purpose: `instructions` is the
system prompt verbatim, without the directory prompt assembly.

## 3. Assembly ladder

The pi reference implementation has three reusable rungs:

| Rung | Function | Responsibility |
|---|---|---|
| L0 | `createPiAgentFromHarness` | Adapt a pi harness factory to the Agent Handler stream |
| L1 | `createPiAgent` | Assemble from typed model/instructions/tools/ports |
| L2 | `createPiAgentFromDefinition` | Load a definition directory and build the prompt |

`createPiAgentFromWorkspace` sits above L2. It resolves the layout (`resolveWorkspace`), config,
model, auth, tools, sessions, and machinery paths. `dev`, `start`, `invoke`, and `fire` share this
assembly rather than carrying parallel implementations.

Each invocation builds a fresh harness for its session and discards it after the turn. Conversation
continuity comes from `PiSessionStore`, not a resident harness. Reopening is faithful to the whole
record, not just the messages: pi's harness writes active-tool changes to the session but never reads
them back (its own TUI harness is resident), so `piHarnessFactory` resolves the active-tool set itself
(`harness.ts` `resolveHarnessActiveToolNames`): the UNION of the initial set (every non-deferred tool;
pi's all-active default when nothing is deferred) and the session's accumulated activation DELTAS —
dedicated `fastagent:tool-activation` custom entries the activation bridge writes, each carrying
exactly the names that call activated. pi's own `active_tools_change` entries are full active-set
snapshots and are deliberately ignored: replaying a snapshot would freeze later-added tools out of old
sessions and keep a later-`deferred` tool active in sessions that never discovered it. The corollary
is a constraint on future writers: NARROWING the active set is not representable in this record — a
capability that needs durable narrowing must change the resolve semantics here first, deliberately.

This per-invoke assembly remains the only data plane. A client that needs mid-run control, live
observation, or reconnectable history uses the optional [session control plane](session-control.md):
session-scoped observe/modulate methods beside `invoke` — never a second way to start work, and
never resident process state as the source of continuity.

## 4. Event translation and terminal discipline

Pi exposes a promise for the final assistant message and a subscription side channel for streaming
events. `src/engines/pi/invoke.ts` combines them into one async iterable:

1. acquire the per-session lease;
2. open/create the session and harness;
3. subscribe to pi events and translate text/thinking/tool events;
4. run the prompt;
5. emit exactly one `completed` or `failed` terminal;
6. unsubscribe, abort, and release the lease.

Setup, model, and tool-loop failures become `failed` events rather than thrown iteration errors.
Consumer cancellation runs generator cleanup and aborts the harness. Cleanup anomalies are logged but
cannot turn an already-terminal stream into a throw.

## 5. Tools, skills, and execution environment

Definition-local skills are the deployment truth. Runtime loading never scans global skill directories;
`fastagent add skill` may copy a global or remote skill into `skills/`, after which the vendored copy is
the source.

Workspace tools are merged in this order:

1. pi coding tools (`read`, `bash`, `edit`, `write`);
2. `config.tools`;
3. discovered `tools/*.ts|js|mjs`.

Earlier names win and collisions are reported. Broken discovered tools are reported and skipped.
Reusable integrations export ordinary `FastagentTool[]` for explicit `config.tools` mounting; package
origin does not create a second tool runtime.

Every `defineTool` execution receives the same generic runtime context. Serving adapts its fresh
pi-agent-core `Session`; chat adapts pi coding agent's resident `SessionManager`; both expose the
FastAgent-owned read-only port (`getSessionId`, `getHeader`, `getBranch`). Sessionless direct execution
provides cwd but no manager.

**Deferred tools** (`defineTool({ deferred: true })`) are registered but not initially active: their
schemas stay out of the request — and the model's sight — until the built-in `search_tools` loader
(auto-mounted whenever a deferred tool exists; an authored `search_tools` wins, the wake-pair rule)
activates them by keyword mid-turn. The activation runs through a per-turn bridge on the turn context
(`ToolActivation`: additive `setActiveTools`, unknown names filtered — pi throws on them), is stamped
on that tool call's own result as `addedToolNames` — the load point that lets providers with native
deferred loading add the definitions at the transcript position without invalidating the cached
prompt prefix (the stamp comes from that execute's own `activate()` calls, never an active-set
snapshot diff: batch tool calls run in parallel and a diff would misattribute a sibling's activation)
— and is recorded in the session, which the per-invoke resolve above carries into later turns. The
base prompt lists only non-deferred tools plus a discovery note, computed from the static mounted set,
so activation never rewrites the prompt. The shared session builder (`session-builder.ts`, which
`chat` consumes) emulates the same behavior over pi's AgentSession — the session is narrowed to the
initial active set at build, and the same builtin loader activates through a session-side
ToolActivation bridge (`sessionToolActivation`) riding the same turn context, so the author debugs
exactly what serves.

`ExecutionEnv` is a harness assembly seam, not a complete sandbox boundary today. Pi's cwd-bound coding
tools and `loadProjectContextFiles` still use the local process/filesystem. A future sandbox adapter must
wire those surfaces as well as provide an `ExecutionEnv`; injecting `env` alone does not isolate a
directory agent.

## 6. Sessions and concurrency

The reference stores are:

- `inMemorySessionStore()` for embedding/tests;
- `jsonlSessionStore({ dir })` for restart-surviving local/single-machine continuity.

Opening an existing session reconciles a dangling leaf tool call left by an interrupted process by
appending an explicit interrupted error result. This restores transcript validity; it does not make
side-effecting tools exactly-once.

The core lease allows one in-flight turn per session. A collision yields:

```ts
{ type: "failed", code: "session_busy", retryable: true, details: "…" }
```

Queueing is channel policy. Telegram, Slack, and Feishu/Lark serialize their own turns per session;
HTTP and GitHub use the core fail-fast behavior.

## 7. Channels and hosting

A channel file has one of two explicit module forms:

```ts
// Existing HTTP route channel
(ctx: { agent, stateRoot }) => Routes

// Long-connection channel
{
  name: string,
  connect(ctx, signal): { ready: Promise<void>, closed: Promise<void> }
}
```

The distinction is structural: a function is a route channel; an object with `connect` is a
`LongConnectionChannelModule`. There is no shared mount object, ingress enum, or second metadata
declaration. Deployment imports enabled channel modules to inspect that shape without invoking route
modules or opening connections, so top-level module construction must not require runtime secrets. The
adapter owns reconnects; `AbortSignal` is the sole shutdown command, while `ready` and `closed` expose
lifecycle observation without a second `close()` path.

Enabled workspace channels are files ending in `.ts`, `.js`, or `.mjs` under `channels/`. Renaming a
file to `telegram.ts.disabled` disables it without adding a second config source.

The loader collects all per-file diagnostics, but `dev` / `start` treats any broken enabled channel or
route collision as fatal. A declared inbound endpoint must not silently disappear, and a broken channel
must never cause the default `/invoke` route to appear. The default HTTP/SSE route is mounted only when there are no
enabled channel files.

The serving CLI composition adds `GET /health`. A long-connection channel counts as declared (so the
fallback `/invoke` does not appear) and keeps that health route for deployment probes. Built-in health
returns 503 until every long connection first becomes ready. The Node host serves route channels through
`node:http`; the CLI opens long-connection channels, aborts them on shutdown, and fails visibly when one
closes unexpectedly. SIGINT/SIGTERM does not drain Agent turns: it aborts long connections, stops the
listener, force-closes active HTTP streams, and has a bounded exit fallback so shutdown cannot hang.

### GitHub

The GitHub adapter verifies the HMAC over the capped raw body, maps a verified delivery through the
workspace's `on(event)` policy, acknowledges with 202, and runs turns in the process. It has no durable
post-ACK replay; an interrupted review is lost and logged.

### Telegram

Telegram is the stateful channel reference. Its modules separate:

| Module | Responsibility |
|---|---|
| `parse.ts` | pure update/message parsing and summon policy |
| `invoke-turn.ts` | attachment resolution and one Agent invocation (busy-retry loop + manifest wording shared via `../invoke-turn-kit.ts`) |
| `../turn-queue.ts` | per-session FIFO, different sessions concurrent (shared with Feishu) |
| `turn-store.ts` | telegram's record + ordering over the shared generic `../turn-store.ts` (pre-ACK persisted turn intent, crash replay) |
| `context-buffer.ts` | telegram's entry shape + attachment selection over the shared generic `../context-buffer.ts` (durable un-summoned group context, peek→completed→commit) |
| `preview.ts` | live preview and terminal write policy |
| `telegram-api.ts` | Bot API timeouts/retries and HTML-aware splitting |
| `../state.ts` | atomic small JSON state files (shared with Feishu) |

Telegram turn replay is at-least-once. A crash can re-run side-effecting tools, and a narrow pre-ACK
window can run a delivery twice. Exactly-once execution needs a different backend/resume model.

### Slack

Slack is a first-party HTTP Events API sibling under `src/channels/slack/`. It keeps the neutral
`Agent.invoke` boundary and reuses shared `turn-queue`, generic `turn-store`, generic `context-buffer`,
the invoke-turn kit (busy retry + manifest wording), `state`, `seen`, and the
shared turn-view reducer + preview policies (`preview-kit`). Platform-specific modules own signature verification/event acceptance, message subtype policy,
managed roots/context, private-file resolution, Slack Web API transport, and dual native-stream /
rate-limited edited-message rendering.

The request boundary verifies Slack's `v0` HMAC over the capped raw body and a five-minute timestamp,
then persists a turn/context/root before returning 200. Logical dedup uses `(team, channel, ts)` because
`app_mention` and `message.*` subscriptions may overlap; `event_id` alone does not identify that shared
message. `context` group mode subscribes to channel/private-channel/MPIM message streams, admits bare
human replies only in durably owned roots, and folds other discussion with the same peek→completed→commit
invariant as Telegram/Feishu. Direct and group sessions default to independent platform threads, with
separate `continuous` compatibility options. As in Feishu/Lark, only a top-level group summon creates an
owned root; an explicit summon inside an existing human thread does not adopt it. `mentions` keeps the
least-privilege explicit-summon surface.

File events persist IDs only. Dequeue-time `files.info` resolves current metadata; authenticated downloads
are host-restricted, timeout/cap guarded, and translated to vision images or absolute local paths. Primary
files fail visibly; buffered files degrade individually. Outbound file delivery uses Slack's external
upload three-step protocol and remains at-least-once across an ambiguous completion response.

Newly onboarded apps use Slack's `agent_view`, `assistant:write`, token rotation, suggested prompts, Agent
status/title, and `chat.startStream` → `chat.appendStream` → `chat.stopStream`. Standard Markdown text events append to
the stream; engine-neutral tool lifecycle events become dense `task_update` chunks. Raw model thinking and
generic tool arguments stay private. The compatibility renderer retains one edited message with a strict
three-second mutation interval; explicit continuous/custom top-level routes select it because native
streams require a parent user message. HTTP Events API remains the production transport; Socket Mode is a
separate future boundary rather than entering `ChannelModule` indirectly.

`add slack` owns a single-workspace internal-app control plane outside `ChannelModule`: a temporary
unguessable challenge/OAuth responder, mode-specific App Manifest creation, OAuth-v2 code exchange, and
irreversible-boundary recovery state. Runtime rotating bot credentials + Signing Secret go to `.env` and rotate into owner-only durable channel
state; the more powerful user/workspace App Configuration refresh token remains owner-local and never
enters deployment secrets. `dev --tunnel` and `deploy --run` rotate it locally and update the Request URL through
`apps.manifest.update`; missing onboarding state remains a truthful manual registration outcome. This is
not Marketplace/multi-workspace installation storage.

### Feishu (canonical) / Lark (compatibility)

Feishu is the second stateful chat-channel reference, shaped as a sibling of Telegram. Its canonical
implementation lives in `src/channels/feishu/`: `feishu.ts` wiring, `parse.ts` pure policy helpers,
`model.ts` / `normalize.ts` content decoding + message-scoped resource normalization,
`invoke-turn.ts` IO assembly, `preview.ts` delivery,
`owned-threads.ts` durable managed-root routing, shared `../seen.ts` bounded delivery dedup,
`feishu-api.ts` transport/token pipeline, `crypto.ts` security math, `card.ts` builders, and registration
automation. Shared mechanisms (`turn-queue` / generic `turn-store` / generic `context-buffer` /
`invoke-turn-kit` / `state` / `wait-health`) remain one level up.

**Feishu is the design center; Lark is a compatibility profile.** The clouds share event/card/crypto
wire formats, but Lark international trails Feishu in app creation and application-config APIs.
`src/channels/lark/lark.ts` is therefore a thin branded adapter over the Feishu engine, while
`src/channels/lark/onboard.ts` owns Lark's degraded guided/manual onboarding. The explicit profiles in
`src/channels/feishu/cloud.ts` record those capability differences. A kind still owns its channel
identity, env, state, logs, and onboarding: `feishuChannel` returns `POST /feishu`, while
`feishuWebSocketChannel` returns a long-connection module; the Lark factories mirror those boundaries
without becoming the core. Both share `channels/<kind>/` state and the same event engine. One workspace
can run both clouds. Outbound APIs and webhook protocol handling remain fetch-based; WebSocket ingress is
isolated behind the official `@larksuiteoapi/node-sdk` because its protobuf connection protocol is not
a stable hand-authored surface. What is platform-different:

- **The live preview is a streaming CARD, not an edited text message.** The platform caps text edits at
  20 per message and sends at 5 QPS per chat; cardkit streaming (50 QPS per app / 10 per card, strictly
  increasing `sequence`) is its designed AI-output channel. A queued turn mounts that same card early
  with a reply-quoted `⏳ Queued` state; execution takes the entity over in place and the same card
  settles into the final Markdown answer, so there is no recall tombstone or ambiguous second reply.
  Per-session execution remains FIFO; quotes keep independently mounted queue cards attributable.
  Degrade tiers: card fails → static text placeholder; streaming closed mid-turn → frozen preview, the
  settle still lands.
- **Verification is modal and fail-closed.** Encrypt Key set: ordinary events require a signature over
  the raw body → AES decrypt, and plaintext is refused. Feishu explicitly excludes Request URL
  verification from event signatures, so its encrypted `url_verification` challenge takes the narrow
  decrypt → exact-type → constant-time Token path. Without an Encrypt Key, events use the same
  constant-time verification-token match in plaintext.
- **Turn identity and delivery dedup use `message_id`; recovery order is an explicit `seq`.** Feishu ids
  carry no arrival order, unlike Telegram's numeric `update_id`, while Feishu/Lark document duplicate
  pushes even after a successful ACK and recommend idempotency on `message_id`. A bounded persisted
  `seen.ts` ring therefore filters message deliveries that already produced a durable turn intent or
  buffered-context entry. It is post-persist, best-effort insurance rather than exactly-once execution:
  a crash between the state and ring writes, a failed ring write, or an id beyond the cap retains L1's
  at-least-once tail. The generic turn store still owns unfinished-run recovery and its poison ceiling.
- **Session partitioning is policy, not transport inference.** P2p and groups default to threaded root
  sessions: every top-level DM or summoned group message owns a new `<kind>:message_id` session, creates
  its platform thread with `reply_in_thread`, and maps continuations back through `<kind>:root_id`. The
  kind prefix isolates Feishu/Lark while keeping pi's provider-facing cache key below its 64-character
  ceiling. One root remains FIFO while different roots run concurrently. `directMessageSession:
  "continuous"` and `groupMessageSession: "continuous"` are explicit compatibility opt-outs; the latter
  restores legacy `chat_id` / `chat_id:thread_id` group sessions. Thread continuations do not rehydrate
  `parent_id`; their session history is authoritative. A top-level quoted reply still loads its parent
  but owns a new root session. Group roots are indexed pre-ACK in `owned-threads.json`: with
  `im:message.group_msg`, bare user messages in those roots become normal required turns with the same
  queue, streaming-card, error, and delivery behavior as an explicit @mention. An explicit mention of
  only other people is targeted discussion instead and enters the context buffer.
- **Group visibility is scope-gated and chosen during onboarding.** `Context-aware groups`
  (recommended and initially selected) requests the sensitive `im:message.group_msg` scope;
  `Mention-only` is the least-privilege alternative. The CLI states that the former delivers all group
  messages, adds it to the app draft through application-v7 config when supported, opens tenant-admin
  approval, and reports the granted capability again at serving startup. Explicit @bot turns always invoke; bare
  human messages invoke only in `chat_id + root_id` roots from the durable ownership index. Other human
  discussion is persisted in `buffers.json`, bucketed by main chat or thread root, and folded into that
  place's next answered turn. The Telegram consume invariant carries over: peek at dequeue, commit only
  on `completed`, and retain failures plus messages arriving in-flight. Non-`user` senders are dropped.
  Summon matches the `mentions` array by the bot's open_id (fail-closed until resolved). A reply summon
  carries only `parent_id` — the referent's content and attachments are fetched as primary input;
  buffered attachments are background input and degrade per resource.
- **Ingress is an onboarding-time app choice.** `add feishu|lark` asks for WebSocket or webhook and
  writes the corresponding transport-specific factory into the channel module. WebSocket needs only App ID/Secret, skips token capture,
  tunnel, Request URL registration, and platform crypto; the official SDK authenticates the outbound
  connection, reconnects it, and converts handler throws into 500 ACK frames (preserving platform
  re-push after a failed pre-ACK state write). Webhook retains the application-v7 PATCH/challenge flow,
  Verification Token, optional Encrypt Key, and Lark's explicit config-route-404 manual fallback.
  Subscription mode is app-level and mutually exclusive: changing the source factory alone does not
  migrate the app; the console mode and published version must move with it.
- **A WebSocket adapter is a long-connection channel and therefore always-on.** Fly generates
  `min_machines_running=1`, Railway forbids App Sleeping, webhook registration is skipped, and only App ID/Secret travel as
  channel secrets. Multiple connections for one app are cluster/load-balanced rather than broadcast.
  Event callbacks must still finish within three seconds, so the shared acceptance boundary persists
  and enqueues only; the Agent turn remains fire-and-forget.

## 8. Schedules and self-scheduling

Static schedules are `schedules/<name>.ts` files exporting `{ cron, tz?, prompt }`. The scheduler:

- derives the stable session `schedule:<name>`;
- claims a slot before invoking;
- catches up one overdue occurrence after downtime, not every missed slot;
- records each run in `<stateRoot>/schedule/runs.jsonl`;
- leaves delivery to agent tools.

With `selfSchedule: true`, the serving path mounts `wake`/`unwake`. Wake-ups are persisted, bounded by
minimum delay/frequency and per-session count, and fired back into the originating session. A one-shot
wake that hits `session_busy` is deferred because the turn never started; other failures are not replayed
because tools may already have produced side effects.

Schedules need one continuously running process. Deploy preflight prevents scale-to-zero settings that
would silently miss clock events.

## 9. State and deployment

`FASTAGENT_STATE_DIR` selects the one machine-state root:

```txt
<stateRoot>/                # <workspace root>/.state (FASTAGENT_STATE_DIR overrides)
├── sessions/
├── channels/telegram/
├── channels/slack/
├── channels/feishu/
└── schedule/
```

Credentials live separately, under `<workspace root>/.secrets/` (`FASTAGENT_SECRETS_DIR` overrides):
a different deploy lifecycle — secrets ride the host's secret store / the auth seed, state rides the
volume; a deployed box points both env knobs at its volume so a rotated OAuth credential persists.

The shipped file-backed implementations are single-process. Multiple instances require shared session,
lease, credential, and channel-state backends; sharing one local state directory between processes is
unsupported.

`fastagent deploy docker|fly|railway` generates a Dockerfile, target config, persistent-volume wiring,
required secret names, and a runbook. Docker adds a user-owned `fastagent.compose.yml` with one app
service; `--tunnel` can add a separate ephemeral cloudflared service, while durable ingress remains
operator-owned. `--run` alone causes Docker/host side effects; for a tunnel topology it also reads the
Quick Tunnel URL and registers webhooks. Both layouts deploy through ONE semantic — bake the workbench
as the image (WYSIWYG: what you see is what ships, git or not, clean or not). Standalone namespaces
every artifact under `.fastagent/` (Dockerfile, fly.toml, compose, railway.json); the single host-tree
write is the root `.dockerignore` the host CLIs' context packers require (kept + warned if the host
owns one — without its machinery excludes the packer would bake `.secrets/` into the image). `.git`
ships by default: freshness (pull) and write-back (commit/push) are the AGENT's runtime behavior, not
deploy machinery — the git binary is baked in exactly when the workbench ships a `.git`; a non-git
workbench adds it via `config.deploy.apt`.

## 10. Current boundaries

The following are explicit limits, not implied capabilities:

- pi is the reference implementation; additional engine bindings can implement the same Agent contract;
- `ExecutionEnv` alone is not a complete sandbox for directory agents;
- GitHub post-ACK work has no replay; Telegram, Slack, and Feishu/Lark replay is at-least-once;
- file-backed state is single-process;
- observability is logs/traces, without an OpenTelemetry exporter.

Keep new implementations behind the existing contract rather than adding speculative concepts to it.
