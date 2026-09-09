---
title: Core design
description: "Architecture of FastAgent's pi reference implementation: the assembly ladder, prompt assembly, event translation, sessions, channels, schedules, and state."
type: design-doc
status: current
updated: 2026-07-19
---

# Core design

Architecture of FastAgent's pi reference implementation. The normative protocol is
[Agent Handler SPEC v0.1](../SPEC.md); code in `src/` is the implementation source of truth. User
behavior belongs in the other `docs/` guides.

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

pi is the reference implementation. The contract does not require pi, but pi-specific assembly,
sessions, models, and tool types live under `src/engines/pi/` and the public `/pi` subpath.
Engine-neutral consumers use `/core`.

## 2. Workspace shape and prompt assembly

One agent shape, one marker:

```txt
<agent dir>/                # any name — the config below is what makes it an agent
├── persona.md              # optional identity
├── AGENTS.md               # optional project context
├── skills/  tools/  channels/  schedules/
├── fastagent.config.mjs    # THE marker
├── models.json             # optional custom model endpoints (pi's schema, definition-local so it
│                           # travels into the image; pi's machine-global ~/.pi one stays unread)
├── .gitignore              # scaffolded once by init, yours after
├── .secrets/               # .env + auth.json; only the tracked .env.example + .gitignore travel
└── .state/                 # mutable machine state: sessions, channel state, schedule state
```

The other noun is the **workspace** — what the agent works on: its cwd, its coding tools' root,
deploy's build context, and whose `AGENTS.md` ancestors are ② context.

**The workspace is the directory you point fastagent at.** The same tree therefore answers two ways:

```txt
repo/                       # `fastagent dev` here  → agent = repo/agent, workspace = repo
├── AGENTS.md
├── src/
└── agent/                  # `fastagent dev` here  → agent = repo/agent, workspace = repo/agent
    ├── persona.md  skills/  tools/  channels/  schedules/
    ├── fastagent.config.mjs
    └── .secrets/  .state/
```

Point at the project and its agent serves with the project as its workspace (what `init` sets up).
Point at the agent directory — all a deployed box may have been shipped — and it works on itself; a
rule insisting the workspace is always the parent would hand that container `/`. `init --flat` (a
standalone agent repo, a monorepo package) is the same rule with the two directories equal.

| `dir` | Result |
|---|---|
| holds a `fastagent.config.*` | `{ agentDir: dir, workspace: dir }` |
| exactly one directory inside it holds one | `{ agentDir: <that dir>, workspace: dir }` |
| several do | `FASTAGENT_AGENT` names one, else the one named `fastagent` — else throws, naming them |
| none | throws: not a fastagent agent, with the exit that fits the position |

- **The marker is the config, at every position, and it is a declaration rather than configuration.**
  Nothing in an agent directory is logically required to serve a turn, so the marker has to be the one
  artifact present in every agent and absent from every non-agent. `persona.md`, `skills/`, `tools/`,
  `channels/` and `schedules/` are each optional and generic enough that scanning for them would read
  half the world's repositories as agents. `export default {}` is a signature — the same job
  `package.json`, `Cargo.toml` and `pyproject.toml` do. A directory holding nothing but a config is a
  complete agent, and `--agent-dir` calls it anything.
- **The scan is one level.** Deeper is that directory's own workspace: for `repo/packages/reviewer/`
  you point at the package.
- Resolution never walks up, but the refusal reads the path so each dead end gets its own exit: inside
  an agent → `cd` to it; on a directory holding several → point at one.
- **The cost of aiming being load-bearing** is that `cd agent && fastagent dev` narrows the workspace.
  Three things carry it: `dev`/`start`/`info` print `agent:` and `workspace:` on every run; the
  explicit form (`fastagent dev ..`) is always exact; and a parent carrying an `AGENTS.md` or `.git`
  adds a `hint:` line. A hint may use that heuristic precisely because a rule may not.
- **Known boundary:** the workspace is `agentDir` itself or its immediate parent, never further.

`init` either creates or refuses with the reason. Its one placement duty follows from the lookup:
**the target must be an agent the lookup would return**, so it refuses when `dir` already resolves over
something else. A subdirectory target must be empty; `--agent-dir .` adopts a directory, so existing
files are kept — reported, never overwritten.

The two machinery dirs map onto deploy lifecycles: `.secrets/` values travel through the host's secret
store, `.state/` through a volume (`FASTAGENT_SECRETS_DIR`/`FASTAGENT_STATE_DIR` point both at it in a
container).

**Git is the author's, not fastagent's, with one exception.** `init` scaffolds two ignore files: the
agent's own and `.secrets/.gitignore` (`*` minus the template). No command reads, verifies or rewrites
an ignore file. The exception: **the directory fastagent writes secrets into carries its own
`.gitignore`**, so `add <channel>`, which mints an unrecoverable app secret, writes that file (`wx`,
never over an existing one) when the *default* `<agentDir>/.secrets` has none. The risk is not
symmetric — restoring a deliberately deleted ignore file is an annoyance, the other way is a published
credential. A secrets dir named by `FASTAGENT_SECRETS_DIR` belongs to the operator: dropping the
template there would hide that directory's other contents from `git add`, so `add <channel>` states
the fact instead.

