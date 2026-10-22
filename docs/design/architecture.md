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
| 5 | Concurrent writers to one context; agents calling agents | Later (§4.5) |

None of these asks FastAgent to define how a harness queues, steers or records messages. The previous design did:
a harness-neutral protocol, a harness port, and `LoopPort`, which gave pi-coding-agent the queue, idempotency and
message records pi-durable has natively. Building pi-durable's port on that protocol then meant reconstructing facts
it does not keep. That work standardized the part harnesses differ on most and change fastest, for a neutrality no
goal needs.

## 2. Decisions

| Decision | Why |
|---|---|
| **One harness: pi-durable.** No harness port, no adapters, no capabilities | It keeps what serving needs natively (admission with `whenBusy`, idempotency by request id, a durable outcome per submission, continuation after a restart) and its storage and execution environment are replaceable, which is what serverless and microVM hosts need. A second harness would cost its own adapter, so neutrality is not designed for in advance |
| **One API of our own: the consumer [Agent API](agent-api.md)**, bound in TypeScript and over HTTP | Every consumer, ours included (channels, schedules, wake-ups, the REPL), needs the same operations. It is also the layer that keeps pi-durable's experimental API and internal entry kinds away from clients |
| **Everything else is pi-durable's own API**, as `agent.harness` in the process that runs the agent | Operating an agent (its definition, compaction, inspecting sessions) has one implementation; wrapping it would only rename it. A session's model and thinking level are a consumer's choice, at creation, at a fork, or later with `configure`, which is pi-durable's `configure()` with those two fields: a Caller who may use a session may choose what it answers with, and who may use one is the access policy's ([agent-api.md](agent-api.md) §8). A developer who needs more of the harness over HTTP adds a route that calls it |
| **Access is a key, a role, and who created a session** | An owner and the guests it invites share one instance, as duang's online contacts do: the owner reaches every session, a guest the sessions it created, and a request is one of them by the key it holds (§4.4). A key is held, not proven to be someone, so an invitation is "whoever holds this", revocable, with no identity provider. The rule is one policy the Agent applies to every operation ([agent-api.md](agent-api.md) §8), so isolation does not depend on a facade parsing each request, where a fork's source or an invoke without a session is easy to miss |
| **The Agent names sessions; Callers remember them** | pi-durable mints conversation ids and cannot take a Caller's. A channel or a schedule keeps its own mapping (a chat or a thread to its session, a schedule to its session) in its own state, as it already keeps other state. The rule that keeps a mapping single is below the table |
| **Ids are encoded, never reused** | pi-durable's ids are one counter per storage, starting again from 2 in a new one, and a deploy can replace the storage (AgentCore resets its session storage; a volume can be rebuilt). An id the Agent hands out is the storage's incarnation, a random id minted when the storage is created, followed by pi-durable's id: sessions, messages and entries alike. An id kept from a storage that is gone is then `not_found` instead of someone else's conversation, and an id says which storage it belongs to, which routing across several storages needs. It is an encoding, not a lookup: nothing is stored to map one id to another. One loss it cannot cover: a storage that rolls back its newest commits keeps its incarnation, so the ids of what was rolled back are handed out again; AgentCore after a host failure is the case, accepted there (§4.3) |
| **Sessions are listed per principal; none is deleted** | A client returns to its conversations from another machine, and an owner finds its channels' and schedules' sessions. A list of every session would show each guest everyone's; a list of what the principal may reach shows nothing it could not already read. pi-durable has no deletion |
| **An agent is a standard npm and TypeScript package** (§3) | The artifact is an npm package (§4.1), and an agent must be a value other code can import: an app that embeds it, a deploy by package name and version, another agent that depends on it |
| **One configuration file, `fastagent.config.ts`, with `defineAgent()`; every field optional** | It is the `defineConfig` pattern of Vite and its peers: typed, and read by the build. The model, thinking level and tools it names are defaults: a deployment overrides them with a flag or an environment variable, and a session with pi-durable's own API |
| **Code is registered by where it is, at build time**: `src/tools/`, `src/extensions/`, `src/channels/`, `src/schedules/` | `fastagent dev` and `build` generate a registry of plain imports, as TanStack Router's route tree and Next.js's route manifest are generated: nothing to import by hand, full types, and a bundler can follow it. Not a scan at run time (no types, no bundling, a loader to keep), and not `import.meta.glob`, which only Vite understands while `dev` runs on Node |
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

The previous design's pi-coding-agent harness goes with it: pi's `extensions/` and `.pi/`, `APPEND_SYSTEM.md`, the
`chat` TUI (replaced by a REPL over the consumer API), and the skills and prompt templates a machine lends from
`~/.pi/agent`.

A consumer may choose a session's model and thinking level with `createSession({ model, thinkingLevel, from? })`,
passed to pi-durable's creation options in the same commit. A fork inherits the settings at its branch point and
applies the supplied overrides. `configure` changes them later, from the session's next model request, and the
session's state reads them back. `invoke` uses those settings and accepts no per-message model choice. A session that
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
  http: { cors: ["https://app.example.com"] },
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
the agent's commands ([Agent API](agent-api.md) §3). The result is the Agent
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

### 4.4 Access

The Agent API authorizes every operation by its principal ([agent-api.md](agent-api.md) §8): the owner reaches every
session, a guest the sessions it created. Serving decides who a request is, by the key it carries. A key is held, not
proven to be someone: whoever holds a guest's key is that guest, which is what an invitation is, revocable and in need
of no identity provider. duang's online contacts are what it is for: an owner's own instance, and the people the owner
invites to it.

- **The owner's keys** are the secret `FASTAGENT_OWNER_KEYS`: one or more, separated by commas, so that a new key can
  replace an old one without a gap. Each acts as `{ id: "owner", role: "owner" }`. It is declared like every secret,
  so `deploy` checks that it is set.
