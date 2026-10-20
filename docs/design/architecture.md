---
title: Architecture
description: "What FastAgent is for, and the shape that follows: one harness (pi-durable), one consumer API (the Agent API), a definition that compiles to it, an npm package as the artifact, context packages, and hosts that keep the state off the box."
type: design-doc
status: decided
---

# Architecture

**Status: decided, not implemented.** This note and the [Agent API](agent-api.md) replace the harness-neutral design of
[agent-service.md](agent-service.md) §7 to §9, [conformance-levels.md](conformance-levels.md) and
[SPEC v1](../SPEC.md). The code still serves
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
| **One API of our own: the consumer [Agent API](agent-api.md)**, bound in TypeScript and over HTTP | Every consumer, ours included (channels, schedules, wake-ups, the REPL), needs the same eight operations. It is also the layer that keeps pi-durable's experimental API and internal entry kinds away from clients |
| **Everything else is pi-durable's own API**, as `agent.harness` in the process that runs the agent | Operating an agent (settings, compaction, inspecting sessions) has one implementation; wrapping it would only rename it. A developer who needs one of those over HTTP adds a route that calls it |
| **The agent is a public bot.** No identity or session ownership in FastAgent | Who may reach it is decided in front of it. A session id is a name, not a credential: whoever reaches the agent reaches every session. When several users share one deployment, a facade in front keeps each to their own sessions ([security-boundary.md](security-boundary.md) §4) |
| **The Agent names sessions; Callers remember them** | pi-durable mints conversation ids and cannot take a Caller's. A channel or a schedule keeps its own mapping (a chat to its session, a schedule to its session) in its own state, as it already keeps other state |
| **Ids are encoded, never reused** | pi-durable's ids are one counter per storage, starting again from 2 in a new one, and a deploy can replace the storage (AgentCore resets its session storage; a volume can be rebuilt). An id the Agent hands out is the storage's incarnation, a random id minted when the storage is created, followed by pi-durable's id: sessions, messages and entries alike. An id kept from a storage that is gone is then `not_found` instead of someone else's conversation, and an id says which storage it belongs to, which routing across several storages needs. It is an encoding, not a lookup: nothing is stored to map one id to another |
| **No session listing and no deletion** | No consumer needs them; pi-durable has no deletion |
| **An agent is a standard npm and TypeScript package** (§3) | The artifact is an npm package (§4.1), and an agent must be a value other code can import: an app that embeds it, a deploy by package name and version, another agent that depends on it |
| **One configuration file, `fastagent.config.ts`, with `defineAgent()`; every field optional** | It is the `defineConfig` pattern of Vite and its peers: typed, and read by the build. The model, thinking level and tools it names are defaults: a deployment overrides them with a flag or an environment variable, and a session with pi-durable's own API |
| **Code is registered by where it is, at build time**: `src/tools/`, `src/extensions/`, `src/channels/`, `src/schedules/` | `fastagent dev` and `build` generate a registry of plain imports, as TanStack Router's route tree and Next.js's route manifest are generated: nothing to import by hand, full types, and a bundler can follow it. Not a scan at run time (no types, no bundling, a loader to keep), and not `import.meta.glob`, which only Vite understands while `dev` runs on Node |
| **The code is pi-durable's**: tools are its `defineTool` (TypeBox), extensions its `defineExtension` | With one harness, a portable layer over its tool and extension APIs would be a second API to learn for nothing |
| **Third-party capabilities are pi-durable extensions**, listed in `defineAgent({ extensions })` | An extension is already a named bundle of tools, prompt sections and hooks, so it is the plugin; nothing new is invented. Contexts, skills, MCP and environments travel as context packages (§4.2) |
| **Schedules are TypeScript**: `defineSchedule({ cron, tz, prompt })`, the prompt a text or a function | A schedule is behaviour, like a tool: a prompt that depends on the time it fires, secrets it may need, and a cron the build checks, including the dialect an external clock accepts |
| **`SYSTEM.md` is the whole prompt the author writes; `APPEND_SYSTEM.md` goes** | It added to pi-coding-agent's default prompt, which pi-durable does not have |
| **Secrets are declared by whoever reads them**, and `deploy` checks them as one list | Code declares the names it reads in its own module, `needs(["X_API_KEY"], ({ X_API_KEY }) => defineTool(...))`, and receives exactly those values, typed, so a declaration cannot drift from its read. The commands the agent runs read theirs from the environment, declared in `context.json`'s `environment.variables`; a context package's connectors declare theirs beside each connector. A missing one fails the start, naming where it was declared |