**Several agents on one workspace** is a supported shape: an engineer's, a PM's and a content owner's
agent can each drive the same repository. `FASTAGENT_AGENT` selects between them; the directory named
`fastagent` breaks the tie.

- **The env selects, a file does not.** Selection is per-person, and a committed workspace file is
  shared by construction. `.envrc` is the per-repo, per-person file this needs and is not ours to
  invent. A workspace registry could only drift from the one-level scan that already answers "which
  agents are here".
- **It asserts, at any count.** A directory holding no agent by that name resolves to nothing even when
  exactly one agent sits there: serving a different agent than the one asked for is the silent
  wrong-target this codebase refuses everywhere. Stated cost: a value exported in a shell profile
  refuses in every unrelated directory it travels into — scope it per-repo, which the refusal says.
- **`deploy` bakes it.** The container re-resolves placement at `/app`, so the generated Dockerfile
  pins `ENV FASTAGENT_AGENT=<name>`. Otherwise the artifact would depend on the builder's environment.

The pi reference prompt has four segments:

| Segment | Source |
|---|---|
| ① engine base + identity | `piBasePrompt`; `persona.md` replaces its default identity line |
| ② project context | `AGENTS.md` files loaded by pi from the agent dir and the workspace ancestor walk |
| ③ skills listing | pi appends definition-local skills when `read` is active |
| ④ runtime context | pi appends cwd, without a date line that would invalidate the prefix cache daily |

`persona.md` is authored identity; `AGENTS.md` is project context. The definition is re-read for every
invocation, so persona/context/skill edits take effect on the next turn; code modules are reloaded by
the dev supervisor instead. The low-level `createPiAgent({ instructions })` path takes the prompt body
without directory identity or project-context assembly; pi appends skills and cwd on both paths.

### Promise ports

Every contract at the edge of this codebase is Promise-shaped and none of them are ours to change: the
SPEC fixes `Agent.invoke` as an AsyncIterable and `SessionControl` as Promises, pi's SDK is
Promise-based, every platform client is `fetch`, and so is the filesystem. `src/effect-port.ts` is the
single crossing into Effect execution, and it holds exactly two opinions.

**Interruption joins.** A Promise exposes no abort hook, so cancelling the fiber awaiting one does not
stop the work behind it — releasing its resources anyway is how a disposed session gets written to, or
a lease reaches the next turn while the previous one still runs. `portJoin` waits for the pending
promise before releasing; `portAbort` calls the port's own abort hook first and then waits;
`portRequest` owns an `AbortController`, applies a deadline, and closes the signal on every exit. `port`
is the abandonable case, for reads and for writes a caller is free to walk away from.

**The cause survives.** `PortFailure` carries the original error verbatim, because retry
classification, the channels' platform error types and every operator-facing message read it;
`portError` is how a caller gets it back.

One module, because each layer re-derived both during the Effect migration: the channel kit, the pi
engine, the AgentCore runtime and the scheduler each grew a tagged error, a squash-unwrapper and a
join-on-interrupt combinator that differed only in the word before `Failure`. `SessionBusy` stays a
separate tag in `engines/pi/session-effects.ts` because it is control flow, not a port failure.

## 3. Assembly ladder

| Rung | Function | Responsibility |
|---|---|---|
| L0 | `createPiAgentFromSession` | Adapt a pi `AgentSession` factory to the Agent Handler stream |
| L1 | `createPiAgent` | Assemble from typed model/instructions/tools/ports |
| L2 | `createPiAgentFromDefinition` | Load a definition directory and build the prompt |

`createPiAgentFromDir` sits above L2 and resolves placement, config, model, auth, tools, sessions, and
machinery paths. `dev`, `start`, `invoke`, and `fire` share it rather than carrying parallel
implementations.

Each invocation binds a fresh `AgentSession` to its record and disposes it after the turn.
Continuity comes from `PiSessionRecordStore`, not a resident session. That is L0's choice on the axis a
deployment owns: per-invoke state (SPEC MUST 6, what AgentCore and every scaled channel host require),
swappable at this rung alone — [conformance-levels.md](conformance-levels.md) states what each posture
owes.

Reopening is faithful to the whole record, not just the messages. pi does not read active-tool changes
back (its own session is resident), so `piAgentSessionFactory` resolves the active-tool set itself: the
union of the initial set (every non-deferred tool) and the session's accumulated activation *deltas* —
`fastagent:tool-activation` entries carrying exactly the names that call activated. pi's own
`active_tools_change` entries are full snapshots and are ignored: replaying one would freeze
later-added tools out of old sessions and keep a later-`deferred` tool active in sessions that never
discovered it. Corollary: *narrowing* the active set is not representable in this record.

This per-invoke assembly is the only data plane. A client needing mid-run control, live observation, or
reconnectable history uses the optional [session control plane](session-control.md) — never a second
way to start work, and never resident process state as the source of continuity.

## 4. Event translation and terminal discipline

