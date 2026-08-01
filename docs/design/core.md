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

There is ONE agent shape and ONE marker. The shape:

```txt
<agent dir>/                # any name — the config below is what makes it an agent
├── persona.md              # optional identity
├── AGENTS.md               # optional project context
├── skills/
├── tools/
├── channels/
├── schedules/
├── fastagent.config.mjs    # THE marker
├── .gitignore              # scaffolded ONCE by init, yours after: node_modules, .state, a stray .env
├── .secrets/               # secrets: .env + auth.json, behind their own .gitignore (only .env.example travels)
└── .state/                 # mutable machine state: sessions, channel state, schedule state
```

The other noun is the WORKSPACE — what the agent works ON: its cwd, its coding tools' root, deploy's
build context, and whose `AGENTS.md` ancestors are ② context.

**The workspace is the directory you point fastagent at.** That is the whole rule, and it means the same
tree answers two ways depending on where you aim it:

```txt
repo/                       # `fastagent dev` here  → agent = repo/agent, workspace = repo
├── AGENTS.md
├── src/
└── agent/                  # `fastagent dev` here  → agent = repo/agent, workspace = repo/agent
    ├── persona.md  skills/  tools/  channels/  schedules/
    ├── fastagent.config.mjs
    └── .secrets/  .state/
```

Neither reading is wrong. Point at the project and its agent serves with the project as its workspace
(what `init` sets up, and the common case). Point at the agent directory — all a deployed box may have
been shipped — and it works on itself; a rule insisting the workspace is always the parent would hand
that container `/`. The same holds when the agent directory IS the project (`init --flat`: a standalone
agent repo, a monorepo package), where the agent's `read`/`write`/`bash` tools operate on its own
definition. That is not a separate placement mode; it is the one rule with the two directories equal.

| `dir` | Result |
|---|---|
| holds a `fastagent.config.*` | `{ agentDir: dir, workspace: dir }` |
| exactly one directory inside it holds one | `{ agentDir: <that dir>, workspace: dir }` |
| several do | `FASTAGENT_AGENT` names one, else the one named `fastagent` — else throws, naming them |
| none | throws: not a fastagent agent, with the exit that fits the position |

- **The marker is the config, at every position — and it is a DECLARATION, not configuration.** Nothing
  in an agent directory is logically required to serve a turn (the model can come from `--model`, the
  tools default from pi, the loop is fastagent); what a directory must do is SAY it is an agent, because
  the alternative is guessing. `export default {}` is a signature. So the marker has to be the one
  artifact present in EVERY agent and absent from every non-agent: `persona.md`, `skills/`, `tools/`,
  `channels/` and `schedules/` are each optional by design, and generic enough that scanning for them
  would read half the world's repositories as agents. Only the config qualifies — the same job
  `package.json`, `Cargo.toml`, `go.mod` and `pyproject.toml` do for their tools, none of which sniff for
  evidence or make the manifest optional. An agent directory needs no reserved name either
  (`--agent-dir` calls it anything), and a directory holding nothing but a config IS a complete agent.
- **The scan is ONE level.** Deeper is that directory's own workspace, not this one's agent: for
  `repo/packages/reviewer/` you point at the package (or run from inside it), and it works on itself.
- Resolution never walks UP (an agent must not be claimed from arbitrarily deep inside it), but the
  REFUSAL reads the path so each dead end gets its own exit: inside an agent → `cd` to it; on a
  directory holding several → point at one.
- **The cost of aiming being load-bearing** is that `cd agent && fastagent dev` narrows the workspace to
  the agent's own directory. Three things carry it: `dev`/`start`/`info` print `agent:` and `workspace:`
  on every run; the explicit form (`fastagent dev ..`) is always exact; and when the parent carries an
  `AGENTS.md` or a `.git`, the report adds a `hint:` line pointing at it. A hint may use that heuristic
  precisely because a RULE may not.