The previous design's pi-coding-agent harness goes with it: pi's `extensions/` and `.pi/`, `APPEND_SYSTEM.md`, the
`chat` TUI (replaced by a REPL over the consumer API), and the skills and prompt templates a machine lends from
`~/.pi/agent`.

## 3. The definition and its assembly

```
my-agent/
  package.json
  fastagent.config.ts             defineAgent({...}): every field optional
  SYSTEM.md  AGENTS.md            the agent's prompt; how to work on the agent
  skills/<name>/SKILL.md          Agent Skills
  src/
    tools/*.ts                    pi-durable defineTool, with needs([...]) for secrets
    extensions/*.ts               pi-durable defineExtension
    channels/*.ts
    schedules/*.ts                defineSchedule
  context.json  context.lock.json
  .fastagent/                     the generated registry and entry, not committed
  dist/                           the build output
```

Code is under `src/`, because it is what the build compiles. Text is at the root, because it is data the agent reads
at run time by its path: a skill's `SKILL.md` names the files and scripts beside it, which must ship as they are, and
`tsc` emits only JavaScript. `AGENTS.md` is where every coding agent looks for how to work on the project.

```ts
// fastagent.config.ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  name: "support",                       // default: package.json's name
  model: "anthropic/claude-sonnet-4-5",  // a default; a deployment or a session may change it
  thinkingLevel: "medium",
  extensions: [stripe()],                // third-party capabilities
  http: { cors: ["https://app.example.com"] },
  deploy: { agentcore: { idleTimeoutSeconds: 900 } },
});
```

`fastagent build` generates the registry of `src/`'s four directories and an entry that exports the agent (the
configuration and the registry), compiles them, and locks the context; `package.json`'s `exports` names that entry.
`fastagent dev` generates the same and regenerates it as files change. Every tool found is offered unless the
configuration leaves it out; a deployment cannot add one, since code ships in the artifact.

`openAgent(agent)` assembles it: pi-ai's model registry and credentials, a pi-durable `Harness` over the instance's
storage, `SYSTEM.md`, `AGENTS.md` and the skills rendered into pi-durable's prompt sections, the tools and extensions
installed with the secrets they declared, and the execution environment its context declares. The result is the Agent
API's `Agent`, plus `harness`. `dev`, `start` and an embedder's process call the same function, so an agent behaves the
same wherever it runs.

## 4. Around the agent

### 4.1 The artifact

The artifact is an **npm package**: the built entry, the text and skills, `context.json` and its lock, the lockfile and
an exact pi-durable version.
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
| `uses` | The context packages it builds on, by an alias of its own: `{ "billing": "@acme/ctx-billing@^1" }` |

plus `skills/` for working with that context. It is distributed as an npm package or a git repository, and the agent's
`context.json` lists it under `uses`. Building resolves `uses` into `context.lock.json` and puts the manifests and
skills in the artifact; starting an instance clones or binds the content, installs the environment and starts the
connectors. An instance can bind an entry to another repository or directory without a rebuild, as
`context.local.json` does today.

**Each package is a namespace, named by the alias its user gives it**, so two packages never collide on a name:

| Part | Under the alias `billing` | Conflicts |
|---|---|---|
| Content | `content/billing/<name>` | None |
| Skills | Offered to the model as `billing/<name>`; the `SKILL.md` on disk keeps the standard's name | None |
| Connectors | `billing/<name>`, their tools prefixed with the alias | None |
| Secrets | Not namespaced: an environment variable's name is global | One name is one value: two packages that need `GITHUB_TOKEN` need the same token |
| Environment | Not namespaced: a process has one `PATH` | Constraints that cannot both hold are refused at build |

The agent's own parts carry no prefix. Since the agent chooses the aliases, two aliases cannot collide either.

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
| [SPEC v1](../SPEC.md)'s surface: Caller-named sessions, `sessions.list`, `sessions.get(...).rewind/compact/update/delete`, `messages.*`, capabilities, `source`, the control plane | The [Agent API](agent-api.md), which then becomes `docs/SPEC.md`, and `agent.harness` |
| `harness-port.ts`, `serving-layer.ts`, `loop-port.ts`, the conformance suite over a harness port | The Agent implemented on pi-durable, and the suite over that Agent |
| `harnesses/pi/` serving and session code, the `chat` TUI | The pi-durable assembly, and a REPL |
| `defineTool` with Zod, and its `secrets`; `defineChannel`'s `secrets` | pi-durable's `defineTool`; `needs([...])` in the module that reads them |
| `tools/`, `channels/` and `schedules/` read by a scan at run time (`loader.ts`); schedules in markdown | `src/` registered by a generated registry; `defineSchedule` |
| `fastagent.config.ts`'s `FastagentConfig`, and `APPEND_SYSTEM.md` | `defineAgent()`, every field optional; `SYSTEM.md` alone |
| A thread's Caller-named session, whose existence records that the room was forked ([participant-model.md](participant-model.md) rungs 3 and 4) | The thread's session id, recorded in the channel's state after `createSession` forks the room. The branch point is still found by key (`getMessage` with the platform's message id). A crash between the fork and the record leaves a fork nothing refers to, which the retry does not reuse; nothing deletes it |
| [agent-service.md](agent-service.md) §7 to §9, [conformance-levels.md](conformance-levels.md) | This note and the Agent API |