pi's `AgentSession` exposes a subscription for streaming events and a `prompt()` that resolves without
a value — a turn's outcome is the assistant message the stream ended on, never an index into session
state (compaction and overflow recovery rewrite that array mid-turn).
`src/engines/pi/invoke-session.ts` combines the two into one async iterable. An Effect scope owns the
shared lease, session and subscription; an Effect queue carries projected events. `turn-kit.ts` owns
protocol projection and terminal classification; `session-effects.ts` supplies the scoped lease/session
acquisition shared with control-plane writes, and the Promise crossing itself is `src/effect-port.ts`
(see [Promise ports](#promise-ports)):

1. acquire the per-session lease;
2. publish `run_started` with the run's controls — before binding, so a dispatch that races the build
   queues on it rather than finding no run;
3. open/create the record and bind a session to it;
4. subscribe, translating pi events once into the rich `SessionEvent` vocabulary (the SPEC stream is
   its projection), then wake waiting controls so their synchronous queue events are observed;
5. run the prompt;
6. queue exactly one `completed` or `failed` terminal and wait for consumer settlement;
7. unsubscribe, dispose, publish exactly one `run_settled`, and release the lease.

The scope stays alive while output is buffered or the consumer is paused at its terminal. Consumer
cancellation interrupts the execution fiber, aborts and joins actual SDK work, and silences pending
reads. Acquisition stays uninterruptible so a late-created session cannot publish durable state after
its lease is released.

`SessionBusy` and `PortFailure` are typed failures inside execution. Protocol boundaries
translate failures and defects into `failed` events or existing `SessionResult` codes. Cleanup faults
are logged independently, continue remaining finalizers, and cannot overwrite a published outcome.

Control mutations take the same fail-fast lease. Manual compaction owns its own scope: admission
returns before model work finishes, and `compaction_finished` is published after cleanup and lease
release. Assembly services are explicitly injected and shared; sessions and subscriptions stay
per-operation. These scopes do not own channel turns, durable replay policy, or service shutdown.

pi retries a failed assistant request itself. That is free resilience while the turn is silent and
corruption once it is not — SPEC deltas are append-only, so a second attempt would concatenate its
answer onto the first one's half-sentence. L0 refuses the retry exactly there: once answer text has
been streamed, never on tool events (refusing on those would push the retry out to the caller, who can
only re-run the whole prompt and execute the tool a second time).

## 5. Tools, skills, and execution environment

Definition-local skills are the deployment truth. Runtime loading never scans global skill directories;
`fastagent add skill` may copy a global or remote skill into `skills/`, after which the vendored copy is
the source.

Workspace tools merge in this order: all pi coding tools
(`read`/`grep`/`find`/`ls`/`bash`/`edit`/`write`), then `config.tools`, then discovered
`tools/*.ts|js|mjs`. Earlier names win, collisions are reported, and broken discovered tools are
reported and skipped. The coding set is fixed for directory agents: isolation belongs around the whole
agent process, where it also covers authored tools and channel code. Conditional built-ins
(`search_tools` for deferred tools, `wake` for self-scheduling) keep their own policies. Reusable
integrations export ordinary `FastagentTool[]` for explicit `config.tools` mounting.

Every `defineTool` execution receives the same runtime context. Serving adapts the session it binds for
the turn, chat adapts its resident one, both through the same adapter onto the FastAgent-owned
read-only port (`getSessionId`, `getHeader`, `getBranch`) — `getSessionId` answers the *caller's* id,
not pi's encoded record name. Sessionless direct execution provides cwd but no manager. Native pi tools
receive the same workspace cwd and caller session id; their `thinkingLevel` getter reads the bound
`AgentSession`.

**Deferred tools** (`defineTool({ deferred: true })`) are registered but not initially active: their
schemas stay out of the request until the built-in `search_tools` loader (auto-mounted whenever a
deferred tool exists; an authored `search_tools` wins) activates them by keyword mid-turn. Activation
runs through a per-turn bridge on the turn context (`ToolActivation`: additive `setActiveTools`,
unknown names filtered) and is stamped on that tool call's own result as `addedToolNames` — the load
point that lets providers with native deferred loading add definitions at the transcript position
without invalidating the cached prompt prefix. The stamp comes from that execute's own `activate()`
calls, never an active-set snapshot diff: batch tool calls run in parallel and a diff would
misattribute a sibling's activation. The base prompt lists only non-deferred tools plus a discovery
note, computed from the static mounted set, so activation never rewrites the prompt. The shared session
builder (`session-builder.ts`, which `chat` consumes) emulates the same behavior over pi's
AgentSession through `sessionToolActivation`, so the author debugs exactly what serves.

**`ExecutionEnv` governs definition loading, not the tools.** All seven coding tools come from
pi-coding-agent and reach `node:fs` directly. Routing them through `env` was tried and given up: the
seam never closed anything by itself — author-written `tools/` import whatever they like — while it
cost a 167-line parity suite and a hand-built image pipeline. `env` is therefore **not** a sandbox: the
default tools bypass it, `tools/` is author code, `loadProjectContextFiles` reads ② context through
node fs directly, and `deploy`/channel machinery runs outside it entirely. A sandbox adapter constrains
the process it runs in.

## 6. Sessions and concurrency

The reference stores are `piInMemorySessionRecordStore()` for embedding/tests and
`piSessionRecordStore({ dir })` for restart-surviving local continuity.

Opening an existing session reconciles a dangling leaf tool call left by an interrupted process by
appending an explicit interrupted error result. This restores transcript validity; it does not make
side-effecting tools exactly-once.

The core lease allows one in-flight turn per session. A collision yields
`{ type: "failed", code: "session_busy", retryable: true, details: "…" }`. Queueing is channel policy:
Telegram, Slack, and Feishu/Lark serialize their own turns per session; HTTP and GitHub use the
fail-fast behavior.

## 7. Channels and hosting

A channel file has one of two explicit module forms:

```ts
// Existing HTTP route channel
(ctx: { agent, stateRoot }) => Routes

// Long-connection channel
{ name: string, connect(ctx, signal): { ready: Promise<void>, closed: Promise<void> } }
```

The distinction is structural: a function is a route channel, an object with `connect` is a
`LongConnectionChannelModule`. There is no shared mount object, ingress enum, or second metadata
declaration. Deployment imports enabled channel modules to inspect that shape without invoking route
modules or opening connections, so top-level module construction must not require runtime secrets. The
adapter owns reconnects; `AbortSignal` is the sole shutdown command, while `ready` and `closed` expose
lifecycle observation without a second `close()` path.

Enabled agent channels are files ending in `.ts`, `.js`, or `.mjs` under `channels/`. Renaming to
`telegram.ts.disabled` disables one without adding a second config source.

The loader collects all per-file diagnostics, but `dev`/`start` treats any broken enabled channel or
route collision as fatal: a declared inbound endpoint must not silently disappear, and a broken channel
must never cause the default `/invoke` route to appear. That route is mounted only when there are no
enabled channel files.

`mountAgentService` adds `GET /health`, starts long connections and schedules, and owns their shutdown.
A long-connection channel counts as declared, so the fallback `/invoke` does not appear. Health returns
503 until every long connection is ready, and again if one closes unexpectedly. The CLI binds the
service's handler through `channels/serve.ts` and exits on unexpected channel closure; its
SIGINT/SIGTERM handler closes the service and listener, force-closes active HTTP streams, and bounds
shutdown time. It does not drain Agent turns.

The resident service lifecycle uses an Effect scope for scheduler cleanup, connection readiness and
closure observers, and the caller's abort listener. Shutdown broadcasts the transport abort before
closing the scope, then waits for all connections under one deadline; its result is cached so
concurrent and repeated `close()` calls wait for the same completion or failure. Startup rollback uses
that same shutdown. Effect stays internal to `/node` service assembly, `/pi` execution/control, and the
stateful chat channels; `/core` and `/session` remain dependency-free and expose no Effect types.

`channels/sse.ts` owns the Fetch-only response lifecycle shared by HTTP invoke and session observation:
eager subscription, heartbeat, serialization and iterator cleanup; callers own their event shapes.
Synchronous subscription errors reach the HTTP error boundary before a response is created; errors
during body streaming close the source and heartbeat and propagate through the response body. The
remote invoke client stops at the first terminal event; malformed control envelopes fail visibly.

### Shared chat execution

Telegram, Slack, and Feishu/Lark use the same execution lifecycle. Acceptance persists intent before
ACK and counts queued work as busy immediately. Each turn runs in an independent Effect root fiber;
per-session successors wait for the preceding scope to close, while other sessions run concurrently.
Request completion does not close these fibers, and service shutdown does not drain them.

Platform hooks expose no abort operation, so releasing ownership while their Promises still run would
permit overlapping work and premature idle snapshots — `effect-port.ts` is what keeps that from
happening (see [Promise ports](#promise-ports)). Side-task drains observe only the tasks tracked when
called.

`invoke-turn-kit.ts` owns the turn itself: resolve the platform inputs, then ask the agent. A failed
resolution becomes a `failed` EVENT (SPEC MUST 2) whose only per-channel part is whether it is worth a
redelivery — Slack reads its API error's status, the other two say yes.

A write's rate-limit budget is the caller's to set, through `kit/transport.ts`. A live-preview frame
passes `DROPPABLE_FRAME`: the next frame carries the same snapshot and the terminal write supersedes
it, so waiting out a 429 for one parks the answer and every turn queued behind it. Writes whose content
exists only in that call — Telegram's placeholder send, Slack's ordered stream appends, every terminal
write — keep the default budget. How a platform signals a limit stays in each `*-api.ts`.

`runQueuedTurn` separates business settlement from resource cleanup. The `completed` callback removes
intent before committing the exact context snapshot consumed; later discussion stays buffered. Effect
interruption and process termination preserve unfinished intent for recovery.

The busy-retry stream pulls only on downstream demand. Each attempt owns its source iterator; a
first-event `session_busy` rejection closes that iterator before waiting on the Effect clock, and other
failures never reopen the retry window.

`delivery.ts` owns coalescing preview fibers and ordered native append/status queues. A preview starts
its first write synchronously, cancels pending pacing at finish, and joins an issued write before the
terminal update. Preview callbacks capture the turn context when crossing a synchronous API boundary,
preserving its clock without a global runtime. Snapshot renderers share terminal ownership; formatting,
continuation, and capability fallback stay platform-specific.

### GitHub

The GitHub adapter verifies the HMAC over the capped raw body, maps a verified delivery through the
agent's `on(event)` policy, acknowledges with 202, and runs turns in the process. It has no durable
post-ACK replay; an interrupted review is lost and logged.

### Telegram

Telegram is the stateful channel reference:

| Module | Responsibility |
|---|---|
| `parse.ts` | pure update/message parsing and summon policy |
| `invoke-turn.ts` | attachment resolution; the turn itself (busy retry, load-failure event, manifest wording) is `../kit/invoke-turn-kit.ts` |
| `../kit/turn-runner.ts` | the durable-turn lifecycle over queue + store + buffer (shared with Slack and Feishu) |
| `turn-store.ts` | telegram's record + ordering over the generic `../kit/turn-store.ts` |
| `context-buffer.ts` | telegram's entry shape over the generic `../kit/context-buffer.ts` |
| `preview.ts` | live preview and terminal write policy |
| `telegram-api.ts` | Bot API timeouts/retries and HTML-aware splitting |
| `../kit/state.ts` | atomic small JSON state files |

Turn replay is at-least-once: a crash can re-run side-effecting tools, and a narrow pre-ACK window can
run a delivery twice. Exactly-once execution needs a different backend/resume model.

### Slack

Slack is a first-party HTTP Events API sibling under `src/channels/slack/`. It keeps the neutral
`Agent.invoke` boundary and reuses the shared `turn-queue`, generic `turn-store`, generic
`context-buffer`, invoke-turn kit, `state`, `seen`, and `preview-kit`. Platform-specific modules own
signature verification/event acceptance, message subtype policy, thread participation/context,
private-file resolution, Web API transport, and dual native-stream / rate-limited edited-message
rendering.

The request boundary verifies Slack's `v0` HMAC over the capped raw body and a five-minute timestamp,
then persists turn intent and buffered context before returning 200. Logical dedup uses
`(team, channel, ts)` because `app_mention` and `message.*` subscriptions may overlap; `event_id` alone
does not identify that shared message. Sessions follow the place, not the ask: an answer goes in a
thread on the ask and that thread *is* the session, so there are no session modes. `context` group mode
subscribes to channel/private-channel/MPIM message streams, admits a bare human reply where the
participation rule allows it (see [participant-model.md](participant-model.md) §3), and folds other
discussion with the same peek→completed→commit invariant as Telegram/Feishu. `mentions` keeps the
least-privilege explicit-summon surface.

File events persist IDs only. Dequeue-time `files.info` resolves current metadata; authenticated
downloads are host-restricted, timeout/cap guarded, and translated to vision images or absolute local
paths. Primary files fail visibly; buffered files degrade individually. Outbound delivery uses Slack's
external upload three-step protocol and stays at-least-once across an ambiguous completion response.

Newly onboarded apps use Slack's `agent_view`, `assistant:write`, suggested prompts, Agent
status/title, and `chat.startStream` → `chat.appendStream` → `chat.stopStream`. Markdown text events
append to the stream; each engine-neutral tool start appends a compact factual trace, and a failed tool
end appends one line naming the call. Raw model thinking and tool output stay private — reading output
would mean guessing the engine's result shape. The compatibility renderer retains one edited message
with a strict three-second mutation interval; a custom route reaching a top-level target selects it
(both ways of getting there are listed on the `rendering` option in `slack.ts`) because native streams
require a parent user message. HTTP Events API is the production transport; Socket Mode is a separate
future boundary.

`add slack` owns a single-workspace internal-app control plane outside `ChannelModule`: a temporary
unguessable challenge/OAuth responder, mode-specific App Manifest creation, OAuth-v2 code exchange, and
irreversible-boundary recovery state. The long-lived bot token + Signing Secret go to `.env` (bot-token
rotation is left off: it would ship the refresh token and client secret beside the access token); the
more powerful App Configuration refresh token stays owner-local and never enters deployment secrets.
`dev --tunnel` and `deploy --run` rotate it locally and update the Request URL through
`apps.manifest.update`. This is not Marketplace/multi-workspace installation storage.

### Feishu (canonical) / Lark (compatibility)

Feishu is the second stateful chat-channel reference, shaped as a sibling of Telegram. Its canonical
implementation lives in `src/channels/feishu/`: `feishu.ts` wiring, `parse.ts` pure policy,
`model.ts`/`normalize.ts` content decoding and resource normalization, `invoke-turn.ts` IO assembly,
`preview.ts` delivery, `feishu-api.ts` transport/token pipeline, `crypto.ts` security math, `card.ts`
builders, and registration automation. `shared-api.ts` gives mounted channels and proactive send tools
one transport per cloud and state root. Shared mechanisms live in `channels/kit/`, whose defining
property is that its consumers are only platform directories; `wait-health` and `registration` sit one
level up because theirs are not.

**Feishu is the design center; Lark is a compatibility profile.** The clouds share event/card/crypto
wire formats, but Lark international trails Feishu in app creation and application-config APIs.
`src/channels/lark/lark.ts` is a thin branded adapter over the Feishu engine; `lark/onboard.ts` owns
Lark's degraded guided/manual onboarding; `feishu/cloud.ts` records the capability differences. A kind
still owns its channel identity, env, state, logs, and onboarding: `feishuChannel` returns
`POST /feishu`, `feishuWebSocketChannel` returns a long-connection module, and the Lark factories mirror
those boundaries. One agent can run both clouds. Outbound APIs and webhook handling are fetch-based;
WebSocket ingress is isolated behind the official `@larksuiteoapi/node-sdk` because its protobuf
connection protocol is not a stable hand-authored surface. What is platform-different:

- **The live preview is a streaming card, not an edited text message.** The platform caps text edits at
  20 per message and sends at 5 QPS per chat; cardkit streaming (50 QPS per app / 10 per card, strictly
  increasing `sequence`) is its designed AI-output channel. A queued turn mounts that same card early
  with a reply-quoted `⏳ Queued` state; execution takes the entity over in place and the card settles
  into the final Markdown answer, so there is no recall tombstone or ambiguous second reply. Degrade
  tiers: card fails → static text placeholder; streaming closed mid-turn → frozen preview, the settle
  still lands.
- **Verification is modal and fail-closed.** With an Encrypt Key, ordinary events require a signature
  over the raw body → AES decrypt, and plaintext is refused. Feishu excludes Request URL verification
  from event signatures, so its encrypted `url_verification` challenge takes the narrow decrypt →
  exact-type → constant-time token path. Without an Encrypt Key, events use the same constant-time
  verification-token match in plaintext.
- **Turn identity and delivery dedup use `message_id`; recovery order is an explicit `seq`.** Feishu
  ids carry no arrival order, unlike Telegram's numeric `update_id`, while the platform documents
  duplicate pushes even after a successful ACK. A bounded persisted `seen.ts` ring filters deliveries
  that already produced a durable turn intent or buffered entry. It is post-persist, best-effort
  insurance rather than exactly-once: a crash between the state and ring writes, a failed ring write,
  or an id beyond the cap retains the at-least-once tail.
- **Session partitioning follows the place, not the ask.** A chat is one session (`<kind>:<chat_id>`)
  and a thread is another (`<kind>:<chat_id>:<thread_id>`), branded with the channel kind because
  session ids share one namespace across every channel in a deployment. A room keeps one memory
  everyone in it shares; a side conversation keeps its own. Keyed by `thread_id`, never `root_id`: the
  platform's `root_id` tracks the reply chain and can differ between messages of one thread, which
  would split a side conversation across sessions and buffer buckets. One place stays FIFO while
  different places run concurrently — the concurrency unit is the place because the causal unit is.
  The rules are derived in [participant-model.md](participant-model.md); there is no session-mode
  option.
- **Speaking is gated by who is in the place, listening is not.** Direct messages always answer; a
  group's main timeline requires an @mention; inside a thread the agent answers bare messages only
  while it takes part and has not heard a second human. Everything else it can see is buffered as
  context (`im:message.group_msg` buys the hearing). An explicit mention of only other people is
  discussion, never an ask. A message's `parent_id` referent is always loaded — a quote is the user
  pointing at something that may predate this session — and an unreadable referent degrades to a marker
  rather than failing the turn.
- **Thread participation is what the channel heard, not a claim about the thread's membership.** The
  agent speaks unprompted in a thread only where it has answered before and has heard at most one
  human; both facts come from observed messages and nothing is read back from the platform. That is a
  deliberate weakening: a thread joined before this deployment reads as unheard and takes one mention
  to re-enter, self-healing in one message. `thread-participants.json` records, per thread, the humans
  heard (capped at two — the rule only asks whether a second exists) and whether this agent has spoken.
  Observations only accumulate: no platform emits an event when someone stops taking part, and the
  error directions are asymmetric — over-counting makes the agent ask to be named, under-counting makes
  it speak into a crowd. Because nothing is fetched, acceptance stays synchronous inside the ACK window.
- **Group visibility is scope-gated and chosen during onboarding.** `Context-aware groups` (recommended)
  requests the sensitive `im:message.group_msg` scope; `Mention-only` is the least-privilege
  alternative. The CLI states that the former delivers all group messages, adds it to the app draft
  through application-v7 config when supported, opens tenant-admin approval, and reports the granted
  capability again at startup. A mention arriving before the startup `bot/v3/info` settles is kept as
  context rather than answered (fail-closed: without its own open_id the channel cannot tell a mention
  of itself from one of someone else). Other human discussion is persisted in `buffers.json`, bucketed
  by main chat or thread, and folded into that place's next answered turn under the same
  peek→commit-on-`completed` invariant. Non-`user` senders are dropped. A reply summon carries only
  `parent_id`: the referent is fetched as primary input and the chain above it as context (oldest-first,
  one shared text budget, a visible truncation line when the walk ends short of the root — see
  participant-model.md §8).
- **Ingress is an onboarding-time app choice.** `add feishu|lark` asks for WebSocket or webhook and
  writes the corresponding factory into the channel module. WebSocket needs only App ID/Secret and
  skips token capture, tunnel, Request URL registration, and platform crypto; the official SDK
  authenticates and reconnects the connection and converts handler throws into 500 ACK frames. Webhook
  retains the application-v7 PATCH/challenge flow, Verification Token, optional Encrypt Key, and Lark's
  config-route-404 manual fallback. Subscription mode is app-level and mutually exclusive: changing the
  factory alone does not migrate the app.
- **A WebSocket adapter is a long-connection channel and therefore always-on.** Fly generates
  `min_machines_running=1`, Railway forbids App Sleeping, webhook registration is skipped, and only App
  ID/Secret travel as channel secrets. Event callbacks must still finish within three seconds, so the
  shared acceptance boundary persists and enqueues only.

## 8. Schedules and self-scheduling

Static schedules are `schedules/<name>.ts` files exporting `{ cron, tz?, prompt }`. The scheduler
derives the stable session `schedule:<name>`, claims a slot before invoking, catches up one overdue
occurrence after downtime (not every missed slot), records each run in
`<stateRoot>/schedule/runs.jsonl`, and leaves delivery to agent tools.

The resident scheduler owns one Effect loop per cron and one sequential wake loop. Their waits use the
captured Effect clock; Croner computes calendar instants, with capped waits rechecking wall time. Cron
claim IO failures are typed: the resident loop logs and audits a skipped fire, while external slot
delivery receives the original error.

`stop()` interrupts pending waits synchronously without draining or canceling a claimed occurrence.
That occurrence finishes execution and settlement before its loop exits; no next wake is claimed.
Waiting loops do not count as business work. Wake execution keeps its busy ownership through one-shot
deferral and audit, so the idle notification observes settled state.

With `selfSchedule: true`, the serving path mounts `wake`/`unwake`. Wake-ups are persisted, bounded by
minimum delay/frequency and per-session count, and fired back into the originating session. A one-shot
wake that hits `session_busy` is deferred because the turn never started; other failures are not
replayed because tools may already have produced side effects.

Schedules need one continuously running process. Deploy preflight prevents scale-to-zero settings that
would silently miss clock events.

## 9. State and deployment

`FASTAGENT_STATE_DIR` selects the one machine-state root:

```txt
<stateRoot>/                # <agent dir>/.state (FASTAGENT_STATE_DIR overrides)
├── sessions/
├── channels/telegram/  channels/slack/  channels/feishu/
└── schedule/
```

Credentials live separately under `<agent dir>/.secrets/` (`FASTAGENT_SECRETS_DIR` overrides) because
the deploy lifecycle differs: secrets ride the host's secret store or the auth seed, state rides the
volume. A deployed box points both knobs at its volume so a rotated OAuth credential persists.

The shipped file-backed implementations are single-process. Multiple instances require shared session,
lease, credential, and channel-state backends; sharing one local state directory between processes is
unsupported.

`fastagent deploy docker|fly|railway|agentcore` generates a Dockerfile, target config,
persistent-volume wiring, required secret names, and a runbook. Docker adds a user-owned
`fastagent.compose.yml`; `--tunnel` can add a separate ephemeral cloudflared service, while durable
ingress stays operator-owned. `--run` alone causes host side effects; for a tunnel topology it also
reads the Quick Tunnel URL and registers webhooks.

Deploy requires a nested definition. The image seeds the persistent workspace once; later releases
replace only the definition subtree. Artifacts sit under the agent prefix, with the workspace-root
`.dockerignore` the host context packers require; preflight checks that a kept ignore file ships the
definition and excludes credentials. Git history ships when the host packer permits it, and the image
installs Git when the workspace contains `.git` — git is an optional collaboration mechanism, and
storage preserves unfinished work without commits or pushes.

`deploy/workspace.ts` owns the shared deployed lifecycle. Storage contains `base/` (cwd), `.state/`,
`.secrets/` and `.deployment/`, and a generated release manifest selects the definition. A
process-lifetime lease precedes initialization; staged trees and a pending journal make definition
replacement recoverable. The same release preserves agent edits; a new one removes obsolete definition
files while keeping everything outside the definition. Credentials seed only when absent. Nothing is
mounted or unmounted by fastagent: the host's volume is the only storage.

`start` loads the actual service from the persistent definition's installed package, because its tools
and session context must use the same runtime module instance — reusing the image's engine after
copying dependencies would give tools a different `AsyncLocalStorage`. Dependency installation stays
marked until it succeeds: an interrupted install may already have created the CLI link, so link
existence alone cannot authorize reuse.

**AgentCore** (AWS Bedrock AgentCore Runtime) differs in kind: the platform has no public URL (ingress
is the SigV4 `InvokeAgentRuntime` API only) and no resident process (compute is per-session microVMs,
reclaimed when idle). The generated CloudFormation stack therefore carries a forwarder Lambda (public
Function URL → `{method,path,headers,bodyB64}` envelope → `InvokeAgentRuntime`) fronting the webhooks,
and EventBridge Scheduler rules delivering each cron slot. Inside the container,
`FASTAGENT_AGENTCORE=1` makes `start` mount the adapter (`channels/agentcore.ts`): `POST /invocations`
unwraps the envelope — a webhook is reconstructed verbatim and dispatched to the *same* channel routes
(signature verification unchanged; the channel's real HTTP response rides back inside a transport-200
reply so the forwarder re-emits it byte-exact), a schedule fire goes through `fireScheduleOnce` with
the slot as the idempotency key (EventBridge delivery is at-least-once), and an invoke streams back as
SSE. `GET /ping` reports `HealthyBusy` while background turns run (`channels/busy.ts`) so an idle
reclaim cannot kill a post-ACK turn, and always carries `time_of_last_update`: the field is documented
as optional, but measured platform behavior reads only it — without it the idle timer counts from the
last `InvokeAgentRuntime` and reclaims mid-turn regardless of `HealthyBusy`. All ingress traffic shares
one fixed runtime session, since channel state is single-writer by design.

The two process boundaries stay two explicit log sources: Runtime application stdout/stderr and the
forwarder Lambda's ingress log. `fastagent logs agentcore` derives the stack from the workspace name,
discovers the Runtime endpoint log group from its `RuntimeArn`, and tails it; `--source forwarder`
selects the Lambda group. It applies no stream filter: AgentCore names streams
`YYYY/MM/DD/[runtime-logs]<session>`, so the marker is an infix after the UTC date path and a
`--log-stream-name-prefix` match is always empty.

**AgentCore uses managed SessionStorage at `/mnt/data`, and a deploy resets it.** The same `base/`,
`.state/`, `.secrets/` layout applies on the platform's own mount: it survives compute stop/resume, so
an idle-reclaimed agent resumes with its memory, and AWS wipes it on every runtime version update — i.e.
every deploy — and after 14 idle days. That is this host's stated semantics, not a gap: AWS's only
cross-deploy filesystems are EFS and S3 Files, both VPC-only, and VPC mode costs a NAT gateway for
model/channel egress (~$33/mo standing). Buying cross-deploy state with an S3 snapshot instead was
tried and removed: it cost a presign path in the forwarder, a refresh endpoint, a `checkpoint` envelope
and a save-on-idle edge — roughly 700 lines whose failure modes were invisible until a deploy. A host
without a volume promises no volume; Fly and Railway are where cross-deploy memory lives.

Credentials need no extra rule: `maybeSeedAuth` is absent-only, so a restart within a release keeps
what the box rotated and a deploy re-seeds from `FASTAGENT_AUTH_SEED`. Deploying IS re-authenticating.
The caveat is OAuth's: a refresh token is single-use and shared with the builder machine, so the box
can lose model access between deploys and the fix is another deploy.

Runtime filesystems appear on invocation, so `deferAgentcoreService` exposes `/ping` before any
persistent definition or credentials are opened. Initialization runs in two stages, split by what a
retry would cost. Taking the workspace (`prepareStartWorkspace`) starts nothing and releases its lease
before failing, so a failed attempt is retried by the next envelope — an unmounted volume and a lease
the outgoing session still holds clear on their own, and caching them would make a healthy microVM
refuse every envelope until it is reclaimed. Assembling the service (`openPreparedWorkspace`) mounts
channels and starts the scheduler, so both its outcomes are cached; a second attempt would run two
schedulers over one claim state. Concurrent envelopes share one attempt at each stage, and mount or
initialization failures cannot start an empty agent.

The process retains its workspace lease until exit, including failed activation and shutdown, since
service close does not drain every background writer. Only the OPEN is caught there: a failure inside
the opened service's handler is its own, and reporting it as an initialization failure would also read
a body the handler already consumed. `flock` acquires the parent's open-file-description lock through
an inherited fd — the kernel retains it through process pauses and releases it on exit, so startup
never infers a dead writer from a missing JavaScript heartbeat.

`deploy agentcore --run` stops the fixed runtime session, then probes the new serving path through
`/__fastagent/probe`. Authenticated initialization and channel failures use transport-200 structured
verdicts `{ ok, error? }`, preserving their diagnostics through the forwarder — the ordinary webhook
relay folds a non-200 into an opaque 502. All entry points use the same runtime session id; the
envelope session id selects the conversation. The S3 bucket holds only the content-hashed forwarder
deployment package.

AgentCore IO crosses the Promise boundary through `src/effect-port.ts` like every other host port:
activation and channel construction are cached Effects, failures included — uninterruptible, because a
cached exit must be a success or a diagnosable failure, never a remembered interruption — and the
alarm sink's deadlines use the captured
Effect clock, abort the actual request and join its settlement before releasing ownership or retrying.
Non-abortable filesystem ports are joined rather than abandoned. The sink counts admission
synchronously and yields before reconciling, so an empty alarm set cannot emit idle between a wake's
claim notification and the scheduler's execution admission. A persisted alarm URL is validated: only a
missing file reads as "not configured yet".

A live session keeps its old compute (and the old image) until reclaimed, so `--run` stops the ingress
session after a successful deploy. Self-scheduled wake-ups are EventBridge-backed: every wakeups-store
mutation notifies a sink (`schedule/wake-alarm.ts`) that POSTs the pending set to the forwarder's
reserved path (shared secret), and the forwarder mirrors each into a self-deleting one-shot EventBridge
schedule that pokes it at the instant — waking the container, whose ordinary wake pump fires the due
entry. The forwarder injects its own URL into every envelope, so nothing is circularly baked into the
template, and wake-alarm reconciliation begins with a trusted forwarder envelope carrying the current
callback URL: a public invoke cannot redirect it. Structural limit: long-connection channels cannot
run, because nothing can restore their ingress when compute is reclaimed.

## 10. Current boundaries

Explicit limits, not implied capabilities:

- pi is the reference implementation; additional engine bindings can implement the same Agent contract;
- `ExecutionEnv` alone is not a complete sandbox for directory agents;
- GitHub post-ACK work has no replay; Telegram, Slack, and Feishu/Lark replay is at-least-once;
- file-backed state is single-process;
- the AgentCore target has no resident process: long-connection channels are unsupported there, and a
  wake-up set in a direct-invoke session fires only while that session's compute is awake;
- observability is logs/traces, without an OpenTelemetry exporter.

Keep new implementations behind the existing contract rather than adding speculative concepts to it.