`init` mirrors the same discipline — it either creates, or refuses with the reason. Its one placement
duty follows from the lookup: **the target must be an agent the lookup would return**, so `init` refuses
when `dir` already resolves over something else (a config AT `dir` beats anything inside it; a second
sibling agent would make `dir` name neither). Beyond that, a SUBDIRECTORY target must be empty (content
there is an unfinished agent or something unrelated, and landing persona.md beside it would be a silent
mix), while `--agent-dir .` is a directory being adopted — content is expected, so every existing file is
KEPT (reported, never overwritten, never verified).

The two machinery dirs map onto deploy lifecycles: `.secrets/` travels through the host's secret
store (never an image), `.state/` through a volume (`FASTAGENT_SECRETS_DIR`/`FASTAGENT_STATE_DIR`
point both at it in a container).

**Git is the author's, not fastagent's — with one stated exception.** `init` scaffolds two ignore files:
the agent's own (`node_modules`, `.state`, a stray `.env`) and `.secrets/.gitignore` (`*` minus the
template). No command reads, verifies or rewrites an ignore file, ever. The exception is narrow and
one-directional: **the directory fastagent writes secrets into carries its own `.gitignore`** — so
`add <channel>`, which mints an unrecoverable app secret, writes that file (`wx`, never over an existing
one) when the DEFAULT `<agentDir>/.secrets` has none — the reachable case being a hand-made agent. The
accepted cost: someone who deleted that file to track secrets deliberately gets it back once. The risk
is not symmetric — that is an annoyance, the other way is a published credential. The two ignore files
are split because the root one is the file an author has reason to edit: git's nested-ignore precedence
keeps the credentials protected whatever happens to it.

The exception stops at fastagent's OWN directory. A secrets dir named by `FASTAGENT_SECRETS_DIR` belongs
to the operator, and the template is `*` plus two negations — dropping it there would hide that
directory's other contents from their `git add`, a bigger harm than the one it prevents and inflicted on
a path they chose deliberately. `add <channel>` states the fact instead and lets them own it.

What was deleted, then, is fastagent MANAGING ignore files: unconditionally, from
several commands, behind a decision procedure ("is this path under a directory we control?") that
approximated git's own semantics with containment comparisons against a different anchor per command. It
produced four reversals of the same predicate in review, and could ABORT `login` over an ignore file the
author had edited. The question it was approximating — "will git see this?" — has exactly one authority,
and users configure their own ignore rules. What remains is one write, from one command, at the moment a
credential is created, and never over an existing file.

(“Embedded” in fastagent's docs means one thing only: using fastagent as a LIBRARY inside your app —
see docs/embedding.md.)

**Known boundary (accepted, documented):** the workspace is `agentDir` itself or its immediate parent —
never further, because the lookup only ever finds an agent at the directory you named or one level
inside it. Reaching an agent two levels down means pointing at the level above it.

**Several agents on ONE workspace** is a supported shape, not a collision: an engineer's, a PM's and a
content owner's agent can each drive the same repository, all with that repository as their workspace.
`FASTAGENT_AGENT` selects between them, and the directory named `fastagent` (the `init` default) breaks
the tie when nothing else does.

Two properties of that, both choices:

- **The env selects, a file does not.** Selection is per-PERSON — that is the whole scenario — and a
  committed workspace file is shared by construction, so it cannot express "mine". The per-repo,
  per-person file this needs already exists and is not ours to invent: `.envrc`
  (`export FASTAGENT_AGENT=pm`), committed for a shared default or ignored for a personal one. A
  workspace-level REGISTRY was considered and rejected for a second reason too: the one-level scan
  already answers "which agents are here", so a list could only drift from it — and it would centralize
  what the scan decentralizes (adding an agent means creating a directory, not editing a file three
  teams share).
