---
title: Agent service
description: "Proposed: FastAgent for teams that build, run and use a set of agents together as cloud services. The product loop, the world an agent acts in (environment, contexts, connectors), credentials, invoke as a durable unit of work, the interfaces, the architecture, and deployment."
type: design-doc
status: proposed
---

# Agent service

**Status: proposed, not implemented.** It extends the [agent model](agent-model.md), changes the
[Agent Handler SPEC](../SPEC.md) (§7.6 lists the sections), and answers
[#688](https://github.com/fastagent-sh/fastagent/issues/688) (what `Scope` means). §14 lists the decisions already
made in review; everything else is a proposal to settle before implementation.

Three things are hard, and this design spends itself on them:

1. **Durable work.** Work that is nondeterministic, has side effects and arrives from many entry points must outlive
   a connection, a restart and a deploy.
2. **A definition two parties change.** People and the agent itself edit an agent, and every change must be
   reviewable and revertible.
3. **The agent's world on a host.** The environment it runs in, the contexts and connectors it uses, and the
   credentials each of them needs must be reproduced in the cloud.

Models, the agent loop and hosting are not on the list: FastAgent uses existing ones.

## 1. Who it is for

Teams that build and maintain a set of agents together, run them in the cloud continuously, and use them from where
they already work: chat, their own apps, other agents.

| Need | Means |
|---|---|
| Develop together | An agent is a directory in git. Every change to it, including the agent's own, can be reviewed and reverted |
| Use together | Members reach the agents from team channels and apps, and who asked matters |
| Run continuously | Work outlives a connection, a restart and a deploy |
| Share infrastructure | The knowledge, code and integrations a team's agents work with are shared, not copied |

| Role | Does | Through |
|---|---|---|
| Builder | Writes, tests and ships agents, often through a coding agent | The directory and the CLI |
| Member | Hands work to agents and follows it | Team chat, the team's own apps, clients such as duang |
| Operator | Deploys, watches and rolls back; in a small team, the builder | The CLI and the host's console |
| The agent | Changes its own definition and writes to writable contexts | Its own directory |

Outside FastAgent:

- a unit above agents: a team, its members, shared secrets, one deployment target. Sharing happens through the
  contexts and connectors that several agents declare;
- the model and the agent loop, which a harness provides (§9.1);
- a hosting platform of its own: agents deploy to existing hosts (§10);
- waiting states for human input: steering, follow-ups and aborting cover it.

## 2. The loop

```text
init → dev (locally, on the team's channels) → deploy → the team uses it
  ↑                                                         │
  └──── review and merge ←── a change, by a person or the agent
```

- Git is the only source of a deploy. A deploy is a commit, and a rollback deploys an earlier one.
- What an agent changes in its own directory must reach git as a pull request, so the team sees and reviews it.
  Today a deploy replaces the definition on the box, and what the agent changed there is lost;
  [#605](https://github.com/fastagent-sh/fastagent/issues/605) designs how the change returns to git first.

## 3. The model

```text
Agent = model + harness + definition    who it is and how it works (identity, behavior, skills, tools)
  runs in        Environment            compute
  works on       Contexts               state
  acts through   Connectors             effects
  remembers in   Sessions               conversations
  started by     Triggers               requests, messages, events, time, itself
```

### 3.1 Why three: every action has three parts

Everything an agent does outside its model is an action: a tool call. An action has exactly three parts: **where it
executes**, **which state it reads or changes**, and **which other system it affects**. A skill script, for example,
runs `git` in the environment, edits files in a context, and opens a ticket through a connector. So these three cover
everything an agent touches, and they do not overlap.

| | Environment | Context | Connector |
|---|---|---|---|
| Is | Compute: the agent's body | State the team owns | Another system's operations |
| Examples | node 22, git, ffmpeg, a sandbox | A directory, a git repository, an S3 bucket used as a workspace | GitHub issues, Jira, email, payments, a company API, an MCP server |
| Lifetime | Disposable; rebuilt from its declaration | Persistent and versioned | The other system's |
| A write can be undone | Holds no durable data | Yes: it has history, and it can be reviewed and reverted | Often not: a sent email, a payment |
| Access | None needed | Read and write, plus the credentials to sync it | Authority delegated per action (OAuth, API keys), scoped |
| Credentials (§6) | Supplied at start, never built in; declared by the commands that read them | Declared by the context | Declared by the connector |
| Shared across a team's agents | The declaration; each agent runs its own instance | The same state: a team asset | The same integration, with per-agent scopes |
| Fails as | A missing command, said at start | Unreachable, or a conflicting write | Authorization, rate limits, an effect whose outcome is unknown |

Three invariants follow:

1. **An environment is reproducible.** It is rebuilt from its declaration and holds no durable data. Credentials are
   supplied when it starts and never built into it.
2. **A context is stateful and versioned.** Long-term memory and work products live there, where people can review
   and revert them.
3. **A connector is an external effect.** It may not be repeatable, so the service never repeats one behind the
   caller's back (§9.3), and its authority is scoped per agent. Merging connectors into contexts would govern a
   payment like a file edit, or a file edit like a payment.

### 3.2 Context or connector: the test

Local or remote does not separate the two, and neither does storage or API: S3 is an API, and GitHub has both files
and issues. Ownership and reversibility do. Two questions:

1. Can the agent work on the data directly, with generic operations (list, read, write, compare), and see all of it?
2. Can the team review and revert what the agent writes?

Yes to both: a context. Otherwise: a connector. One system can provide both.

| Example | Is | Because |
|---|---|---|
| The files of a git repository | Context | Generic reads and writes, with history |
| GitHub issues, pull requests, comments | Connector | Reached only through GitHub's API; what is posted is an external effect |
| A team's own S3 bucket used as a workspace | Context | Generic get, put and list, and the team owns it |
| Notion or Google Drive used through their API | Connector | Synced to files, the same content is a context |
| A production database behind a business API | Connector | The state and its rules belong to the other system |
| Feishu, Slack | The channel is a trigger; the agent's send tool is a connector | One system, two relationships |

Knowledge and long-term memory prefer file contexts, such as markdown in git: people can read, review and revert
them, and they travel with a deployment. A memory service such as a vector store is a connector.

### 3.3 What knowledge, memory, skills and tools are

They are uses of the three, not further categories.

| Term | Is |
|---|---|
| Knowledge | Reading contexts, and querying connectors (a search) |
| Memory | Long-term: writing to a writable context. A conversation's: its session (§3.5) |
| Skill | Know-how stored in a context, executed in the environment, possibly calling connectors |
| Tool | How an action is presented to the model. `read`, `write` and `bash` act on the environment and contexts; MCP tools and code tools are usually connectors |

### 3.4 The agent's own directory

An agent's directory is both its definition and its first, writable context. This is where it improves itself
([#605](https://github.com/fastagent-sh/fastagent/issues/605)): what an agent changes in itself is versioned and
reviewable like any other context (§2).

### 3.5 Sessions and triggers

A **session** is a conversation's continuity: the invokes of one session share its history. It is named by the
caller, optional on `invoke` (§7.2), and may start as a fork of another session. A session is a conversation's
memory; what should outlast a conversation belongs in a context.

A **trigger** is where an invoke comes from: a request (HTTP, another agent), a message (a channel), an event (a
webhook), time (a schedule), or the agent itself (`wake`, a subagent). A channel is a trigger and a connector of one
system: messages arrive through it, and the agent's send tool posts through it.

## 4. The environment is declared

Today an agent inherits the machine it runs on, the way `bash` inherits the `PATH`, and nothing compares that machine
with a deployment; `deploy.apt` only adds apt packages to the generated image. A team's cloud agents need a
reproducible environment:

- the definition declares what it needs: commands (`git`, `ffmpeg`) and runtimes (node 22, python);
- `dev` checks the machine against it and says what is missing at start;
- `deploy` installs it into the image;
- a context may declare its own needs (a repository that requires node 22), and the agent's environment is the union
  of its own declaration and its contexts', the way contexts already contribute skills.

A possible shape, to settle (§13):

```ts
export default {
  environment: {
    commands: ["git", "gh", "rg"],   // checked by dev and at start: each must be on PATH
    apt: ["gh", "ripgrep"],          // how deploy installs what the base image lacks (today's deploy.apt)
    secrets: ["GH_TOKEN"],           // what those commands read from the environment (§6.1)
  },
};
```

This reverses a working rule: "the machine lends the agent an environment" in AGENTS.md, "the machine is an
environment, not a dependency" in [principles.md](../principles.md), and "nobody is told their local `ffmpeg` is not
in the image". Both change when this is implemented.

## 5. Connectors are declared

Today a connector is a code tool in `tools/` or a channel's send tool. Pi's MCP extension is not loaded when serving,
because its server connections live as long as a session and a served session lives one turn
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). Proposed:

- connectors are declared in the definition beside contexts: MCP servers here, and the code tools in `tools/`, which
  already declare what they need;
- each connector declares its credential (§6);
- an MCP connection lives as long as the process or the conversation, not one turn, which is #678.

## 6. Credentials

A credential is proof of authority over another system. Three questions decide how one is handled:

1. **Who uses it**: the model's provider client, a tool's code, a channel, a connector, git for a context, or a
   command the agent runs in its environment. The model itself never needs one.
2. **How it is obtained**: as a value, as an interactive grant, or from the host's own identity.
3. **On whose authority**: the agent's own, or the member who asked.

### 6.1 Declared by what uses it

Every credential is declared next to the thing that uses it, the way `defineTool` and `defineChannel` declare
`secrets` today.

| Used by | Declared as | Today |
|---|---|---|
| The model's provider | `model`, then its provider's env key or a `login` grant | Exists |
| A code tool | `defineTool({ secrets })` | Exists |
| A channel | `defineChannel({ secrets })` | Exists |
| A context | Its kind's credential: a `github` context reads `GITHUB_TOKEN` after git's own helpers, and may name another variable | Read; `deploy` notes when it is missing; not declared |
| A connector | `auth`: a value (`{ bearer: "LINEAR_API_KEY" }`) or a grant (`"login"`) | No connectors yet |
| Commands in the environment (`gh`, `aws`) | `environment.secrets` | Read from the process environment; not declared |

A declaration does what it does for tools and channels today:

- it makes the value required: a serving path refuses to start without it and names the file that declared it, and
  `deploy` refuses before its first side effect;
- it attributes the value: runbooks and `info` say which part needs which name, and whether it is set, never the value;
- for code, it hands the value back to the code that declared it, so the read cannot drift from the declaration.

### 6.2 Stored by how it is obtained

| Obtained as | Examples | Stored | Provided locally | On a deployed host | Renewed |
|---|---|---|---|---|---|
| A value | API keys, bot tokens, signing secrets, a GitHub App's private key | `.secrets/.env`, by env-var name | Written by the author, or by `add <channel>` | `deploy` carries the value file | Rotated by hand |
| A grant | OAuth to a model subscription or an MCP server | `.secrets/auth.json`, by provider or connector name | `fastagent login <name>` | `fastagent login <name> --deployment <host>` runs the flow on the box | Refreshed in place by the runtime |
| The host's identity | An IAM role on AgentCore | Nothing | The author's own cloud login | `deploy` grants the permission to the host's role | By the host |

- Values keep env-var names because every SDK and CLI reads them (`GITHUB_TOKEN`, `OPENAI_API_KEY`). Two
  declarations of one name share one value; two parts that need different values declare different names
  (`ACME_GITHUB_TOKEN`).
- Grants exist today for model providers, including the machine-wide store `login -g` writes. Connectors reuse the
  same flow and the same file.
- The host's identity is not supported yet. It is listed because it completes the three ways a credential is
  obtained.

### 6.3 On whose authority

Every credential today carries the agent's own authority: a bot, a service account, a team token. Acting as the member
who asked (their calendar, their mailbox) needs a consent flow started from a channel and grants stored per
principal. It builds on `principal` (§9.5) and is designed when a use needs it.

### 6.4 The trust boundary

Today the agent's shell runs on the same box, as the same user, as the service that holds the credentials. The agent
can read every value and grant there (`cat .secrets/.env` works whatever the shell's environment holds), and so can
whoever steers it through a prompt injection. Removing values from the shell's environment would break the commands
that read them and protect nothing, so the shell keeps inheriting the process environment.

Isolation needs a boundary: the environment in a sandbox that holds no credentials, and the calls that need one made by
the service outside it. That is a later level, on the harness's execution-environment seam (pi-durable runs its
built-in tools through a pluggable `ExecutionEnv`). The declarations in §6.1 already name what would cross the
boundary: `environment.secrets`.

Until then, give an agent only credentials you would hand it directly, scoped as narrowly as the other system allows:
fine-grained, and read-only where possible.

## 7. Invoke

`invoke(scope, prompt)` keeps its name and its shape, and it stays the only way to start work. What one invoke means
changes: it becomes a durable unit of work, an **invocation**, which the service owns once it accepts it.

### 7.1 What changes

| | Today | Proposed |
|---|---|---|
| Ownership | A caller that stops reading aborts the work (SPEC MUST 3) | Once accepted, the work is the service's. A dropped connection detaches; `cancel` stops the work |
| Identity | None on the data plane; the observation plane reports a `runId` | The service mints an invocation id and reports it in the first event. It is the run id the observation plane already reports |
| Reattach | Impossible | Any client attaches by id, from a cursor |
| Retries | A retry can run the work twice | `idempotencyKey`: the same key returns the same invocation |
| A busy session | Fails with `session_busy`. Channels queue their own turns and poll while another caller's run holds the session; schedules skip; wake-ups retry | The invoke says what its message is: `followUp` (the default) runs it next, `steer` joins the running invocation, `reject` answers `busy` (§7.4) |
| How it ends | Two terminal events, `completed` and `failed` | One `settled` event: the outcome and the usage |

Steering and following up become ways to invoke (§7.4); aborting stays.

### 7.2 Scope

```ts
interface Agent {
  invoke(scope: Scope, prompt: Prompt, options?: InvokeOptions): Invocation;
}

/** Facts the caller asserts about this invoke. Never a choice among the agent's options. */
interface Scope {
  /** The conversation to continue. Absent: a new one, named in the `accepted` event. */
  session?: string;
  /** Where a new session starts. Applied when the session has no turns yet; `at` is an entry id the service gave out. */
  fork?: { from: string; at?: string };
  /** Who is asking, as the entry point (a channel, a trusted gateway) authenticated them (§9.5). */
  principal?: Principal;
}

interface InvokeOptions {
  idempotencyKey?: string;
  /** What this message is when the session is running another invocation (§7.4). Default: "followUp". */
  whenBusy?: "followUp" | "steer" | "reject";
}

/**
 * Begins with `accepted` (the invocation id, the session, and whether it runs now, waits as a follow-up, or joined the
 * running invocation) and ends with `settled`.
 */
type Invocation = AsyncIterable<InvokeEvent>;
```

- **Facts, not choices.** Choices among the agent's options, such as a session's model and thinking level, are session
  properties set on the control plane, where the options can be listed (`models()`).
- **Whoever creates a thing names it.** Callers name sessions, because they map their places to conversations. The
  service names invocations and entries, and a session it creates for a caller that named none, and gives the names
  back: an entry id comes from a settled outcome's `leafEntryId` or from `entries()`.

### 7.3 Outcome, events, errors

```ts
/** The `settled` event's data. */
interface Settled {
  outcome: Outcome;
  /** What the run spent, as the harness reports it: tokens and cost. */
  usage: Usage;
}

type Outcome =
  | { status: "completed"; leafEntryId: string; result?: Json }
  | { status: "failed"; error: AgentError; leafEntryId?: string }
  | { status: "canceled"; leafEntryId?: string }
  | { status: "rejected"; error: AgentError };        // nothing ran and nothing was recorded

interface AgentError {
  code: string;        // stable and machine-readable
  message: string;
  retryable: boolean;  // whether the same request may succeed if sent again
  details?: Json;
}
```

`rejected` and `failed` are separate on purpose: a rejected invoke is safe to send again, while a failed one may have
recorded entries or run tools. A rejected invoke never becomes an invocation: its stream is a single `settled`, with
no `accepted`, and over HTTP it is an error status instead of a stream.

One event vocabulary serves the invocation's stream and a session's observation stream, so the same thing has one
name in both. Proposed: `accepted`, `user_message`, `text_delta`, `thinking_delta`, `message_finished`,
`tool_started`, `tool_progress`, `tool_finished`, `queue_changed` (the session's pending follow-ups and the running invocation's steering messages),
`retry_scheduled` and `settled`; a session's stream adds `state_changed` and the compaction events.

Proposed error codes, one set for every call: `invalid_request`, `unsupported`, `not_found`, `busy` (its `details`
carry the running invocation's id), `no_active_run`, `nothing_to_compact`, `missing_model`, `auth_required`,
`model_error`, `interrupted` (§9.3), `partial_update`, `unavailable`, `internal`. An engine may add codes under its
own prefix; a client that meets an unknown code acts on `retryable`.

### 7.4 A busy session

A session runs one invocation at a time, because each turn extends the history the next one reads. What a message that
arrives meanwhile means (an addition, a correction, or something that only makes sense right now) is the caller's to
say, on each invoke:

| `whenBusy` | When the session is running another invocation |
|---|---|
| `followUp` (the default) | Accepted and pending. It runs as the session's next invocation when the running one ends, in arrival order |
| `steer` | Joins the running invocation after its current tool round. The invoke returns that invocation, from this point on |
| `reject` | Rejected with `busy` (retryable; nothing ran and nothing was recorded), carrying the running invocation's id |

An idle session runs the invoke at once, whatever `whenBusy` says. pi's SDK refuses a prompt to a busy session that
does not say which, rather than guess; pi-durable's `submit` offers the same three choices and defaults to a
follow-up, and so does this, because a follow-up never disturbs work already running.

The service decides, because only it can decide without a race: a caller that hears `busy` and then follows up can
find the run ended in between, and every caller would write its own wait loop, as channels and wake-ups each do today.

What the service holds stays small. Pending follow-ups are kept in memory beside the running invocation and share the
process's fate: a restart settles them `interrupted`, with nothing run (§9.3). There is no durable queue, no recovery,
and nothing to coordinate across instances.

- When an invocation settles, however it ended, the session's next pending follow-up starts.
- `cancel(id)` stops one invocation: a running one is aborted, a pending one is withdrawn.
- A session's `abort`, which a chat's stop command calls, stops the running invocation and withdraws every pending
  one, the way pi's own abort returns queued messages to the editor.
- A steer's message is recorded as a user entry with its own principal. The run's usage stays with the invocation it
  joined, so nothing is counted twice.
- A session whose run another process holds cannot be followed or steered from this one: the invoke is rejected with
  `busy`, whatever `whenBusy` says. That is rare, with one process per agent or one microVM per session.

`steer` and `followUp` leave the session control plane: `invoke` becomes the one way to hand a session a message.

| Caller | `whenBusy` | What changes |
|---|---|---|
| Channels | `followUp`; a channel may offer `steer` | Their busy wait, which polls every 5 seconds, goes. Whether they keep their own queue (`turn-queue`) is decided in step 3 (§12) by what it removes; their turn store stays, because it is what they owe the chat |
| Schedules | `reject` | Nothing: an occurrence on a busy session is skipped |
| Wake-ups | `followUp` | One that fires into a busy session runs right after the running invocation, instead of retrying |
| duang and other clients | Their choice | `session.steer` becomes `invoke` with `steer` |

### 7.5 Control plane

Added, by invocation: `attach(id, { after? })`, `cancel(id)` and a list of invocations by session and status, so a team
can see what its agents are doing and what it cost. A caller that stops reading detaches; only `cancel` stops the
work. The session operations (`state`, `entries`, `update`, `abort`, `compact`, `fork`, `delete`) are unchanged, except
that `abort` also withdraws pending follow-ups; `steer` and `followUp` become `invoke` options (§7.4).

### 7.6 SPEC changes (v1)

| Section | Change |
|---|---|
| §2 | `invoke` returns an invocation stream that begins with `accepted`; accepted work belongs to the service |
| §3 | The `Scope` rule (facts, never choices); `session` optional; `fork`; `principal` |
| §5 | The event vocabulary above; one terminal event, `settled` |
| §6 | MUST 1 becomes "exactly one `settled`". MUST 3 changes: a caller that stops reading detaches, and `cancel` stops the work. Portable conformance is unchanged |
| §8 | The lineage, identity and source rows are replaced by §7.2 |
| New | The harness port (§9.1): what an engine implements, beside what a caller uses |

## 8. Interfaces

Every interface ends in one operation, `invoke` (§7).

### 8.1 The directory

The directory is the only source of an agent.

```text
my-agent/
  SYSTEM.md · APPEND_SYSTEM.md · AGENTS.md   identity and behavior
  skills/ · prompts/                          know-how
  tools/                                      code tools
  extensions/                                 pi extensions
  channels/                                   triggers: messages
  schedules/<name>.md                         triggers: time
  fastagent.config.ts                         the model, the agent's world, serving and deploy options
  .secrets/ · .state/ · .contexts/            machinery, never in git
```

Behavior is written in markdown, code in `tools/` and `channels/`, and the agent's world is declared in the config.
The shapes of `environment` and `connectors` are drafts (§13):

```ts
export default {
  model: "openai-codex/gpt-5.5",
  environment: { commands: ["git", "gh"], apt: ["gh"], secrets: ["GH_TOKEN"] },
  contexts: [{ github: "acme/handbook", readonly: true }, { github: "acme/app" }],
  connectors: [{ mcp: "linear", url: "https://mcp.linear.app/mcp", auth: "login" }],
} satisfies FastagentConfig;
```

### 8.2 The CLI

| Stage | Today | Proposed |
|---|---|---|
| Create | `init`, `add <channel>`, `add skill`, `context add/list/remove` | `connector add/list/remove` |
| Develop | `dev`, `chat`, `invoke`, `tool`, `info`, `models` | `dev` and `info` check the environment; `invoke --session`, `--when-busy`, `--detach`, and `--url` for a running agent; `invocations` (list, attach, cancel) |
| Ship | `deploy <host>`, `login [--deployment <host>]` | `deploy` builds the environment into the image; `login <connector>` for a connector's grant |
| Operate | `start`, `logs`, `destroy`, `schedules list` | `invocations --url` for a deployed agent: what it is doing and what it cost |

### 8.3 In code

An agent opened in this process (`createAgentService`) and one reached over HTTP (`connectAgent`) present the same
interface. Today the remote side is two clients, `connectAgent` and `connectSessionControl`; they become one.

```ts
type InvocationStatus = "pending" | "running" | "completed" | "failed" | "canceled";

interface Agent {
  invoke(scope: Scope, prompt: Prompt, options?: InvokeOptions): Invocation;
  invocations: {
    attach(id: string, options?: { after?: string }): Invocation;
    cancel(id: string): Promise<{ ok: true } | { ok: false; error: AgentError }>;
    list(query?: { session?: string; status?: InvocationStatus[] }): Promise<InvocationSummary[]>;
  };
  sessions: SessionControl;   // unchanged by this proposal
}
```

### 8.4 HTTP

| Route | Does | Served |
|---|---|---|
| `POST /invoke` | Starts work: SSE whose first event is `accepted`. A rejected invoke answers with an error status. The key goes in `Idempotency-Key`, `whenBusy` in the body | With `http.invoke` (on by default) |
| `GET /invocations/{id}/events?after=` | Attaches from a cursor | With `/invoke`: the id cannot be guessed, and holding it is the permission |
| `POST /invocations/{id}/cancel` | Cancels | With `/invoke` |
| `GET /invocations?session=&status=` | Lists what is running and what finished | With `/control/*` (`sessionControl`) |
| `/control/sessions/*` | Session control | Unchanged |

### 8.5 Channels

A channel turns a platform message into an invoke:

| From the message | To |
|---|---|
| The place it was posted (a chat, a thread) | `session` |
| Where a thread began | `fork` |
| The platform account that posted it | `principal` |
| The platform message id | `idempotencyKey` |

Channels keep their turn store and their redelivery dedup; whether they keep their own queue is decided in step 3
(§7.4).

### 8.6 Clients

A client such as duang shows conversations by session and a work list by invocation: what is running, what finished,
and what it cost. Clients live outside this repository.

## 9. Architecture

### 9.1 Two contracts: the agent and the harness

```text
Callers ──► Agent (SPEC v1)      invoke → invocation; invocations; sessions
              │  the invocation layer: ids, idempotency, busy, attach, cancel, settle. Written once
              ▼
            Harness (the port)   run one turn on a session; the session operations
              │
              ▼
            pi today; pi-durable, the Claude Agent SDK or Codex later
```

The agent's semantics are written once, above a port that a harness implements. Two ways to place them:

| | A: the invocation layer above a harness port | B: each harness implements invocations |
|---|---|---|
| Invocation semantics | Written once, the same on every harness | Written per harness, and the copies drift |
| A harness without durability, which is most of them | Works as it is | Needs the same layer written for it anyway |
| A durable harness (pi-durable) | Plugs in below; its recovery from a checkpoint is added to the port when it is designed | Fits directly |

A wins. Today's `Agent`, where `invoke` runs one turn and a caller that stops reading aborts it, plus the session
control plane, is already close to the port: the pi implementation and its conformance suite become the first
harness, and the invocation layer is new code above them. The port's turn operation gets its own name (`run`), so
`invoke` keeps one meaning. Follow-ups are the layer's, run as the next turn, so for a running turn the port needs only
`steer` and `abort`.

### 9.2 Layers

```text
Entry points    CLI · SDK · HTTP/SSE · channels · schedules · wake
                  ↓ every one calls invoke(scope, prompt, options)
Agent           the invocation layer · session control · triggers (the scheduler) · the environment check · credentials
                  ↓ the harness port
Harness         pi today; others later
                  ↓ storage: the state root (a filesystem today)
The world       Environment (the image, or the machine) · Contexts (.contexts/ clones) · Connectors (tools, MCP)
```

### 9.3 The invocation layer

It keeps three things:

- **A record per accepted invocation**: id, session, idempotency key, principal, status, outcome, usage and times, in
  the state root, kept for a retention window after it settles (§13).
- **While it runs, its events in memory**, so an attach replays them from a cursor. A settled invocation answers an
  attach with its `settled` event, and its content is in the session's entries.
- **Pending follow-ups, in memory**: their prompts, per session, in arrival order (§7.4).

Memory is enough for both because a running invocation lives in one process, and after a restart neither it nor what
waits behind it can continue anyway. Location independence (SPEC MUST 6) holds because a session's calls reach the process that runs it:
one process per agent on a resident host, one microVM per session on AgentCore (`runtimeSessionId`). Scaling a
resident host out would need the same session affinity.

| What happens | A running invocation | A pending follow-up |
|---|---|---|
| The caller disconnects | Continues; any client attaches by id | Stays pending, and runs in its turn |
| `cancel` | Stops, and settles `canceled` | Withdrawn, and settles `canceled` |
| The session's `abort` | Stops, and settles `canceled` | Withdrawn, and settles `canceled` |
| The process restarts, or a deploy replaces it | Settles `failed` with `interrupted` (retryable); what it recorded stays | Settles `failed` with `interrupted` (retryable); nothing ran |

The service never reruns an interrupted invocation: its tools may already have had effects (§3.1, invariant 3). A
caller that owes an answer may invoke again; the channels already bound their replays.

### 9.4 Where state lives

| Where | Holds | In git, and on a deploy |
|---|---|---|
| The definition | Identity, behavior, skills, tools, triggers, the config | In git; built into the image |
| `.state/` | Session records, invocation records, schedule claims, channel state | Not in git; on the host's volume |
| `.contexts/` | Clones of the agent's contexts | Not in git; cloned on the host at start |
| `.secrets/` | Values and grants | Not in git; values reach the host through its secret store |

### 9.5 Principal

- A channel asserts the platform account, because the platform's signature has already authenticated the message.
- Over HTTP, FastAgent authenticates nobody, so it accepts a principal only from a trusted gateway configured for it,
  and otherwise there is none.
- v1 uses it for attribution (recorded on the invocation and its user entry) and in the prompt (who is asking).
  Permissions are designed later.

### 9.6 Agents calling agents

An agent reaches another through `connectAgent`. For the caller that is a connector; for the callee it is a request
trigger. No further concept is needed.

## 10. Deployment

### 10.1 What a deploy builds

An image holds the base runtime, the environment (§4), the definition, its dependencies, and a release manifest. It
holds no credential, no state and no context: values reach the box through the host's secret store, grants are made
on the box (`login --deployment`), and contexts are cloned there at start, which preflight checks.

### 10.2 Two kinds of host

| | Resident (Docker, Fly, Railway) | No resident process (AgentCore) |
|---|---|---|
| Process | One per agent, holding the storage lease | One microVM per session, recycled after 180 idle seconds by default |
| Storage | A volume that outlives deploys | Reset on every deploy |
| Clock | The local scheduler | EventBridge |
| Invocation records | On the volume | In the session's storage: they do not survive a deploy |
| Reaching an invocation | Any request reaches the one process | A request names its session, which routes it to the microVM (§13) |

### 10.3 Operations

`logs` shows what the service printed, and `invocations` what it did: what is running, what finished, and what each
cost. A `settled` event carries the usage, so cost sums per invocation, per session and per agent.

## 11. What changes in FastAgent

| Area | Today | Proposed |
|---|---|---|
| Environment | Inherits the machine; `deploy.apt` | Declared; checked by `dev`; installed by `deploy` (§4) |
| Contexts | `local` and `github` | Unchanged; later, more storage kinds; writable contexts as long-term memory |
| Connectors | `tools/`, channel send tools; MCP off when serving | Declared; #678 (§5) |
| Credentials | Declared by tools and channels; one value file and the model's grants | Declared by everything that uses one; values and grants, connectors included (§6) |
| `invoke` | A function call that ends with its stream | A durable invocation (§7) |
| A busy session | Rejected; each caller waits its own way | `whenBusy`, `followUp` by default (§7.4) |
| The engine boundary | `Agent` is both what callers use and what pi implements | Two contracts: the agent above, the harness port below (§9.1) |

## 12. Order of work

| Step | Work | Needs |
|---|---|---|
| 0 | Upgrade to pi 1.0.4 | None |
| 1 | The SPEC v1 draft, and the harness port drawn out of today's `Agent` without changing behavior | 0 |
| 2 | The invocation layer: `accepted` and `settled`, ids, detaching, attach, cancel, idempotency, `whenBusy` (follow-ups, steer, reject), `interrupted`; conformance tests | 1 |
| 3 | HTTP, `connectAgent` and the CLI; channels, schedules and wake-ups on `whenBusy`; duang follows | 2 |
| 4 | The declared environment | None; parallel to 2 and 3 |
| 5 | Credential declarations for contexts and the environment; connectors, with MCP (#678) and grants | 0 |
| 6 | pi-durable as a second harness; the self-change loop (#605); more context kinds | 2 |

## 13. Open questions

1. The declaration shapes: `environment`, `connectors`, and naming a context's credential.
2. What the machine lends pi today (skills, prompt templates, engine settings) once the environment is declared.
3. The exact event vocabulary and error-code set, in the SPEC v1 draft.
4. How long an invocation record is kept, and the scope of an idempotency key: the agent, or the session.
5. On AgentCore, how a remote client reaches an invocation: attaching has to name the session to be routed.
6. What the port adds for a durable harness to recover from a checkpoint instead of settling `interrupted`.
7. How a deploy treats the agent's changes that are not merged yet (#605).
8. Context kinds that are not directories, such as S3.
9. Acting as the member who asked (§6.3).
10. Whether a session needs a cap on its pending follow-ups.

## 14. Decisions made in review

- `Scope` carries facts the caller asserts. Choices among the agent's options are made on the control plane.
- Whoever creates a thing names it: callers name sessions; the service names invocations and entries.
- `invoke` keeps its name and shape; its semantics change as in §7.
- No new waiting states for human input: steering, follow-ups and aborting cover it.
- A unit above agents (a team, members, a shared deployment) is outside FastAgent; sharing is through contexts and
  connectors.
- The world an agent acts in is environment, contexts and connectors, separated by the test in §3.2.
- The environment is declared, reversing the rule that an agent inherits the machine and that nothing compares the
  two.
- A busy session: each invoke says what its message is (`whenBusy`: `followUp` by default, `steer`, `reject`). Pending
  follow-ups live in memory and share the process's fate (§7.4).
- Credentials are declared by whatever uses them and stored by how they are obtained (§6). The shell keeps inheriting
  the process environment; isolation waits for a sandboxed environment (§6.4).
- The agent's semantics are written once, above a harness port, so another harness can be added (§9.1).
- `principal`: channels assert the platform account; HTTP accepts one only from a trusted gateway (§9.5).
- Attach and cancel are served with `/invoke`, holding the id being the permission; the invocation list is served with
  `/control/*` (§8.4).
- No field is reserved for a use nobody has designed.