- **A guest's key is issued while the agent runs**, by the owner, so inviting and revoking need no deploy. Each guest
  has an id of its own, never reused, and the label the owner gave it. A key is `fa_` followed by 32 random bytes in
  base64url, a prefix secret scanners can match. It is shown once, when it is issued; only its SHA-256 hash is kept, in
  the instance's storage beside its conversations.
- **The key routes** are the owner's; a guest is refused `403` `forbidden`:

  | Route | Does |
  |---|---|
  | `POST /keys` with `{ label }` | Issues a guest's key: `201` and `{ id, label, key }` |
  | `GET /keys` | The guests: `200` and `{ keys: [{ id, label, createdAt }] }` |
  | `DELETE /keys/{id}` | Revokes it: `200` and `{}`. A request with it is `401` from then on. The guest's sessions stay, and the owner still reaches them; the messages it sent go on unless the owner aborts them |

- **Without an owner key**, a serve that can be reached from elsewhere does not open itself, and refuses only what
  lacks a key, saying how to set one, as Redis's protected mode and Docker's daemon do. A deployment that serves only
  channels needs no key, and is not stopped for lacking one:

  | Serving | Without `FASTAGENT_OWNER_KEYS` |
  |---|---|
  | `dev`, bound to loopback | A request without a key acts as the owner, and the startup report says so |
  | Any other bind, `dev --tunnel`, `start`, a deployment | Every API request without a key is `401`, saying how to set one. Channels, schedules and wake-ups serve as usual; the startup report and `deploy`'s pre-flight say the API is closed |
  | `http.auth: "none"` in the deployment's configuration | A request without a key acts as the owner: for a deployment whose network or gateway decides who reaches it. The startup report lists the API as public |

  With an owner key set, every request needs a key, wherever it is served, and `http.auth: "none"` beside it is refused
  at start. A request with a key acts as that key's principal, or is `401`.
- **AgentCore** carries the API as `api` envelopes through `InvokeAgentRuntime`, and IAM decides who may send them:
  they act as the owner. A guest has no door there, and the storage that would keep its key is reset by every deploy
  (§4.3).
- **An embedder** gives `createAgentApiHandler(agent, { authenticate })` the function that maps a request to a
  principal or refuses it, and must: there is no default. FastAgent's keys are one such function. An app with its own
  sign-in maps each of its users to a guest whose id is its user id, and needs no facade in front.
- **Not here: limits per guest.** A guest, or whoever holds its key, spends the owner's model account until the key is
  revoked. A key is replaced by revoking it and issuing another, which is another guest: the sessions of the first
  remain the owner's to read.

### 4.5 Later: shared contexts and agents working together

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
| Extensions an agent writes for itself, live on its next session | A build and a deployment, as for any code (§3) |
| Schedules an agent writes for itself, live within 30 seconds | `wake`'s recurring form, kept in the instance's state (§3) |
| A thread's Caller-named session, whose existence records that the room was forked ([participant-model.md](participant-model.md) rungs 3 and 4) | The thread's session id, recorded in the channel's state after `createSession` forks the room, in the order and place of §2. The branch point is still found by key (`getMessage` with the platform's message id) |
| [agent-service.md](agent-service.md) §3.6 and §7 to §14, [conformance-levels.md](conformance-levels.md) | This note and the Agent API |

## 6. Order

1. **A spike on pi-durable**, on 1.3.0, locally and on AgentCore (§6.1).
2. The Agent on pi-durable, with the conformance suite in process and over HTTP; channels, schedules, wake-ups, the CLI
   and AgentCore moved onto it; the previous protocol, `LoopPort` and the pi-coding-agent harness deleted.
3. The artifact: `fastagent build`, and `deploy` from it.
4. Context packages.
5. Shared contexts and agents working together.

### 6.1 What the spike measured

On pi-durable 1.3.0 with pi-ai's faux model, in process, against memory and SQLite storage:

| Question | Measured | So the implementation |
|---|---|---|
| The definition rendered | `SYSTEM.md`, `AGENTS.md` and the skill list render as an extension's prompt sections, and pi-durable adds no prompt of its own; a tool made by `needs([...])` around pi-durable's `defineTool` receives its secret | Installs one extension of FastAgent's own with those sections, beside the agent's tools and extensions |
| A command kept as sent | An input submitted with the expanded text as `content` and `entry: { kind: "fastagent.user", data: { content: <as sent> } }` is recorded with that kind and data, while the model sees `content` | Submits every message that way, and publishes `fastagent.user` as `user_message` |
| Images | Stored inline, as base64, in the entry's model message; there is no separate blob store | `attachment(ref)` reads from the entry: a ref names the entry and the part. Images grow the storage |
| An answer being written | Its text so far is in `pi.live.generation.message`, and in a new `watchEvents` stream's snapshot, with its attempt number; its entry gets an id only when the answer is complete | `state.reply` is that text and `message_delta` carries no entry id ([Agent API](agent-api.md) §6) |
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
environment); closing and deleting sessions, and a tenant field; JSON-RPC as the transport (REST and SSE serve
web consumers more simply). Asking the user, a webhook when a message ends (A2A, OpenAI's background mode) and a live
notice event (ACP) can be added later under the API's rules for extending, without breaking a Caller. Bindings to
those protocols are outside the product's goals.

## 8. Open

Settled when they are implemented:

- Owner routes for a remote instance's schedules and how each fire ended, which duang asks for: today only the
  process that serves them, and `fastagent schedules list` on its host, can read them.
- Hot reload in `dev`: the definition is read on every invoke today; pi-durable installs extensions in a registry.
- Bun: pi-durable's portable SQLite core runs there given an adapter over `bun:sqlite`, which does not exist yet.
