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

## 2. Agent shape, contexts and prompt assembly

One agent shape, one marker:

```txt
<agent dir>/                # any name — the config below is what makes it an agent
├── SYSTEM.md               # optional: replaces pi's default system prompt
├── APPEND_SYSTEM.md        # optional: standing instructions added to it
├── AGENTS.md               # optional: for whoever changes the agent — not loaded into a turn
├── skills/  prompts/  tools/  channels/  routines/
├── fastagent.config.ts     # THE marker, and the agent's declared contexts
├── models.json             # optional custom model endpoints (pi's schema, definition-local so it
│                           # travels into the image). The machine's ~/.fastagent/models.json layers
│                           # under it as environment and does not travel
├── models-store.json       # optional model catalog (`models --refresh`): models newer than the installed
│                           # pi, travels like models.json; the machine's ~/.fastagent/ one layers under it
├── .gitignore              # scaffolded once by init, yours after
├── .secrets/               # the local instance's .env + auth.json; only .env.example + .gitignore travel
└── .state/                 # the local instance's mutable state: sessions, channel state, schedule state, clones
```

**The agent directory is the agent's working directory**, its coding tools' root, the key its session records
are kept under, pi's project scope, and deploy's build context. What it works on is not derived from where it sits:
it is declared as **contexts** ([agent model](agent-model.md) §3):

```ts
contexts: [{ github: "acme/app", local: "/Users/me/code/app" }, { local: "../handbook", readonly: true }],
```

`src/contexts/` owns them, engine-neutral. `declare.ts` reads the declaration and refuses in one place: unknown
keys, a name that is not one path segment or collides ignoring case, and a location that contains the agent
directory or sits inside it. `resolve.ts` answers where each one is for this instance (`ResolvedContext`:
name, kind, readonly, location, notices, and for a `github` one its repo, ref and whether it is a clone), once per
process start; the content at those locations is re-read per turn. It reads the disk and git, never the network,
and writes nothing. The prompt's `contexts` section, `ctx.contexts`, `info`, `fastagent context list` and the opener
all read that one resolution.

A `github` context whose `local` is the root of a checkout of that repository is that checkout, used as it is: never
fetched, never moved to its `ref`, only said to be off it. Any other `github` context is a clone in
`<state root>/contexts/<name>`, which `cloneContext` makes or brings up to date each time a process that runs the
agent opens it (the opener, before it resolves). The first clone is shallow, at `ref`, built beside and renamed into
place (another process's clone that got there first stands). After that the clone is only ever updated IN PLACE, by
git's own rules (`git.ts`): `fetch`, then `merge --ff-only` on the branch it is on, or `checkout --detach` for a tag
or commit. git refuses whatever would overwrite the agent's work, and that refusal, a failed fetch, a clone on
another branch than declared, or commits no branch or tag holds keep it as it is, with the reason as a startup
warning. No directory is ever replaced or deleted, so a running agent's writes, branches and stashes are never at
stake. A clone of another repository under the context's name stops the start, named. `info`, `context list` and `fastagent tool` resolve without
cloning. `source.ts` reads a command's `<source>` (`github:owner/repo`, a GitHub checkout's root, any other
directory); `config-text.ts` rewrites the literal list `init --context` and `fastagent context add/remove` edit;
`writeContexts` imports a candidate file beside the config and replaces the config only when the import declares
exactly the intended list. On a host (`place: "host"`) a `github` context is always a clone, its author's `local`
not looked for. A `local` context is a directory of the author's machine, so a host does not have it
(`contextsAbsentHere`): it is left out of the resolution, the agent is not told of it, and the opener says so at start;
the deploy preflight says so too, a warning for one the agent works on (agent model §3).
Every clone of fastagent's names a credential helper in its config that answers with `GITHUB_TOKEN` when git has
no credential of its own, so the token reaches git, and the agent's push, without being stored.

A command names its agent by path (`[agent]`, default `.`): a directory holding `fastagent.config.ts` is the agent;
inside one, the command refuses naming its root; anything else refuses with `fastagent init`. Nothing is searched
for, and no environment variable selects an agent.

- **The marker is the config, and it is a declaration rather than configuration.** Nothing in an agent directory is
  logically required to serve a turn, so the marker has to be the one artifact present in every agent and absent
  from every non-agent. `SYSTEM.md`, `skills/`, `tools/`, `channels/` and `routines/` are each optional and generic
  enough that scanning for them would read half the world's repositories as agents. `export default {}` is a
  signature — the same job `package.json`, `Cargo.toml` and `pyproject.toml` do.
