---
title: Architecture
description: "What FastAgent is for, and the shape that follows: one harness (pi-durable), one consumer API (the Agent API), a definition that compiles to it, an npm package as the artifact, context packages, and hosts that keep the state off the box."
type: design-doc
status: implemented in part
---

# Architecture

**Status: decided; implemented through §6 step 2.** The code serves an agent on pi-durable through the
[Agent API](../SPEC.md). The artifact (§4.1), context packages (§4.2) and what §4.4 leaves for later are not built yet;
§6 is the order. This note and the Agent API replaced a harness-neutral design: the SPEC v1 protocol (never released),
a harness port, and the conformance levels behind them (§5).

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
| **One API of our own: the consumer [Agent API](../SPEC.md)**, bound in TypeScript in process and, from v2 ([proposed](agent-api.md)), over HTTP | Every consumer, ours included (channels, schedules, wake-ups, `fastagent invoke`), needs the same operations, and so does a program that calls a deployed agent the way it calls any service. One model with two bindings, the same names and objects in both, lets a Caller move between an agent it opens and one it reaches over HTTP by changing one line. It is also the layer that keeps pi-durable's experimental API and internal entry kinds away from clients |
| **Everything else is pi-durable's own API**, as `agent.harness` in the process that runs the agent | Operating an agent (its definition, inspecting sessions) has one implementation; wrapping it would only rename it. A session's model and thinking level are a consumer's choice, at creation, at a fork, or later with `configure`, which is pi-durable's `configure()` with those two fields: a Caller who may use a session may choose what it answers with. From v2 ([proposed](agent-api.md)), a Caller also sets a session's `instructions` and `tools` (chosen among the agent's own) and compacts it; its working directory and extensions stay the definition's |
| **An instance is one trust domain, and serves nothing that does not verify its caller** | Whoever holds the Agent can do everything it can, every session and the agent's tools included. A deployment's routes are its channels', which MUST verify that a request comes from their platform; its host's own (AgentCore's, behind IAM); and, from v2, the HTTP API, which verifies an API key ([agent-api.md](agent-api.md) §9). The key keeps everyone but the instance's customer out; it does not divide an instance. A platform's signature proves the platform, not the person: everyone who can message a channel's bot is inside the trust domain, and can ask the agent for anything its tools reach, every other chat's conversation included. People who must not read each other's conversations are kept apart by giving each an instance, not inside one: the agent's tools reach every session of their instance, whichever session asked, so a check on session ids would not keep them apart. A session id is a name, not a credential |
| **The Agent names sessions; Callers remember them** | pi-durable mints conversation ids and cannot take a Caller's. A channel or a schedule keeps its own mapping (a chat or a thread to its session, a schedule to its session) in its own state, as it already keeps other state. The rule that keeps a mapping single is below the table |
| **Ids are encoded, never reused** | pi-durable's ids are one counter per storage, starting again from 2 in a new one, and a deploy can replace the storage (AgentCore resets its session storage; a volume can be rebuilt). An id the Agent hands out is the storage's incarnation, a random id minted when the storage is created, followed by pi-durable's id: sessions, messages and entries alike. An id kept from a storage that is gone is then `not_found` instead of someone else's conversation, and an id says which storage it belongs to, which routing across several storages needs. It is an encoding, not a lookup: nothing is stored to map one id to another. One loss it cannot cover: a storage that rolls back its newest commits keeps its incarnation, so the ids of what was rolled back are handed out again; AgentCore after a host failure is the case, accepted there (§4.3) |
| **Sessions are listed, most recently active first; none is deleted** | A client shows an agent's conversations whatever started them: duang's sidebar lists the ones a channel or a schedule started too, which no list a Caller keeps could hold. An instance is one trust domain, so a list shows nothing its Caller could not already read. Within one storage the order needs no clock: pi-durable gives sessions, messages and entries their ids from one counter, so a session's newest id is its latest activity. v2's `createdAt` and `lastActiveAt` are times FastAgent records for a Caller to show; they do not order the list ([agent-api.md](agent-api.md) §14). Several storages behind one instance compare activity by time, designed with them (#788, scale-out on AgentCore). pi-durable has no deletion |
| **An agent is a standard npm and TypeScript package** (§3) | The artifact is an npm package (§4.1), and an agent must be a value other code can import: an app that embeds it, a deploy by package name and version, another agent that depends on it |
| **One configuration file, `fastagent.config.ts`, with `defineAgent()`; every field optional** | It is the `defineConfig` pattern of Vite and its peers: typed, and read by the build. The model, thinking level and tools it names are defaults: a deployment overrides them with a flag or an environment variable, and a session with pi-durable's own API |
| **Code is registered by where it is, at build time**: `src/tools/`, `src/extensions/`, `src/channels/`, `src/schedules/` | Every command that opens the definition generates a registry of plain imports (`.fastagent/registry.ts`; `build` will too), as TanStack Router's route tree and Next.js's route manifest are generated: nothing to import by hand, full types, and a bundler can follow it. Not a scan at run time (no types, no bundling, a loader to keep), and not `import.meta.glob`, which only Vite understands while `dev` runs on Node |
| **The code is pi-durable's**: tools are its `defineTool` (TypeBox), extensions its `defineExtension` | With one harness, a portable layer over its tool and extension APIs would be a second API to learn for nothing |
| **Third-party capabilities are pi-durable extensions**, listed in `defineAgent({ extensions })` | An extension is already a named bundle of tools, prompt sections and hooks, so it is the plugin; nothing new is invented. Contexts, skills, MCP and environments travel as context packages (§4.2) |
| **Schedules are TypeScript**: `defineSchedule({ cron, tz, prompt })`, the prompt a text or a function | A schedule is behaviour, like a tool: a prompt that depends on the time it fires, secrets it may need, and a cron the build checks, including the dialect an external clock accepts |
| **`SYSTEM.md` is the whole prompt the author writes; `APPEND_SYSTEM.md` goes** | It added to pi-coding-agent's default prompt, which pi-durable does not have |
| **Secrets are declared by whoever reads them**, and `deploy` checks them as one list | Code declares the names it reads in its own module, `needs(["X_API_KEY"], ({ X_API_KEY }) => defineTool(...))`, and receives exactly those values, typed, so a declaration cannot drift from its read. The commands the agent runs read theirs from the environment, declared in `context.json`'s `environment.variables`; a context package's connectors declare theirs beside each connector. A declaration may say what the secret is for and that the code runs without it (`{ name, description, optional }`). A missing required one fails the start, naming where it was declared. Whoever deploys or runs the agent reads none of that code: preparing the definition writes every declaration into one manifest, `.fastagent/secrets.json` (each name once, what it is for, whether it is optional, where it is declared), which runbooks, an `.env.example` and the deploy check are made from |

**A mapping is created in one order, in one place.** With Caller-named sessions, a chat's id was its session's, so a
redelivered first message found its message by key, and two threads created at once met in `conflict`. With sessions
the Agent names, a channel or a schedule creates a session and records it, and that is a check followed by a write,
safe only where it is serialized:

1. **Serialized by place.** A mapping is created only inside the work the channel already serializes per place (a
   chat, a thread): its turn queue, keyed by the place rather than by a session, with its durable turn store. Two
   messages arriving at once for a new place, or a redelivery of the first, run one after the other, and the second
   finds the mapping the first wrote. Across processes, one process owns an instance's state at a time (the serving
   process's lease), so there is one writer.
2. **Session, then record, then message.** `createSession` (a fork, for a thread), then the mapping written durably,
   then the invoke into the mapped session with the platform's message id as its `idempotencyKey`. A channel never
   invokes without `sessionId`, since such an invoke cannot carry a key.

A crash after `createSession` and before the record leaves a session nothing refers to, empty or a fork, which the
retry does not reuse and nothing deletes; no message is answered twice, since a message is only sent once its session
is recorded. A crash after the record is a redelivery that finds it, and the key makes the invoke a duplicate.

The previous design's pi-coding-agent harness went with it: pi's `extensions/` and `.pi/`, `APPEND_SYSTEM.md`, the
`chat` TUI, and the skills and prompt templates a machine lends from `~/.pi/agent`. Nothing interactive replaces
`chat`: an agent is built in a coding environment, by a coding agent as often as by a person, and what checks it there
is a command a coding agent can run and read: `fastagent info --json` for what the definition opened as, and
`fastagent invoke` for one message, its answer and an exit code.

A consumer may choose a session's model and thinking level with `createSession({ model, thinkingLevel, from? })`,
passed to pi-durable's creation options in the same commit. A fork inherits the settings at its branch point and
applies the supplied overrides. `configure` changes them later, from the session's next model request, and the
session's state reads them back. `invoke` uses those settings and accepts no per-message model choice. v2 adds
`instructions` and `tools` to the settings a Caller chooses ([agent-api.md](agent-api.md) §4). A session that
names a model keeps it; FastAgent never replaces it automatically when it becomes unavailable, and a Caller moves it
to another with `configure`.

## 3. The definition and its assembly

```
my-agent/
  package.json
  fastagent.config.ts             defineAgent({...}): every field optional
  SYSTEM.md  AGENTS.md            the agent's prompt; how to work on the agent
  skills/<name>/SKILL.md          Agent Skills
  prompts/<name>.md               prompt templates a user runs as /<name>
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
  providers: [gateway],                  // model providers beyond pi-ai's built-ins
  deploy: { agentcore: { idleTimeoutSeconds: 900 } },
});
```

`fastagent build` generates the registry of `src/`'s four directories and an entry that exports the agent (the
configuration and the registry), compiles them, and locks the context; `package.json`'s `exports` names that entry.
`fastagent dev` generates the same and regenerates it as files change. Every tool found is offered unless the
configuration leaves it out; a deployment cannot add one, since code ships in the artifact. Each file directly in one
of the four directories is a module and default-exports one thing (a tool, an extension, a channel, a schedule, or
`needs(...)` around one); a helper they import lives elsewhere in `src/`, and a test file is not a module.

`openAgent(agent)` assembles it: pi-ai's built-in models with the definition's `providers` over a credential store
(the machine's in development, the instance's `.secrets/` when deployed), a pi-durable `Harness` over the instance's
storage, `SYSTEM.md` and `AGENTS.md` rendered into pi-durable's prompt sections, pi-durable's coding tools, then the
definition's tools and extensions installed with the secrets they declared, and an execution environment rooted at the
agent's directory. Model selection is pi-ai's alone: no `models.json`, no model catalog cache, and no per-account
model list. Skills are loaded as pi loads them (Agent Skills): a prompt section lists each one's name, description and
location, the model reads its `SKILL.md` with `read` through the execution environment when a task matches, and
`/skill:<name>` loads it into the message. Prompt templates are FastAgent's, not the harness's: `invoke` expands a
message that starts with `/<name>` before pi-durable sees it, with pi's template format (a `description` in the
frontmatter, `$1`, `$@` and their default and slice forms for arguments), and `info()` lists them with the skills as
the agent's commands ([Agent API](../SPEC.md) §3). The result is the Agent
API's `Agent`, plus `harness`. `dev`, `start` and an embedder's process call the same function, so an agent behaves the
same wherever it runs.

