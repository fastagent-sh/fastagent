---
title: Architecture
description: "What FastAgent is for, and the shape that follows: one harness (pi-durable), one consumer API (SPEC v1), a definition that compiles to it, an npm package as the artifact, context packages, and hosts that keep the state off the box."
type: design-doc
status: decided
---

# Architecture

**Status: decided, not implemented.** This note replaces the harness-neutral design of
[agent-service.md](agent-service.md) §7 to §9 and [conformance-levels.md](conformance-levels.md). The code still serves
that design until the move lands ([#788](https://github.com/fastagent-sh/fastagent/issues/788)); §6 is the order.

## 1. What FastAgent is for

1. **Build a product-grade agent the same way every time**: an agent is a model, a harness and a context, composed by
   a definition.
2. **Package it as an artifact** that can be published and deployed.
3. **Plug in models and contexts**: any model provider, chosen by configuration; and contexts defined once,
   distributed on their own, and mounted onto any agent, alone or composed.
4. **Deploy it to clouds as a service**, on serverless and microVM hosts, using what each cloud offers.
5. **Later, share and compose contexts** between served agents, so agents can work together.

What is hard in each, and the part of FastAgent that answers it:

| Goal | What is hard | Answered by |
|---|---|---|
| 1 | Turning one definition into a correctly assembled harness, and refusing what it cannot run | The definition and its assembly (§3) |
| 2 | What ships and what must not (secrets, state, cloned content), reproducibly | The artifact (§4.1) |
| 3 | Composition: precedence, conflicts, version resolution | Context packages (§4.2) |
| 4 | A box that may vanish, with state that must not | Hosts and their storage (§4.3) |
| 5 | Concurrent writers to one context; agents calling agents | Later (§4.4) |

None of these asks FastAgent to define how a harness queues, steers or records messages. The previous design did:
a harness-neutral protocol, a harness port, and `LoopPort`, which gave pi-coding-agent the queue, idempotency and
message records pi-durable has natively. Building pi-durable's port on that protocol then meant reconstructing facts
it does not keep. That work standardized the part harnesses differ on most and change fastest, for a neutrality no
goal needs.

## 2. Decisions

| Decision | Why |
|---|---|
| **One harness: pi-durable.** No harness port, no adapters, no capabilities | It keeps what serving needs natively (admission with `whenBusy`, idempotency by request id, a durable outcome per submission, continuation after a restart) and its storage and execution environment are replaceable, which is what serverless and microVM hosts need. A second harness would cost its own adapter, so neutrality is not designed for in advance |
| **One API of our own: the consumer API**, [SPEC v1](../SPEC.md), bound in TypeScript and over HTTP | Every consumer, ours included (channels, schedules, wake-ups, the REPL), needs the same eight operations. It is also the layer that keeps pi-durable's experimental API and internal entry kinds away from clients |
| **Everything else is pi-durable's own API**, as `agent.harness` in the process that runs the agent | Operating an agent (settings, compaction, inspecting sessions) has one implementation; wrapping it would only rename it. A developer who needs one of those over HTTP adds a route that calls it |
| **The agent is a public bot.** No identity or session ownership in FastAgent | Who may reach it is decided in front of it. A session id is unguessable and is the session's key ([SPEC](../SPEC.md) §8) |
| **The Agent names sessions; Callers remember them** | pi-durable mints conversation ids and cannot take a Caller's. A channel or a schedule keeps its own mapping (a chat to its session, a schedule to its session) in its own state, as it already keeps other state |
| **No session listing and no deletion** | No consumer needs them; pi-durable has no deletion |
| **The definition's harness-specific parts are pi-durable's**: `extensions/` holds pi-durable extensions (`defineExtension`), `tools/` holds pi-durable tools (`defineTool`, TypeBox) | With one harness, a portable layer over its extension and tool APIs would be a second API to learn for nothing |
| **Secrets are declared in `context.json`** | They were declared beside each tool (`defineTool`'s `secrets`); with pi-durable's `defineTool` they move to the one file that already declares what an agent needs from its environment, so `deploy` still checks them before it ships |

The previous design's pi-coding-agent harness goes with it: pi's `extensions/` and `.pi/`, the `chat` TUI (replaced by
a REPL over the consumer API), and the skills and prompt templates a machine lends from `~/.pi/agent`.

## 3. The definition and its assembly

```
my-agent/
  SYSTEM.md  AGENTS.md          who the agent is; how to work on it
  skills/                        Agent Skills
  tools/  extensions/            pi-durable tools and extensions
  channels/  schedules/          how it is reached, and what it does on a clock
  context.json                   its context: content, connectors, environment, secrets, and the context packages it uses
  fastagent.config.ts            its model and settings
  models.json  package.json
```

`openAgent(dir)` assembles it: pi-ai's model registry and credentials, a pi-durable `Harness` over the instance's
storage, the definition rendered into pi-durable's prompt sections, its tools and extensions installed, and the
execution environment its context declares. The result is the SPEC's `Agent`, plus `harness`. `dev`, `start` and an
embedder's process call the same function, so an agent behaves the same wherever it runs.

## 4. Around the agent

### 4.1 The artifact

The artifact is an **npm package**: the agent directory, its lockfile, an exact pi-durable version and a `start` entry.
It never holds secret values, runtime state or cloned content. A registry versions and distributes it; it can be a
dependency of an app that embeds it, or of another agent. What a host runs is derived from it by `deploy`: an OCI
image for AgentCore, Fly, Railway and Docker, a bundle where a host needs one.

Considered: an OCI image as the artifact (self-contained, but heavy, per architecture, and not importable), a single
bundled file (fast cold starts, but the definition is read at run time and would have to be embedded), and the
directory itself (what ships today, with no version and no dependency resolution). Each stays a derived format.

### 4.2 Context packages

A context is what an agent works with, apart from who it is: no `SYSTEM.md`, no identity. A context package is a
directory with a `context.json` of the same format an agent's own uses:

| Part | Holds |
|---|---|
| `content` | Repositories and directories the agent works on or knows: references (a GitHub repository at a ref), never the data |
| `connectors` | MCP servers, and the names of the secrets they need |
| `environment` | The commands and runtimes it needs |
| `uses` | The context packages it builds on |

plus `skills/` for working with that context. It is distributed as an npm package or a git repository, and the agent's
`context.json` lists it under `uses`. Building resolves `uses` into `context.lock.json` and puts the manifests and
skills in the artifact; starting an instance clones or binds the content, installs the environment and starts the
connectors. A package's parts are mounted under its alias (`content/<alias>/<name>`). Two packages that declare the
same skill or connector, or environment constraints that cannot both hold, are refused at build; the agent's own
declaration wins only where it is written explicitly. An instance can bind an entry to another repository or directory
without a rebuild, as `context.local.json` does today.

### 4.3 Hosts and storage

A host adapter turns the artifact into what its cloud runs, and chooses the storage the harness opens: SQLite on a
volume (Fly, Railway, Docker), on AgentCore's session storage, or a Cloudflare Durable Object. One process owns a
storage at a time, so a deployment routes every session of one storage to one process. On a host with no resident
process, something must start the process when a run was cut off mid-way; the external clock the schedules already
use is the candidate.

### 4.4 Later: shared contexts and agents working together

Several agents using one context package share its declaration, not its data. Sharing data that is being written needs
a context service; an agent calling another uses the other's consumer API, or A2A, which AgentCore can host. Both wait
for the steps above.

## 5. What goes

| Goes | Replaced by |
|---|---|
| The previous SPEC v1 surface: `sessions.list`, `sessions.get(...).rewind/compact/update/delete`, `messages.*`, capabilities, `source`, the control plane | SPEC v1 as now written, and `agent.harness` |
| `harness-port.ts`, `serving-layer.ts`, `loop-port.ts`, the conformance suite over a harness port | The Agent implemented on pi-durable, and the suite over that Agent |
| `harnesses/pi/` serving and session code, the `chat` TUI | The pi-durable assembly, and a REPL |
| `defineTool` with Zod, and its `secrets` | pi-durable's `defineTool`; `secrets` in `context.json` |
| [agent-service.md](agent-service.md) §7 to §9, [conformance-levels.md](conformance-levels.md), the multi-tenant facade of [security-boundary.md](security-boundary.md) §4 | This note and the SPEC |

## 6. Order

1. **A spike on pi-durable** that answers what the SPEC now promises: SQLite on AgentCore's session storage and what
   restarts a run cut off there; the definition rendered and run (`SYSTEM.md`, `AGENTS.md`, skills, tools); how
   images are stored, behind `attachment`; whether an answer being written already has its entry id and its text so
   far, which `message_delta` and `state.reply` need; whether a fork's copied entries can be told from its own, which
   `usage` needs; and the queue left waiting after a failed or aborted run.
2. The Agent on pi-durable, with the conformance suite in process and over HTTP; channels, schedules, wake-ups, the CLI
   and AgentCore moved onto it; the previous protocol, `LoopPort` and the pi-coding-agent harness deleted.
3. The artifact: `fastagent build`, and `deploy` from it.
4. Context packages.
5. Shared contexts and agents working together.

## 7. Open

- `APPEND_SYSTEM.md` adds to pi-coding-agent's default prompt, which pi-durable does not have: whether it stays, as the
  part of `SYSTEM.md` an author keeps apart, or goes.
- Hot reload in `dev`: the definition is read on every invoke today; pi-durable installs extensions in a registry.
- Bun: pi-durable's portable SQLite core runs there given an adapter over `bun:sqlite`, which does not exist yet.