- **A context and the agent directory are kept apart.** A harness is released to every instance; a writable
  context must keep what an instance wrote. One directory cannot be both, so nesting is refused at load, on the
  declared paths and again on the real ones.

`init <dir>` creates the agent in `dir` itself, which must be new or empty and not inside another agent, and
declares each `--context` (checked before anything is written) through the same `writeContexts`.

The two machinery dirs map onto deploy lifecycles: `.secrets/` values travel through the host's secret
store, `.state/` through a volume (`FASTAGENT_SECRETS_DIR`/`FASTAGENT_STATE_DIR` point both at it in a
container).

**`init` makes the agent a git repository; after that, git is the author's, with one exception.** An agent
changes itself, and version control is how its author goes back to a version that worked, so `init` runs `git init`
and commits the scaffold, after `npm install` so the lockfile is in it. It does not when the directory is already
inside a repository (that one tracks the agent, and a second would hide the agent's files from it) or git is
missing, and a failed first commit (no identity configured) keeps the repository; each case is printed. Nothing
commits for the agent afterwards: when to commit is the author's (agent model §8). `init` also scaffolds two ignore
files: the agent's own, which keeps the instance (`.state`, `.secrets`, `.contexts`) out, and `.secrets/.gitignore`
(`*` minus the template). No command reads, verifies or rewrites an ignore file. The exception: **the directory fastagent writes secrets into carries its own
`.gitignore`**, so `add <channel>`, which mints an unrecoverable app secret, writes that file (`wx`,
never over an existing one) when the *default* `<agentDir>/.secrets` has none. The risk is not
symmetric — restoring a deliberately deleted ignore file is an annoyance, the other way is a published
credential. A secrets dir named by `FASTAGENT_SECRETS_DIR` belongs to the operator: dropping the
template there would hide that directory's other contents from `git add`, so `add <channel>` states
the fact instead.

pi builds the prompt; FastAgent hands it the pieces and adds its own sections:

| Section | Source |
|---|---|
| preamble, tools, rules, docs | pi's default, built by pi so it follows pi; L2's `base` (else `SYSTEM.md`, else `.pi/SYSTEM.md`) replaces all four; a blank file or `base` is no prompt (pi would build its default), so it is reported or refused. Never the machine's `~/.pi/agent/SYSTEM.md` (`systemPromptOverride` ignores pi's `base`) |
| addendum | `APPEND_SYSTEM.md`, else `.pi/APPEND_SYSTEM.md`; never the machine's |
| project context | each context's root `AGENTS.md`, in declaration order, handed to pi through `agentsFilesOverride`; the agent directory's own is never loaded |
| skills | pi lists the agent's skills — the definition's (`skills/`, `.pi/skills/`, `.agents/skills/`), each context's (`.pi/skills/`, `.agents/skills/`, named `<context>/<skill>`) and the machine's (§5) — when `read` is active |
| cwd | pi appends it, without a date line that would invalidate the prefix cache daily |
| FastAgent's sections | `contexts` (the agent's own directory, then what it works on and knows, each with its location), `deferred_tools` and, on a deployed host, `self_change`, added on `before_agent_start` as named sections, so they hold under a `SYSTEM.md` |

pi lists a tool only when it has a `promptSnippet`. The coding tools FastAgent mounts are pi's `AgentTool`s, which
carry none, so FastAgent copies pi's own snippets and guidelines onto them; an authored tool's snippet is the
first line of its description. pi's default says the agent reads files, runs commands and edits code, so an L2
`tools` list without the coding tools needs `base` or a `SYSTEM.md`, checked at assembly and every turn.