- **It ASSERTS, at any count.** A directory holding no agent by that name resolves to nothing, even
  when exactly one agent is sitting there: serving a DIFFERENT agent than the one asked for is the
  silent wrong-target refused everywhere else here, and a rule that changed meaning with the sibling
  count would be worse than the cost it avoids. Stated cost: a value exported in a shell PROFILE
  refuses in every unrelated directory it travels into — scope it per-repo, which the refusal says.
- **`deploy` bakes it.** The container re-resolves placement at `/app`, and a workspace holding several
  agents ships all of them (the build context is the whole tree), so the generated Dockerfile pins
  `ENV FASTAGENT_AGENT=<name>`. Without it the image would pick by its own rules rather than by the
  deploy — the artifact depending on the builder's environment, which is what it must never do.
- **The default NAME breaking the tie is the one place a directory name carries weight**, and it is
  deliberately not an identity rule: the config alone says what IS an agent, the name only decides which
  already-identified one answers. It buys that adding a second agent to a working `<workspace>/fastagent/`
  setup does not break the command everyone already types.

The pi reference prompt has four segments:

| Segment | Source |
|---|---|
| ① engine base + identity | `piBasePrompt`; `persona.md` replaces its default identity line |
| ② project context | `AGENTS.md` files loaded by pi from the agent dir and the workspace ancestor walk |
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

`createPiAgentFromDir` sits above L2. It resolves the placement (`resolvePlacement`), config,
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

**`ExecutionEnv` is where the default tools reach the machine.** `read`/`bash`/`edit`/`write` come from
pi-agent-core and take the env as the turn's tool context (pi 0.83), rather than from pi-coding-agent,
whose identical four are wired to `node:fs` directly — the model-facing surface is asserted equal in
test/tools-parity.test.ts, so the choice is about WHERE they touch the machine, not what the agent sees.
Injecting a custom `env` therefore governs the tools that actually do the touching, which is what makes
it a seam worth having.

It is still not a complete sandbox, and the gaps are specific: `loadProjectContextFiles` reads ② context
through node fs DIRECTLY rather than the env (definition.ts states this as a known break), fastagent's
OWN tools (`tools/`) are author code that can import anything, and `deploy`/channel machinery runs
outside it entirely. A sandbox adapter provides an `ExecutionEnv` AND constrains the process it runs in;
`env` alone narrows the blast radius rather than closing it.

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

Enabled agent channels are files ending in `.ts`, `.js`, or `.mjs` under `channels/`. Renaming a
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
agent's `on(event)` policy, acknowledges with 202, and runs turns in the process. It has no durable
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
thread participation/context, private-file resolution, Slack Web API transport, and dual native-stream /
rate-limited edited-message rendering.

The request boundary verifies Slack's `v0` HMAC over the capped raw body and a five-minute timestamp,
then persists the turn intent and any buffered context before returning 200. Logical dedup uses
`(team, channel, ts)` because `app_mention` and `message.*` subscriptions may overlap; `event_id` alone
does not identify that shared message. Sessions follow the place, not the ask: an answer goes in a
thread on the ask and that thread IS the session, so there are no session modes to select. `context`
group mode subscribes to channel/private-channel/MPIM message streams, admits a bare human reply where
the participation rule allows it (the agent has answered there and no second human has been heard —
see participant-model.md §3, and the Feishu bullets above for the shared store), and folds other
discussion with the same peek→completed→commit invariant as Telegram/Feishu. Answering an explicit
summon inside an existing human thread is exactly what makes the agent a participant of it. `mentions`
keeps the least-privilege explicit-summon surface.

File events persist IDs only. Dequeue-time `files.info` resolves current metadata; authenticated downloads
are host-restricted, timeout/cap guarded, and translated to vision images or absolute local paths. Primary
files fail visibly; buffered files degrade individually. Outbound file delivery uses Slack's external
upload three-step protocol and remains at-least-once across an ambiguous completion response.

