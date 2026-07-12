---
title: Core design
type: design-doc
status: current
updated: 2026-07-10
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

A flat workspace uses one root for both the run directory and the agent definition:

```txt
workspace/
├── persona.md              # optional identity
├── AGENTS.md               # optional project context
├── skills/
├── tools/
├── channels/
├── schedules/
├── fastagent.config.mjs
└── .fastagent/             # machine state, gitignored
```

When an existing repository already owns names such as `tools/` or has its own build/deploy files,
`config.agentDir` moves the agent surface into a subdirectory while the repository remains the working
directory:

```txt
repo/
├── AGENTS.md
├── fastagent.config.mjs    # { agentDir: "./agent" }
└── agent/
    ├── persona.md
    ├── skills/
    ├── tools/
    └── channels/
```

The pi reference prompt has four segments:

| Segment | Source |
|---|---|
| ① engine base + identity | `piBasePrompt`; `persona.md` replaces its default identity line |
| ② project context | `AGENTS.md` files loaded by pi from `agentDir` and the cwd ancestor walk |
| ③ skills listing | definition-local Agent Skills |
| ④ runtime context | current date and cwd |

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

`createPiAgentFromWorkspace` sits above L2. It loads config, resolves `agentDir`, model, auth, tools,
sessions, and state paths. `dev`, `start`, `invoke`, and `fire` share this assembly rather than carrying
parallel implementations.

Each invocation builds a fresh harness for its session and discards it after the turn. Conversation
continuity comes from `PiSessionStore`, not a resident harness.

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

Queueing is channel policy. Telegram serializes its own turns per session; HTTP and GitHub use the
core fail-fast behavior.

## 7. Channels and hosting

A channel is a synchronous factory:

```ts
(ctx: { agent, stateRoot }) => Routes
```

Enabled workspace channels are files ending in `.ts`, `.js`, or `.mjs` under `channels/`. Renaming a
file to `telegram.ts.disabled` disables it without adding a second config source.

The loader collects all per-file diagnostics, but `dev` / `start` treats any broken enabled channel or
route collision as fatal. A declared inbound endpoint must not silently disappear, and a broken channel
must never cause the default `/invoke` route to appear. The default HTTP/SSE route is mounted only when there are no
enabled channel files.

The serving CLI composition adds `GET /health`. The Node host routes exact method/path keys and bridges
Fetch requests/responses to `node:http` with streaming backpressure and disconnect cancellation.

### GitHub

The GitHub adapter verifies the HMAC over the capped raw body, maps a verified delivery through the
workspace's `on(event)` policy, acknowledges with 202, and runs turns in the process. It has no durable
post-ACK replay; an interrupted review is lost and logged.

### Telegram

Telegram is the stateful channel reference. Its modules separate:

| Module | Responsibility |
|---|---|
| `parse.ts` | pure update/message parsing and summon policy |
| `invoke-turn.ts` | attachment resolution and one Agent invocation |
| `turn-queue.ts` | per-session FIFO, different sessions concurrent |
| `turn-store.ts` | pre-ACK persisted turn intent and crash replay |
| `context-buffer.ts` | durable un-summoned group context |
| `preview.ts` | live preview and terminal write policy |
| `telegram-api.ts` | Bot API timeouts/retries and HTML-aware splitting |
| `state.ts` | atomic small JSON state files |

Telegram turn replay is at-least-once. A crash can re-run side-effecting tools, and a narrow pre-ACK
window can run a delivery twice. Exactly-once execution needs a different backend/resume model.

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
<stateRoot>/
├── auth.json
├── sessions/
├── channels/telegram/
└── schedule/
```

The shipped file-backed implementations are single-process. Multiple instances require shared session,
lease, credential, and channel-state backends; sharing one local state directory between processes is
unsupported.

`fastagent deploy fly|railway` generates a Dockerfile, host config, persistent-volume wiring, required
secret names, and a runbook. `--run` drives the host CLI for flat workspaces. The `agentDir`
repo-as-workspace deployment recipe is experimental and its `--run` path remains gated pending real-host
verification.

## 10. Current boundaries

The following are explicit limits, not implied capabilities:

- pi is the reference implementation; additional engine bindings can implement the same Agent contract;
- `ExecutionEnv` alone is not a complete sandbox for directory agents;
- GitHub post-ACK work has no replay; Telegram replay is at-least-once;
- file-backed state is single-process;
- the repo-as-workspace deploy path is experimental;
- observability is logs/traces, without an OpenTelemetry exporter.

Keep new implementations behind the existing contract rather than adding speculative concepts to it.