`SYSTEM.md` is an identity of the agent's own; `APPEND_SYSTEM.md` is standing instructions; a context's `AGENTS.md`
is project context. A `persona.md` is refused, naming both files. The definition is re-read for every invocation, so prompt,
context and skill edits take effect on the next turn; code modules are reloaded by
the dev supervisor instead, and by a restart under `start`. That is also how an agent improves itself while it
runs: a new capability is a skill whose script it runs through `bash` — read fresh every turn, executed in a new
process every call, its failure in the same turn's output — and its own follow-up work is the `wake` tool,
mounted on every serve. `tools/`, `routines/` and `channels/` are the author's code: they change with a restart or a
release. (Reloading them in-process was built and removed — the design is #582, why it went is #600.) A skill the
agent writes lives in the definition, so it lasts until the next deployment replaces it; the deployed prompt says so
and sends anything lasting to the author's release. The low-level `createPiAgent({ instructions })` path takes the prompt body
without directory identity or project-context assembly; pi appends skills and cwd on both paths.

### Decisions behind the agent model

Kept from the implementation plan of [agent model](agent-model.md) and [agent CLI](agent-cli.md) (#684), which was
deleted when its stages landed:

| Question | Chosen | Not chosen, and why |
|---|---|---|
| When contexts are resolved | Once per process start; content re-read per turn | Per turn: network and git on every turn, for declarations that only change with a restart anyway |
| Whether a local directory reaches a host | No: a context reaches a host only by a type whose home the host reaches (a repository today); the agent directory reaches it as the harness, replaced by each release | A copy baked into the image (`copy: true`, removed before it was released): each instance's copy became data of its own, which nothing brought back together; it tied the data to the release cadence and image size, put local data in the image registry, and needed a staged build directory and a different build context on every host |
| How FastAgent's sections enter the prompt | Named sections on `before_agent_start` | `APPEND_SYSTEM.md`'s slot: the author's file and ours would share one addendum, and `SYSTEM.md` users would need ours re-added by hand |
| How `fastagent context` edits a TypeScript file | Rewrite the literal block, re-import, compare | A TypeScript parser: `typescript` is a dev dependency only, and the round-trip check gives the same safety for the one shape `init` writes |
| Where an agent's work goes, apart from its definition | A context it works on, as the prompt directs; the working directory stays the agent's own directory | A context declared `workdir` (#716; built in #719, closed). It differs from a writable context in where commands start (measured: 180 runs on three models, no difference with `cd <location> && …`) and where a file created without a path lands (directed by the prompt). It would separate pi's one cwd from the agent directory in every reader. Reopen with a measurement of results landing in the definition |
| Whether a process restarts onto a changed definition by itself | No: code modules and configuration take effect at the author's restart or the next release (agent model §6); `dev` restarts on an edit | A supervisor on every process that checks a changed definition, drains every way a turn starts and restarts: no observed need, a large cost across four hosts. Reopen with a case where an agent must put a code module it wrote into service before the next release |

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

`createPiAgentFromDir` sits above L2 and resolves the agent directory, config, contexts, model, auth, tools,
sessions, and machinery paths. `dev`, `start`, `invoke`, and `routine run` share it rather than carrying parallel
implementations.

Each invocation binds a fresh `AgentSession` to its record and disposes it after the turn.
Continuity comes from `PiSessionRecordStore`, not a resident session. That is L0's choice on the axis a
deployment owns: per-invoke state (SPEC MUST 6, what AgentCore and every scaled channel host require),
swappable at this rung alone — [conformance-levels.md](conformance-levels.md) states what each posture
owes.

Reopening restores Pi's tool declarations from the active transcript using `getCurrentSystemMessage` and
`setActiveToolsByName`. The SDK supplies an initial loadout even on resume, bypassing `AgentSession`'s own
constructor restore; the shared binder performs this one public-API replay for serving and chat. There is no
separate activation journal. The loadout is the definition's current defaults plus the transcript's declarations
that are still mounted. Transcript removals are not honored: fastagent's own activation only adds, so a removal
records a turn on which the definition did not mount the tool, not the conversation's choice. Discoveries survive rebind, resume, fork, and compaction on that branch.

Every binding also owns a fresh `ModelRuntime`. Credentials are shared through their store, but extension
provider registrations and virtual router contexts are session-local. An unbound extension-aware catalog supplies
startup model resolution, model listings, authentication reporting, and control-plane validation. Virtual selections
remain selected in `model_change`; assistant entries record the physical model that answered. Context usage uses
that physical model's limits. Extension factories run for catalog registration too, so work requiring a session
belongs in lifecycle handlers, not the factory.

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
release. Admission is pi's own: an internal extension observes `session_before_compact`, which pi
emits once `prepareCompaction` found work and before the model call. It is the event's first
listener, so a definition's own handler (a custom summarizer, a cancel) runs after admission.
fastagent does not predict pi's private cut-point rules. Assembly services are explicitly injected and shared; sessions and subscriptions stay
per-operation. These scopes do not own channel turns, durable replay policy, or service shutdown.

pi retries a failed assistant request itself. That is free resilience while the turn is silent and
corruption once it is not — SPEC deltas are append-only, so a second attempt would concatenate its
answer onto the first one's half-sentence. L0 refuses the retry exactly there: once answer text has
been streamed, never on tool events (refusing on those would push the retry out to the caller, who can
only re-run the whole prompt and execute the tool a second time).

## 5. Tools, skills, and execution environment

**An agent inherits the machine it runs on**, the way it already inherits the `PATH`. Skills and
prompt templates come from the definition's own `skills/` and from the box — pi's Agent Skills
discovery, installed pi packages included (fastagent never installs one) — and pi's engine settings
come from the box too. A name in the definition wins a collision; `fastagent add skill` vendors one in.
The machine is read once per process, like any environment; the definition stays live.

Deploying ships pi's project scope, which is the agent directory. What the machine lends is not compared against a
deployment, for the same reason nobody is told their local `ffmpeg` is not in the image: an image is a
machine too, and whatever its builder put in it is that environment's answer
(`src/engines/pi/machine.ts`).

The machine's extensions stay out of this: they are its owner's setup, and a served agent runs the
definition's own `extensions/` (`docs/configuration.md#extensions`). So does the system prompt — inheriting
capability is one thing, inheriting an identity would be the agent becoming someone else's.

A directory agent's tools merge in this order: all pi coding tools
(`read`/`grep`/`find`/`ls`/`bash`/`edit`/`write`), then `config.tools`, then discovered
`tools/*.ts|js|mjs`. Earlier names win, collisions are reported, and a broken discovered tool
refuses the run — an enabled file is a declaration, and the same rule covers `channels/` and `routines/`. The coding set is fixed for directory agents: isolation belongs around the whole
agent process, where it also covers authored tools and channel code. Pi's codemode and tool-search
extensions load by default (`BUILTIN_EXTENSIONS`, machine.ts); Pi's MCP extension is not loaded, because its server
connections live as long as a session and a served session lives one turn; self-scheduling `wake` remains serving-only. Reusable
integrations export ordinary `FastagentTool[]` for explicit `config.tools` mounting.

Every `defineTool` execution receives the same runtime context. Serving adapts the session it binds for
the turn, chat adapts its resident one, both through the same adapter onto the FastAgent-owned
read-only port (`getSessionId`, `getHeader`, `getBranch`) — `getSessionId` answers the *caller's* id,
not pi's encoded record name, and `contexts` is the agent's resolved contexts. Sessionless direct execution
provides cwd and contexts but no manager. Native pi tools receive the same cwd (the agent directory) and caller
session id; their `thinkingLevel` getter reads the bound
`AgentSession`.

**Tool exposure and discovery** use Pi's native `direct`, `model-only`, `codemode`, `deferred`, and `hidden`
exposures. Codemode defaults to mode `on`; `codemode` and `tool_search` are registered inactive until settings
or a mounted tool with that exposure selects them (`bindPiSession`, the same rule Pi's MCP extension applies). A rebound
session runs on the current defaults plus its transcript's still-mounted declarations; a tool
whose exposure was narrowed stays declared in conversations that already declared it, since the transcript does not
record why a tool was declared. Built-ins the machine's settings disable (`"extensions": ["-builtin:codemode"]`) are not
loaded. No fastagent loader or keyword policy is layered over Pi. `ToolContext.tools` remains a small
adapter for authored loaders: Pi filters the requested names and records the resulting declarations.

`defineTool({ output: z.object(...) })` gives scripts validated `structuredContent`; tools without an output
schema retain text results. Full Pi results pass through unchanged. Nested calls use Pi's `ctx.executeTool`, so
validation, permission hooks, cancellation, and errors share the native tool pipeline. Authored tools get the same
function as `ToolContext.executeTool`, taken from the per-call context because Pi binds it to the calling tool call
(the parent of what it runs), and `ToolContext.onUpdate` over Pi's update callback. `annotations` and `namespace`
pass through to Pi unchanged. The observation plane
retains `parentToolCallId` on nested events. The Agent Handler/channel projection emits only outer calls, whose
Pi display details include bounded nested traces, and reports each nested call starting as its outer call's
`tool_progress` status; machine-readable `structuredContent` stays internal.

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

A tool call left without a result (an interrupted process, a move onto an assistant whose result
is off-path, an inherited mid-turn room) is not repaired in the record. pi-ai pairs it at request
time with a synthetic error result (`transformMessages`), after dropping `error`/`aborted`
assistants, so the provider always receives a valid transcript. A durable repair written here
would duplicate that rule and drift from it: a result for a call pi-ai later drops reaches the
provider unpaired, and every later turn is rejected. Replay does not make side-effecting tools
exactly-once.

The core lease allows one in-flight turn per session. A collision yields
`{ type: "failed", code: "session_busy", retryable: true, details: "…" }`. Queueing is channel policy:
Telegram, Slack, and Feishu/Lark serialize their own turns per session; HTTP uses the
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
route collision as fatal: a declared inbound endpoint must not silently disappear.

`mountAgentService` adds `POST /invoke` and `GET /health`, starts long connections and schedules, and
owns their shutdown. `/invoke` is the framework's data plane, so it is served whatever else is
declared, and a channel claiming that path is refused; `/health` stays overridable, because a probe is
the deployment's to shape. AgentCore is the one posture that opts out of `/invoke`: it serves the
Runtime's own `/invocations` contract instead. Health returns
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

A record's `answer` separates the two events the intent used to conflate. It is written where the reply
text is known and about to be sent (the renderer's `onAnswered`, before the terminal write), and the
intent is dropped only once that write settles. So a record recovered on the next start is one of two
things: without `answer`, a turn to run; with it, an answer to deliver — no model, no tools, and no
preview of its own to resume (a queue notice THIS process put up is still taken over, as any turn
would). A caught delivery failure keeps the record for the same reason. The
policy where the platform cannot prove whether a send landed is **a duplicate over a loss**.
`MAX_TURN_ATTEMPTS` bounds it, but it is a ceiling on EXECUTION: the attempt that hits it sends a
recorded answer one last time instead of running the turn, since a send costs no model call and cannot
be what was crashing the process. A turn with nothing to deliver — or whose last send also failed, since nothing will retry it — is dropped with a notice instead.

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

## 8. Routines and self-scheduling

A **routine** is `routines/<name>.ts` exporting `{ prompt, cron?, tz? }` — the only named unit of work,
and `cron` is a FIELD of it rather than the concept: with one, the clock fires it; without one, its name
is the only way in (`POST /run`, `fastagent routine run`). Either way it runs in the stable session
`routine:<name>`. The clock claims a slot before invoking, catches up one overdue occurrence after
downtime (not every missed slot, and not at all before its first fire — nothing recorded that it was
armed then), writes the outcome back into that claim, and leaves delivery to agent tools. A routine with no cron is not armed and not warned about.

**The claim is the whole record.** A fire's history is `<stateRoot>/schedule/claims/<name>/<slot>`,
one JSON object — `{"firedAt"}` at claim time, gaining `outcome` and `ms` when the turn reports — pruned
to the newest 512, which is what makes `fastagent routine history` bounded by construction rather than
by a retention policy. JSON rather than a line this module splits itself, because `settleClaim` may not
write atomically (see below): half an object does not parse, so a torn claim reads as unsettled instead
of as a record whose third field happened to look like a number. Two events have no claim and therefore no stored record at all: a wake-up (removed from the store
before its turn starts) and a stale slot (refused before a claim is taken; it is a WARN line where a
duplicate delivery is INFO).

**What the turn SAID is stored once, and not here.** Every fire runs in a session — `routine:<name>` for
a cron, the asking conversation for a wake-up — and a session is persisted under `<stateRoot>/sessions/`
like any other, with the engine's own storage and compaction semantics. The claim therefore carries the
outcome and nothing else, and the log carries the fact that the fire completed, plus the failure detail
when it did not. #546 was about model output accumulating where nothing prunes it; a second copy in the
claim file and a third in a log stream are both that same accumulation, so neither exists. A log line is
also the wrong shape for it: it has no escaping (a reply containing a newline would emit a second line
byte-for-byte identical to a real record — `oneLine` folds the failure detail for exactly this reason),
its audience is every reader of the deployment's log stream rather than of the agent's volume, and its
retention is set per host, so it would answer "why did last night's run fail" for a different length of
time than the claim answers "did it".

Logs still need a bound for ordinary reasons, and the hosts differ: Fly and Railway retain a window of
their own, `deploy docker` writes one into the compose file (`logging: json-file` with `max-size`, since
Docker's default never rotates), and AgentCore has no default at all — CloudWatch keeps log data
indefinitely, so its runbook and its `--run` summary both print the `put-retention-policy` call.

The resident scheduler owns one Effect loop per cron and one sequential wake loop. Their waits use the
captured Effect clock; Croner computes calendar instants, with capped waits rechecking wall time. Cron
claim IO failures are typed: the resident loop logs a skipped fire, while external slot delivery
receives the original error.

`stop()` interrupts pending waits synchronously without draining or canceling a claimed occurrence.
That occurrence finishes execution and settlement before its loop exits; no next wake is claimed. The
process itself is not waited for, so a restart can still land between a cron claim and its settlement:
the next `start()` reads the claims it is about to arm and settles an unsettled one as `interrupted`,
with a warning — which also makes the check idempotent across boots. It is not re-fired — a turn that
kills its own process would then replay on every boot — and external slot delivery skips the check, so
on AgentCore an interrupted fire stays `unreported` forever (there is no boot of a resident scheduler
to reconcile it, and that host reclaims its container most often). A
killed wake-up leaves nothing to reconcile: its claim removes it from the store before the turn starts.
Waiting loops do not count as business work. Wake execution keeps its busy ownership through one-shot
deferral and settlement, so the idle notification observes settled state.

Every serve mounts `wake`/`unwake`. Wake-ups are persisted, bounded by
minimum delay/frequency and per-session count, and fired back into the originating session. A one-shot
wake that hits `session_busy` is deferred because the turn never started; other failures are not
replayed because tools may already have produced side effects.

A declared cron needs one continuously running process, and deploy preflight prevents scale-to-zero settings
that would silently miss one. Wake-ups do not pin a machine: the store is on the volume, so a box that slept fires
what is due when a request next wakes it.

## 9. State and deployment

`FASTAGENT_STATE_DIR` selects the one machine-state root:

```txt
<stateRoot>/                # <agent dir>/.state (FASTAGENT_STATE_DIR overrides)
├── sessions/
├── channels/telegram/  channels/slack/  channels/feishu/   # …/files/ holds inbound attachments
└── schedule/
```

Two kinds of thing live here, and only one of them is FastAgent's to bound. **Bookkeeping** — fired-slot
claims, delivery dedup rings, turn intent — is written by this project for its own machinery, so it is
bounded by construction (claims are pruned by count, §8; the seen ring is capped). **Conversation data**
— `sessions/` and a channel's `files/` — is what the agent was told and sent, and nothing here deletes
it: an inbound attachment is part of the conversation exactly as the session entry naming it is, and its
path stays readable for as long as that conversation can refer back to it. Both grow with use, which is
an operator's capacity decision (size the volume, prune deliberately), not a retention policy this
project may impose on someone's data.

Credentials live separately under `<agent dir>/.secrets/` (`FASTAGENT_SECRETS_DIR` overrides) because
the deploy lifecycle differs: values ride the host's secret store, a model login is made on the box
itself, and state rides the volume. A deployed box points both knobs at its volume so its login, and
every OAuth refresh of it, persists.

The shipped file-backed implementations are single-process, and the cost of ignoring that is specific
rather than general — measured, not assumed:

- **Two writers do not corrupt a session.** pi appends one whole transaction per line, so the file
  stays parseable; the conversation *branches* (both writers' entries share a parent) and one branch
  falls off the path the next turn reads. Within one process this cannot happen — the session lease
  answers a concurrent turn with `session_busy` — so it is that rule not reaching across processes.
- **Channel state is keyed by channel kind**, so two processes serving different channels never touch
  the same files. Two processes serving the SAME channel means one ingress credential in two places,
  which no local guard can see: the same bot token in two different directories does it too.
- **The clock is the one true singleton.** Two schedulers over one state root would fire a cron slot
  twice — a real billed turn. That decision is therefore atomic: `claimSlot` creates the slot's claim
  file with `O_EXCL`, and creating it IS the decision (`src/schedule/state.ts`). A slot is also refused
  when a LATER one has already been claimed: claims are pruned by count, and a platform that retries an
  event for up to 24h (EventBridge) would otherwise get a stale slot fired once its own claim aged out.
  The claim is the ONLY state this path writes, and it carries the wall-clock instant it was taken, so
  one file answers both planes — was that fire ever reported (the boot-time `interrupted` check), and
  where does catch-up resume — and the turn's outcome is written back into that same file. A second file
  would reintroduce a window in which a killed process leaves a claimed slot nothing accounts for. A
  claim outliving its process is correct: the slot was taken, and a fire interrupted mid-turn is settled
  `interrupted` by the next start. That check has one known false positive — a second scheduler booting
  while the first is mid-turn settles a claim nothing accounts for YET, which the first process then
  overwrites when its turn ends; telling them apart would need the claimer's liveness, which is a lease
  rather than a claim. The settlement is a plain write, not the atomic rename `writeFileAtomic` does:
  its temp file would land in the directory the claim gate lists, where a leftover would sort after
  every real claim. A torn write reads back as an unsettled claim, which is visible, not lost.
- **Recovered turns can run twice** if two resident processes share a directory, which is the
  already-stated at-least-once floor (a duplicate over a loss); claiming each turn on disk would make
  a killed process block its own replay, which is worse than the duplicate.

Multiple instances still require shared session, lease, credential, and channel-state backends. What
is deliberately absent is a directory-level writer lock: it would forbid harmless topologies (two
channels in two processes, a one-shot `invoke` beside a serving `dev`, an embedder mounting twice)
without preventing the dangerous one above.

`fastagent deploy docker|fly|railway|agentcore` generates a Dockerfile, target config,
persistent-volume wiring, required secret names, and a runbook. Docker adds a user-owned
`fastagent.compose.yml`; `--tunnel` can add a separate ephemeral cloudflared service, while durable
ingress stays operator-owned. `--run` alone causes host side effects; for a tunnel topology it also
reads the Quick Tunnel URL and registers webhooks.

The build context is the agent directory, baked at `/app/definition`; the artifacts and the ignore file sit at its
root, and preflight checks that a kept ignore file ships `fastagent.config.ts` and excludes credentials. Preflight
says what each context becomes on the host: a `github` one is cloned there (afresh on every deployment on AgentCore,
whose storage starts over); a `local` one stays on this machine, and preflight says how to ship what the agent only
reads (the agent directory) or work on it from a host (a repository). Git history ships when the host
packer permits it, and the image installs Git when the agent directory contains `.git` or a context is `github`.

`deploy/workspace.ts` owns the shared deployed lifecycle. Storage contains `definition/` (the cwd), `.state/`,
`.secrets/` and `.deployment/`; the release manifest names the agent the storage belongs to. A process-lifetime
lease precedes initialization; staged trees and a pending journal make definition replacement recoverable. The same
release keeps what the agent wrote in `definition/`; a new one replaces it whole, while `.state/` and `.secrets/`
stay. Storage laid out by an earlier FastAgent (`base/`) is refused rather than left behind unread. Nothing is
mounted or unmounted by fastagent: the host's volume is the only storage.

No credentials file travels. A model whose key is not in the value file logs in on the box: `fastagent
login --deployment` runs `login --stdio` inside the running image through the host's own
owner-authenticated shell (`HostDeploy.shell`, a byte channel in `deploy/box-shell.ts`: `docker compose
exec`, `fly ssh console`, `railway ssh`, or AgentCore's `InvokeAgentRuntimeCommandShell` WebSocket in
`deploy/agentcore/shell.ts`), in the server's directory with the server's credential path
(`boxLoginCommand` in `deploy/container.ts`). The wire is `LoginIO` as JSON lines (`cli/login-relay.ts`): the box sends what
the flow asks and says, the terminal renders it and answers by id, and one `result` line ends it. The
box holds the PKCE verifier and exchanges the code, so it is the only holder of its grant and nothing
can log the builder's machine out. The browser's return to the flow's `localhost` redirect is caught on
the builder's machine (`catchingRedirect` in `cli/box-login.ts`) and answered as the paste. Success is read only from that line, because a host shell can drop
a session and still exit 0. `deploy --run` starts the same login once the box is up, keeping a
credential the box already authenticates with (`--if-missing`, answered by `AgentModels.authStatus`, the same
resolution the box's startup report prints); without a terminal it exits 1 naming the command. The
builder never predicts that answer from its own credentials: `credentialRoute` decides only what the
deploy ships.

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
reply so the forwarder re-emits it byte-exact), a routine fire goes through `fireRoutineOnce` with
the slot as the idempotency key (EventBridge delivery is at-least-once), and an invoke streams back as
SSE. `GET /ping` reports `HealthyBusy` while any work runs (`channels/busy.ts`: every leased session, a turn,
compaction or control write however it started, and channel work not yet at one) so an idle reclaim cannot kill a
post-ACK turn, and always carries `time_of_last_update`: the field is documented
as optional, but measured platform behavior reads only it — without it the idle timer counts from the
last `InvokeAgentRuntime` and reclaims mid-turn regardless of `HealthyBusy`. All ingress traffic shares
one fixed runtime session, since channel state is single-writer by design.

The two process boundaries stay two explicit log sources: Runtime application stdout/stderr and the
forwarder Lambda's ingress log. `fastagent logs agentcore` derives the stack from the agent directory's name,
discovers the Runtime endpoint log group from its `RuntimeArn`, and tails it; `--source forwarder`
selects the Lambda group. It applies no stream filter: AgentCore names streams
`YYYY/MM/DD/[runtime-logs]<session>`, so the marker is an infix after the UTC date path and a
`--log-stream-name-prefix` match is always empty.

`fastagent destroy agentcore` is the other direction, and it exists because three of the four things a deploy
creates cannot be stack resources: the artifact bucket and the ECR repository have to exist BEFORE the stack
that reads from them, and both log groups are created by AWS on first write. The fourth, a wake alarm, is
minted at runtime by the container. The wait on `stack-delete-complete` decides whether the rest may run: a
DELETE_FAILED stack still holds a billing runtime, and the image and forwarder zip below it are what a retry
needs. Webhook registrations are out of scope — they live on the platforms, not in the account.

**AgentCore uses managed SessionStorage at `/mnt/data`, and a deploy resets it.** The same `definition/`,
`.state/`, `.secrets/` layout applies on the platform's own mount: it survives compute stop/resume, so
an idle-reclaimed agent resumes with its memory, and AWS wipes it on every runtime version update — i.e.
every deploy — and after 14 idle days. That is this host's stated semantics, not a gap: AWS's only
cross-deploy filesystems are EFS and S3 Files, both VPC-only, and VPC mode costs a NAT gateway for
model/channel egress (~$33/mo standing). Buying cross-deploy state with an S3 snapshot instead was
tried and removed: it cost a presign path in the forwarder, a refresh endpoint, a `checkpoint` envelope
and a save-on-idle edge — roughly 700 lines whose failure modes were invisible until a deploy. A host
without a volume promises no volume; Fly and Railway are where cross-deploy memory lives.

A model login on the runtime is wiped with the storage by the next deploy and by a 14-day idle reset, so
`deploy agentcore --run` logs the runtime in after every deploy (after the probe, before registration),
and says up front that an idle reset needs the same login again (nothing on this host notices it but
the runtime's own startup report). An unattended agent there takes an API key. The
shell opens on the fixed ingress session, which is the one that sees the server's `/mnt/data`; it does
not inherit the runtime's environment, so `boxLoginCommand` names the storage root outright. A provider
API key in the value file avoids the login.

Runtime filesystems appear on invocation, so `deferAgentcoreService` exposes `/ping` before any
persistent definition or credentials are opened. Initialization runs in two stages, split by what a
retry would cost. Taking the storage (`prepareStartWorkspace`) starts nothing and releases its lease
before failing, so a failed attempt is retried by the next envelope — an unmounted volume and a lease
the outgoing session still holds clear on their own, and caching them would make a healthy microVM
refuse every envelope until it is reclaimed. Assembling the service (`openPreparedWorkspace`) mounts
channels and starts the scheduler, so both its outcomes are cached; a second attempt would run two
schedulers over one claim state. Concurrent envelopes share one attempt at each stage, and mount or
initialization failures cannot start an empty agent.

The process retains its deployment lease until exit, including failed activation and shutdown, since
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
- Telegram, Slack, and Feishu/Lark replay is at-least-once;
- file-backed state is single-process;
- the AgentCore target has no resident process: long-connection channels are unsupported there, and a
  wake-up set in a direct-invoke session fires only while that session's compute is awake;
- observability is logs/traces, without an OpenTelemetry exporter.

Keep new implementations behind the existing contract rather than adding speculative concepts to it.