Newly onboarded apps use Slack's `agent_view`, `assistant:write`, token rotation, suggested prompts, Agent
status/title, and `chat.startStream` → `chat.appendStream` → `chat.stopStream`. Standard Markdown text events append to
the stream; each engine-neutral tool start appends a compact factual Markdown trace, and a failed tool end
appends one line naming the call. Raw model thinking and tool output stay private — reading output would
mean guessing the engine's result shape. An append-only stream is also the one renderer whose persisted
message keeps the process beside the answer; the others settle into the answer alone. The compatibility renderer retains one edited message with a strict
three-second mutation interval; a custom route reaching a top-level target selects it (either way of
getting there is listed on the `rendering` option in `slack.ts`) because native
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
`thread-participants.ts` thread-participation cache, shared `../seen.ts` bounded delivery dedup,
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
without becoming the core. Both share `channels/<kind>/` state and the same event engine. One agent
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
- **Session partitioning follows the place, not the ask.** A chat is one session
  (`<kind>:<chat_id>`) and a thread is another (`<kind>:<chat_id>:<thread_id>`) — branded with the
  channel kind because session ids share ONE namespace across every channel in a deployment. The id
  becomes a percent-encoded jsonl filename, so its real bound is the filesystem's 255 bytes, which
  platform ids do not come close to. A room keeps one memory that everyone in it shares and a
  side conversation keeps its own. Keyed by `thread_id`, never `root_id`: the platform's `root_id`
  tracks the reply chain and can differ between messages of one thread, which would split a side
  conversation across sessions (and across context-buffer buckets). One place stays FIFO while
  different places run concurrently — the concurrency unit is the place because the causal unit is.
  The rules, and why they are derived rather than configured, are in
  [participant-model.md](participant-model.md); there is deliberately no session-mode option.
- **Speaking is gated by who is in the place, listening is not.** Direct messages always answer;
  a group's main timeline requires an @mention; inside a thread the agent answers bare messages only
  while it takes part and has not heard a second human. Everything else it can see is buffered as context
  (`im:message.group_msg` is what buys the hearing). An explicit mention of only other people is
  discussion, never an ask. A message's `parent_id` referent is ALWAYS loaded — a
  quote is the user pointing at something that may predate this session. (Skipping it inside a thread
  the agent had answered in was tried and removed: see participant-model.md §8.) An unreadable referent
  degrades to a marker in the prompt rather than failing the turn.
- **Thread participation is what the channel HEARD, not a claim about the thread's membership.** Two
  decisions:
  - *Predicate.* The agent speaks unprompted in a thread only where it has answered before and has
    heard at most one human. Both facts come from the messages the channel observes; nothing is read
    back from the platform. That is a deliberate weakening: a thread joined before this deployment (or
    before a lost state file) reads as unheard and takes one mention to re-enter — the same bootstrap
    every thread starts with, self-healing in one message and visible to the user. The alternative was
    built and removed: a pre-ACK `listThreadSenders` bought a membership claim its own 50-message page
    cap made incomplete anyway, at the price of a failure taxonomy, an ACK budget, request aborts, a
    completeness flag, and a duplicate-delivery join — where nearly every defect in the feature lived.
    See `src/channels/thread-participants.ts` and design/participant-model.md §3.
  - *Storage.* `thread-participants.json` records, per thread, the humans heard (capped at two — the
    rule only asks whether a second one exists) and whether this agent has spoken. Observations only
    ever accumulate: no platform emits an event when someone stops taking part, and the error
    directions are asymmetric — over-counting makes the agent ask to be named, under-counting makes it
    speak into a crowd. Because nothing is fetched, acceptance stays synchronous inside the ACK
    window and the delivery dedup ring alone keeps a re-push idempotent.