**An agent changing itself** ([agent-model.md](agent-model.md) §6) keeps what is text and loses what is code. Its
text (`SYSTEM.md`, `AGENTS.md`, skills, prompt templates) is read for each request, so a change it makes takes effect on its next
answer, and lasts until the next deployment, as today. Its code is built into the artifact, so a tool, an extension or
a schedule it writes takes effect only through a build and a deployment, the way its author's does
([#605](https://github.com/fastagent-sh/fastagent/issues/605)). Recurring work it sets up for itself is state, not
code: the built-in `wake` tool, which already keeps one-shot wake-ups in the instance's state, gains a recurring form.

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
storage at a time, so a deployment routes every session of one storage to one process.

**AgentCore's session storage** is the managed file system AgentCore mounts per runtime session (a preview feature).
Measured (§6.1) and documented, it is:

- an NFSv4.0 mount served inside the microVM (`127.0.0.1:/export`, `local_lock=none`), replicated to AWS's storage
  asynchronously and flushed when the session stops gracefully;
- isolated per runtime session, with one compute per session at a time, at most 1 GB, and reset by every runtime
  version update (every deploy) and after 14 idle days;
- a place where SQLite's own locks fail, in every journal mode (`database is locked`), while `flock` works: the
  deployment lease takes one there today, and a second taker is refused.

So on AgentCore FastAgent opens the SQLite database itself and hands it to pi-durable:
`new DatabaseSync("file:<path>?vfs=unix-dotfile")`, then `locking_mode = EXCLUSIVE` and `journal_mode = WAL` in that
order, then pi-durable's `NodeSqliteDatabase` and `SqliteStorage.open`. FastAgent creates the directory, since it
opens the file itself (pi-durable's own opener would create a directory named after the URI's `file:` prefix instead).
With `unix-dotfile`, SQLite locks by creating the directory `<path>.lock` (and unlocks with `rmdir`), which works on
this mount, and the exclusive mode keeps
WAL's index in the process's memory, so no shared memory is needed; a second opener fails with `database is locked`.
That is the safety the storage needs, and it is two rules:

1. **Only the lease holder opens the storage.** One compute per session is not one process per compute: an agent's
   tools start processes, and `login --deployment` opens a shell on the same `/mnt/data`. The serving process holds
   the deployment lease, so it is the one that opens the database; anything else that tries is refused.
2. **The lease holder breaks a stale lock, and says so.** A dotfile lock outlives a stopped microVM (measured), where
   `flock` does not, so a process that holds the lease knows a `<path>.lock` it finds is a dead process's: it removes
   that directory (`rmdir`; an unlink fails on it) before opening, and logs that it did.

Without locking at all (`vfs=unix-none`), a second opener's writes were accepted and then silently lost (measured),
which is why the storage keeps a lock.

This is a choice of storage, not a fix of pi-durable's, and nothing upstream is needed. Its alternatives are a mounted
EFS (POSIX locks, survives deploys, shared across sessions; needs a VPC and so a standing NAT for the model's traffic)
or a pi-durable storage backend of our own on a database service. Both exist to keep conversations across deploys,
which an AgentCore agent does not: a deploy resets its state, as it does today, and that is decided, so session
storage stays. They would also survive a host failure, which session storage may not (below).

Nothing continues a run cut off on AgentCore by itself: a stopped session stays stopped until it is invoked again.
Every process opens the storage and calls pi-durable's `harness.resume()` when it starts, before it handles the
invocation, so whatever invocation arrives continues the runs the last process left: one that submits nothing (a chat
message the agent was not summoned for, a platform's URL check) included. A run is cut off when the microVM reaches
its maximum lifetime (eight hours as deployed) or when its host fails. **No alarm is set to continue it.** Every
conversation of an agent shares one runtime session and one storage, so any invocation wakes them all: a message in
any chat, a platform's webhook, a schedule's own trigger. Only an agent that receives nothing after the cut leaves its
cut-off message unanswered until something arrives; a one-shot wake alarm per run (the wake-ups' own mechanism) would
close that, at a few scheduler calls per run, and is added if that case is seen. To be seen at all, it is logged when
it ends: a process whose `resume()` finds a run left by the last one logs it, with the time of the run's newest entry
and how long it waited since. A session whose `/ping` answers
`HealthyBusy` is not reclaimed for being idle.

**A host failure is not measured**, and is not a graceful stop: what was not yet replicated is lost, and how much of
the database and its WAL survive is unknown. A process may then find the database corrupt, or its newest commits
missing:

- **Corrupt:** an open that reports `SQLITE_CORRUPT` is an error of the start that says so, never a silent fresh
  storage, and the next deploy resets it.
- **Rolled back:** the storage opens, with its incarnation, and its counter where it was before the lost commits. The
  messages accepted in them are lost, against the Agent API's promise (§4.1 there says so), and their ids are handed
  out again, against §2's: a session id a Caller kept can name another conversation. A channel's mapping lives in
  `.state/`, replicated apart from the database, so it can survive the rollback and send a chat into a session that
  is now another chat's. Nothing here detects it: the storage that would record what was handed out is the one that
  rolled back.

Both are accepted as limits of session storage while it is a preview, and both are rare: a host failure, not a stop,
an eight-hour lifetime or a deploy. A mounted EFS or a storage backend on a database service would remove both, which
is the other reason to choose one of them, besides keeping conversations across deploys; neither is worth a VPC and a
standing NAT, or a backend of our own, for a failure not yet seen.

### 4.4 Later: shared contexts and agents working together

Several agents using one context package share its declaration, not its data. Sharing data that is being written needs
a context service. An agent calling another, in another instance, is a remote Caller: it calls the other's HTTP API
([agent-api.md](agent-api.md) §9), or an A2A binding of it, which AgentCore can host, designed when this is built. Both
wait for the steps above.

## 5. What went

What the previous design had, and what took its place:

| Went | Replaced by |
|---|---|
| SPEC v1's surface: Caller-named sessions, `sessions.list`, `sessions.get(...).rewind/compact/update/delete`, `messages.*`, capabilities, `source`, the control plane | The [Agent API](../SPEC.md), and `agent.harness` |
| `harness-port.ts`, `serving-layer.ts`, `loop-port.ts`, the conformance suite over a harness port | The Agent implemented on pi-durable, and the suite over that Agent |
| `harnesses/pi/` serving and session code, the `chat` TUI | The pi-durable assembly; `fastagent invoke` checks an agent from a coding environment |
| `defineTool` with Zod, and its `secrets`; `defineChannel`'s `secrets` | pi-durable's `defineTool`; `needs([...])` in the module that reads them |
| `tools/`, `channels/` and `schedules/` read by a scan at run time (`loader.ts`); schedules in markdown | `src/` registered by a generated registry; `defineSchedule` |
| `fastagent.config.ts`'s `FastagentConfig`, and `APPEND_SYSTEM.md` | `defineAgent()`, every field optional; `SYSTEM.md` alone |
| Extensions an agent writes for itself, live on its next session | A build and a deployment, as for any code (§3) |
| Schedules an agent writes for itself, live within 30 seconds | `wake`'s recurring form, kept in the instance's state (§3) |
| A thread's Caller-named session, whose existence records that the room was forked ([participant-model.md](participant-model.md) rungs 3 and 4) | The thread's session id, recorded in the channel's state after `createSession` forks the room, in the order and place of §2. The branch point is still found by key (`getMessage` with the platform's message id) |
| The served HTTP API (`/invoke`, `/sessions`, `/agent`, `/control`), `http.api`, `http.control`, `http.cors`, `--no-api`, `connectAgent` and `createAgentHandler`, AgentCore's `api` envelope | Nothing: a deployment serves its channels and its host's routes, and an embedding app calls the Agent API in process (§2). What used them went with them or moved, by the list below |
| An outside clock (Fly's Cron Manager, a Railway cron service, a CI job) calling `POST /invoke` in place of a schedule, so a host can scale to zero; `deploy`'s pre-flight offering it | Gone. A schedule keeps its machine resident, except on AgentCore, whose EventBridge alarms wake the container through its own envelope. A clock that must wake a scaled-to-zero machine is a channel its author writes, which verifies the clock's call |
| The AgentCore runbook's smoke test, a turn sent as an `api` envelope | A `probe` envelope, which says whether the definition opened; a turn is tried through a channel or a schedule |
| `start`'s `try it: curl …/invoke` | `fastagent invoke`, in process |
| `connectAgent` for a web panel, a desktop app or another service | Gone until a remote Caller is built (§2): a local client embeds the agent |
| A deployment with no channel and no schedule, reached through the API | Nothing reaches it but its health check, and `deploy`'s pre-flight says so: such an agent is used by embedding it. v2's HTTP API, behind a key, reaches it on Docker, Fly and Railway ([agent-api.md](agent-api.md) §9.5) |
| agent-service.md's contexts, serving protocol, architecture and deployment (its §3.6 and §7 to §14), and conformance-levels.md | This note and the Agent API; [agent-service.md](agent-service.md) keeps its §1 to §6 |

## 6. Order

1. **Done.** A spike on pi-durable, on 1.3.0, locally and on AgentCore (§6.1).
2. **Done** ([#788](https://github.com/fastagent-sh/fastagent/issues/788)). The Agent on pi-durable, with the
   conformance suite in process; channels, schedules, wake-ups, the CLI and AgentCore moved onto it; the previous
   protocol, its HTTP API, `LoopPort` and the pi-coding-agent harness deleted.
3. The Agent API v2 ([proposed](agent-api.md)): one model, in process and over HTTP with an API key.
4. The artifact: `fastagent build`, and `deploy` from it.
5. Context packages.
6. Shared contexts and agents working together.

### 6.1 What the spike measured

On pi-durable 1.3.0 with pi-ai's faux model, in process, against memory and SQLite storage:

| Question | Measured | So the implementation |
|---|---|---|
| The definition rendered | `SYSTEM.md`, `AGENTS.md` and the skill list render as an extension's prompt sections, and pi-durable adds no prompt of its own; a tool made by `needs([...])` around pi-durable's `defineTool` receives its secret | Installs one extension of FastAgent's own with those sections, beside the agent's tools and extensions |
| A command kept as sent | An input submitted with the expanded text as `content` and `entry: { kind: "fastagent.user", data: { content: <as sent> } }` is recorded with that kind and data, while the model sees `content` | Submits every message that way, and publishes `fastagent.user` as `user_message` |
| Images | Stored inline, as base64, in the entry's model message; there is no separate blob store | `attachment(ref)` reads from the entry: a ref names the entry and the part. Images grow the storage |
| An answer being written | Its text so far is in `pi.live.generation.message`, and in a new `watchEvents` stream's snapshot, with its attempt number; its entry gets an id only when the answer is complete | `state.reply` is that text and `message_delta` carries no entry id ([Agent API](../SPEC.md) §6) |
| A fork's history | Shares the source's entries: the same ids, with the source's `conversationId` | Publishes `Entry.sessionId` from it |
| The queue after a run that did not answer | Waits, after a model failure and across a restart (the inbox persists with no run live); a write submission of FastAgent's kind `fastagent.release` with `edits: []` places it (the conversation takes the inputs waiting in its inbox), and lands as an entry | Submits that write after each run that did not answer and at the first open of a conversation whose inbox waits with no run live, and never publishes the entry |
| Abort | `conversation.abort()` ends the running message and withdraws the queued ones, and a message sent after it settles is taken; but one sent while the aborted run is still settling waits in the inbox, and `abort()` itself waits for a running tool that ignores its signal | Calls `conversation.abort()` and answers `abort` when it returns, as the Agent API's `abort` does (§5 there). The `fastagent.release` write follows the end of the stopped run, as after any run that did not answer, whether or not the `abort` call is still waiting: its Caller may have stopped waiting |
| The default model | pi-durable reads a conversation's model and thinking level only from its own `pi.agent`, and has no default of the host's: without one, a message fails `no_model` | Writes the deployment's default into `pi.agent` when a message is admitted to a conversation that names none. A conversation that names its own, set through pi-durable's API or taken from an earlier default, keeps it: a later default reaches only the conversations that name none. A message to a conversation whose model the agent's models no longer have is refused `missing_model`, naming that model, rather than accepted only to fail |
| Ids | Entries, submissions and conversations share one counter per storage, which a new storage starts again (conversation 8 in both); a session-scoped document keeps a random incarnation across reopens and gets a new one in a new storage | Encodes every id as incarnation plus pi-durable's id (§2) |

On AgentCore, with the same pi-durable in a minimal ARM64 container (`/ping`, `/invocations`) whose storage was session
storage at `/mnt/data`, in `ap-southeast-1`:

| Question | Measured | So the implementation |
|---|---|---|
| What session storage is | NFSv4.0 at `127.0.0.1:/export`, `local_lock=none`, `nocto`, attribute caching of 3600 s; `statfs` reports 1 GiB | Plans for the 1 GB limit (images are inline in entries) |
| SQLite on it | With its default locks, every journal mode fails, `database is locked`, so `openNodeSqliteStorage(path)` fails on its first open. `file:<path>?vfs=unix-dotfile` with `locking_mode = EXCLUSIVE` then `journal_mode = WAL` works, opened as a `DatabaseSync` and passed through `NodeSqliteDatabase` to `SqliteStorage.open`, and a second process opening it fails with `database is locked`. `vfs=unix-none` works too, but a second process's writes were accepted and then lost. `flock` works: a second taker is refused. pi-durable's JSONL storage works, holding its whole history in memory | Opens the database itself with `unix-dotfile`, EXCLUSIVE and WAL, under the lease (§4.3) |
| A dotfile lock across a stop | A connection holding the lock when `StopRuntimeSession` came left `<path>.lock` behind; the next microVM's open failed with `database is locked` until the lock was removed, and then read the row committed before the stop | Breaks a stale lock under the lease, and logs it (§4.3) |
| A run cut off by `StopRuntimeSession` | The microVM stops at once (the tool's writes stop); nothing runs while the session is not invoked; the next invocation gets a new microVM in about 2 s with the storage and the incarnation as they were, and pi-durable carries on: the cut-off tool is not run again but answered as interrupted, the message is answered, and the one queued behind it too | Opens the storage and calls `harness.resume()` when each process starts, before it handles the invocation (§4.3) |
| Idle timeout (120 s) during a 200 s tool | `/ping` answering `HealthyBusy` kept the session: the tool ran to its end on the same microVM | Answers `HealthyBusy` while a run is live |

The coding tools' `read` reading a skill's `SKILL.md` through a `NodeExecutionEnv` rooted at the agent's directory was
checked with the definition's assembly (test/durable-definition.test.ts): the model's answer carries the file's text.

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
joined mid-way (as ACP's resume and OpenAI's sequence numbers allow).

It did not take: a run, turn or task as a first-class id (messages are the unit); history owned by the client and sent
with each run (AG-UI; here the Agent owns it); shared-state JSON patches, plans and modes (agent-specific, so prefixed
custom events); a file system and terminal the client provides (ACP; this agent runs server-side in its own
environment); closing and deleting sessions, and a tenant field. Asking the user, a webhook when a message ends (A2A, OpenAI's background mode) and a live
notice event (ACP) can be added later under the API's rules for extending, without breaking a Caller. Its HTTP binding is
its own ([agent-api.md](agent-api.md) §9); A2A and MCP bindings map onto the same model and are designed when a Caller
needs one.

## 8. Settled in the move

- Reloading in `dev`: the definition's text (`SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`) is read for every
  message, and an edit to its code (`src/`, the configuration, `package.json`) restarts the `dev` worker.
- Bun: it ships `node:sqlite` from 1.4.0, so pi-durable's Node adapter serves it too, and 1.4.0 is the floor.