## 6. Order

1. **A spike on pi-durable** that answers what the Agent API promises: SQLite on AgentCore's session storage and what
   restarts a run cut off there; the definition rendered and run (`SYSTEM.md`, `AGENTS.md`, skills, tools); how
   images are stored, behind `attachment`; whether an answer being written already has its entry id and its text so
   far, which `message_delta` and `state.reply` need (pi-durable commits a partial answer at most every 100 ms); whether a fork's copied entries can be told from its own, which
   `usage` needs; and the queue left waiting after a failed or aborted run.
2. The Agent on pi-durable, with the conformance suite in process and over HTTP; channels, schedules, wake-ups, the CLI
   and AgentCore moved onto it; the previous protocol, `LoopPort` and the pi-coding-agent harness deleted.
3. The artifact: `fastagent build`, and `deploy` from it.
4. Context packages.
5. Shared contexts and agents working together.

## 7. Compared with other agent APIs

Four published APIs answer parts of the same question, checked against their documentation: ACP (Agent Client
Protocol, editor to agent; its v2 documents), A2A 1.0 (agent to agent), AG-UI 1.0 (agent to front end), and OpenAI's
Responses and Conversations APIs.

| | The Agent API | ACP v2 | A2A 1.0 | AG-UI 1.0 | OpenAI |
|---|---|---|---|---|---|
| Session id | The Agent's | The agent's | `contextId` | `threadId`, from the client | The server's |
| The unit a caller holds | A message | `session/prompt` answers a `messageId` once the message is in the conversation | A Task or a Message | A run | A response |
| Its status by id | `getMessage` | None | `GetTask` | None | `GET /responses/{id}` |
| Reconnecting | `resume`: replay, snapshot, live | `session/resume` with `replayFrom`, then a current-state snapshot | `SubscribeToTask` | Snapshot events | `starting_after` a sequence number |
| Stopping | `abort`, the whole session | `session/cancel`, the whole session | `CancelTask` | None | One response |
| Deduplication | `idempotencyKey`, per session | None | Optional, by the client's `messageId` | None | None |
| A busy session | `queue`, `steer`, `reject` | Not required | None | None | None |
| Asking the user | Not yet | Permission requests, elicitation | `input-required` | Interrupts | None |

ACP v2 arrived independently at the same model: the agent names sessions, a prompt is answered once its message is in
the conversation, no turn id is exposed, stopping is per session, the state is `idle` or `running`, and a client
resumes from a cursor and is then told the current state. From the comparison the Agent API took `getMessage` (A2A,
OpenAI), the snapshot after a replay (ACP), content parts (ACP, A2A, OpenAI), the accepted inputs in `info` (ACP's
negotiated prompt capabilities), open value sets with prefixed extensions (ACP's `_` names), and an answer that can be
resumed mid-way (ACP's message ids on chunks, OpenAI's sequence numbers).

It did not take: a run, turn or task as a first-class id (messages are the unit); history owned by the client and sent
with each run (AG-UI; here the Agent owns it); shared-state JSON patches, plans and modes (agent-specific, so prefixed
custom events); a file system and terminal the client provides (ACP; this agent runs server-side in its own
environment); session listing, closing, deletion and a tenant field; JSON-RPC as the transport (REST and SSE serve
web consumers more simply). Asking the user, a webhook when a message ends (A2A, OpenAI's background mode) and a live
notice event (ACP) can be added later under the API's rules for extending, without breaking a Caller. Bindings to
those protocols are outside the product's goals.

## 8. Open

Settled when they are implemented:

- Hot reload in `dev`: the definition is read on every invoke today; pi-durable installs extensions in a registry.
- What starts a process on AgentCore to continue a run cut off there (§4.3).
- Whether pi-ai's `models.json` stays a file or joins `defineAgent`.
- Bun: pi-durable's portable SQLite core runs there given an adapter over `bun:sqlite`, which does not exist yet.