- **Group visibility is scope-gated and chosen during onboarding.** `Context-aware groups`
  (recommended and initially selected) requests the sensitive `im:message.group_msg` scope;
  `Mention-only` is the least-privilege alternative. The CLI states that the former delivers all group
  messages, adds it to the app draft through application-v7 config when supported, opens tenant-admin
  approval, and reports the granted capability again at serving startup. A mention arriving before the
  startup `bot/v3/info` settles is kept as context rather than answered (fail-closed: without its own
  open_id the channel cannot tell a mention of itself from one of someone else) and is folded into the
  next answered turn in that place. Explicit @bot turns always invoke; bare
  human messages invoke only under the thread-participation rule above. Other human
  discussion is persisted in `buffers.json`, bucketed by main chat or thread, and folded into that
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
<stateRoot>/                # <agent dir>/.state (FASTAGENT_STATE_DIR overrides)
├── sessions/
├── channels/telegram/
├── channels/slack/
├── channels/feishu/
└── schedule/
```

Credentials live separately, under `<agent dir>/.secrets/` (`FASTAGENT_SECRETS_DIR` overrides):
a different deploy lifecycle — secrets ride the host's secret store / the auth seed, state rides the
volume; a deployed box points both env knobs at its volume so a rotated OAuth credential persists.

The shipped file-backed implementations are single-process. Multiple instances require shared session,
lease, credential, and channel-state backends; sharing one local state directory between processes is
unsupported.

`fastagent deploy docker|fly|railway|agentcore` generates a Dockerfile, target config, persistent-volume
wiring, required secret names, and a runbook. Docker adds a user-owned `fastagent.compose.yml` with one
app service; `--tunnel` can add a separate ephemeral cloudflared service, while durable ingress remains
operator-owned. `--run` alone causes Docker/host side effects; for a tunnel topology it also reads the
Quick Tunnel URL and registers webhooks. Deploy has ONE semantic — bake the
workspace as the image (WYSIWYG: what you see is what ships, git or not, clean or not). Every artifact
(Dockerfile, fly.toml, compose, railway.json) sits under ONE derived value, the agent prefix: the agent
directory's name plus a slash when it sits inside the workspace, `""` when the agent IS the workspace.
When they differ, the single write outside the agent is the workspace-root `.dockerignore` the host CLIs'
context packers require (kept if the workspace owns one — when they are the same directory that file is
the agent's own artifact and is
refreshed like the rest; preflight then ASKS that file — through the `ignore` matcher, with dockerignore's
root-anchoring applied — whether it would drop the agent dir or ship `fastagent/.secrets/auth.json`:
either gates `--run`, else warn). `.git`
ships by default: freshness (pull) and write-back (commit/push) are the AGENT's runtime behavior, not
deploy machinery — the git binary is baked in exactly when the workspace ships a `.git`; a non-git
workspace adds it via `config.deploy.apt`.

**AgentCore** (AWS Bedrock AgentCore Runtime) differs from the resident-box hosts in kind: the platform
has no public URL (ingress is the SigV4 `InvokeAgentRuntime` API only) and no resident process (compute
is per-session microVMs, reclaimed when idle). The generated CloudFormation stack therefore carries a
forwarder Lambda (public Function URL → `{method,path,headers,bodyB64}` envelope → `InvokeAgentRuntime`)
fronting the webhooks, and EventBridge Scheduler rules delivering each cron slot. Inside the container,
`FASTAGENT_AGENTCORE=1` makes `start` mount the adapter (`channels/agentcore.ts`): `POST /invocations`
unwraps the envelope — a webhook is reconstructed verbatim and dispatched to the SAME channel routes
(signature verification unchanged; the channel's real HTTP response rides back inside a transport-200
reply so the forwarder re-emits it byte-exact), a schedule fire goes through `fireScheduleOnce` with the
slot as the idempotency key (EventBridge delivery is at-least-once), and an invoke streams back as SSE.
`GET /ping` reports `HealthyBusy` while background turns run (the shared turn-queue/task-tracker report
into `channels/busy.ts`) so an idle reclaim cannot kill a post-ACK turn. All ingress traffic shares ONE
fixed runtime session — channel state is single-writer by design, and a stopped session's id stays valid
until the runtime is deleted.

**State durability is an S3 snapshot, not the mount.** The platform's SessionStorage (`/mnt/state`) is
reset on every runtime VERSION UPDATE — i.e. on every deploy — and after 14 idle days, so it is a local
disk, not the source of truth (a real deployment proved this: the truncation point in a live chat matched
the deploy timestamp exactly). `channels/agentcore-state.ts` restores the state root from one gzipped
JSON object on the first ingress envelope and pushes a coalesced snapshot on the 0-in-flight edge
(`busy.ts` `onIdle`). The container holds NO AWS credentials (verified on a live box), so the forwarder
mints SigV4-presigned GET/PUT URLs and rides them on every envelope — keeping the container AWS-SDK-free
and credential-free. Failure policy is fail-visible: a snapshot that exists but cannot be restored 503s
the request (serving an empty agent would then overwrite the good copy with that emptiness), while a 404
is first boot. `auth.json` restores absent-only — the deploy seeds a fresher copy than the snapshot's.
Only the INGRESS session is snapshotted: a direct-invoke session runs in its own storage, which the
platform wipes on a version update, so cross-deploy memory is a property of the ingress path and the
docs say so. `--run` sends a `checkpoint` envelope before `stop-runtime-session` — the stop cuts an
in-flight turn whose durable intent (written pre-ACK by every replaying channel) would otherwise sit
only on the mount the version update erases, which is what makes replay real rather than aspirational.
It protects a LIVE session; one already idle-reclaimed has nothing to lose, because its snapshot was
written when work settled, before the reclaim. The reply reports whether a snapshot was actually
written and `--run` prints that verbatim — a blanket "checkpointed" would be the only signal an
operator has about an interrupted turn, saying the same thing whether or not anything happened.
The bucket is created OUTSIDE the stack (like the ECR repo) so `delete-stack` cannot take the agent's
memory with it; a durable MOUNT instead (EFS/S3 Files) requires VPC mode and therefore a NAT gateway for
model/channel egress, which would replace pay-per-use with a fixed ~$33/mo floor. The same bucket hosts
the forwarder's deployment package, whose key is content-hashed (the presigning pushed it past
CloudFormation's 4096-byte inline cap; a hashed key is also what makes CloudFormation notice new code).

A live session keeps its
old compute (and the OLD image) until reclaimed — so `--run` stops the ingress session after a
successful deploy, making the new image serve immediately (an in-flight turn is cut; channels with
replay re-run it). Self-scheduled wake-ups are EventBridge-backed: every wakeups-store mutation
notifies a sink (`schedule/wake-alarm.ts`) that POSTs the pending set to the forwarder's reserved
path (shared secret), and the forwarder mirrors each into a self-deleting one-shot EventBridge
schedule that pokes it at the instant — waking the container, whose ordinary wake pump fires the due
entry (a recurring wake re-arms itself through the same store-save → sink loop). The forwarder
injects its own URL into every envelope, so nothing is circularly baked into the template. Structural
limits, gated/warned/noted at deploy time: long-connection channels cannot run (the connection IS the
ingress; nothing wakes a reclaimed session), and a wake set inside a direct-invoke session (its own
per-session storage, not the ingress session's) has no alarm — it fires only while that session is
awake.

## 10. Current boundaries

The following are explicit limits, not implied capabilities:

- pi is the reference implementation; additional engine bindings can implement the same Agent contract;
- `ExecutionEnv` alone is not a complete sandbox for directory agents;
- GitHub post-ACK work has no replay; Telegram, Slack, and Feishu/Lark replay is at-least-once;
- file-backed state is single-process;
- the AgentCore target has no resident process: long-connection channels are unsupported there, and
  a wake-up set in a direct-invoke session (outside the ingress surface) fires only while that
  session's compute is awake;

- observability is logs/traces, without an OpenTelemetry exporter.

Keep new implementations behind the existing contract rather than adding speculative concepts to it.
