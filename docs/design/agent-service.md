---
title: Agent service
description: "Proposed: FastAgent for teams that build, run and use a set of agents together as cloud services. The product loop, what an agent works with (contexts, connectors, environment), state, credentials, invoke as work that outlives its caller, disposable boxes, the interfaces, the architecture, and deployment."
type: design-doc
status: proposed
---

# Agent service

**Status: proposed, not implemented.** It extends the [agent model](agent-model.md), changes the
[Agent Handler SPEC](../SPEC.md) (§7.6 lists the sections), and answers
[#688](https://github.com/fastagent-sh/fastagent/issues/688) (what `Scope` means). §14 lists the decisions made in
review; everything else is a proposal to settle before implementation.

Three things are hard in serving an agent, and this design spends itself on them:

1. **Work that outlives its caller.** Work arrives from many entry points, has side effects, and keeps running when
   its caller goes away; the caller comes back to it by its id. Surviving a restart as well needs a harness that
   checkpoints its runs (§9.3).
2. **Disposable boxes.** A deploy wipes a box, and scaling out adds boxes and removes them. So the program comes from
   the image, what has to last lives outside the box, and each conversation reaches the box that holds it (§10.2).
3. **What the agent works with, on a host.** The contexts it works on, the connectors it reaches, the environment it
   runs in, and the credentials each of them needs must be reproduced in the cloud (§3).

Models, the agent loop and hosting are not on the list: FastAgent uses existing ones. An agent changing its own
definition is designed later ([#605](https://github.com/fastagent-sh/fastagent/issues/605)).

## 1. Who it is for

Teams that build and maintain a set of agents together, run them in the cloud continuously, and use them from where
they already work: chat, their own apps, other agents.

| Need | Means |
|---|---|
| Develop together | An agent is a directory in git. Every change to it, including the agent's own, can be reviewed and reverted |
| Use together | Members reach the agents from team channels and apps, and who asked matters |
| Run continuously | An agent runs on no one's machine, scales to zero when idle and out under load, and its work outlives the connection that started it |
| Share infrastructure | The knowledge, code and integrations a team's agents work with are shared, not copied |

| Role | Does | Through |
|---|---|---|
| Builder | Writes, tests and ships agents, often through a coding agent | The directory and the CLI |
| Member | Hands work to agents and follows it | Team chat, the team's own apps, clients such as duang |
| Operator | Deploys, watches and rolls back; in a small team, the builder | The CLI and the host's console |
| The agent | Writes to its writable contexts and to its own directory | Its own directory |

Outside FastAgent:

- a unit above agents: a team, its members, shared secrets, one deployment target. Sharing happens through the
  contexts and connectors several agents declare (§3);
- the model and the agent loop, which a harness provides (§9.1);
- a hosting platform of its own: agents deploy to existing hosts (§10);
- waiting states for human input: steering, follow-ups and cancelling cover it.

## 2. The loop

```text
init → dev (locally, on the team's channels) → deploy → the team uses it
  ↑                                                         │
  └──────────────── a change, committed to the agent's repository
```

- Git holds every change to the definition. That is what makes a change reviewable and revertible, and what a deploy
  builds from. A rollback deploys an earlier commit.
- The deployed definition stays writable, and what the agent writes to its live inputs takes effect where it runs.
  How such a change returns to git and comes into service is designed later, in
  [#605](https://github.com/fastagent-sh/fastagent/issues/605); until then a deploy replaces it.

## 3. The model

```text
Agent = model + harness + context, composed by a definition
  model          what it thinks with, from a model provider
  harness        the loop that runs it: pi (§9.1)
  context        what it works with, from outside, declared side by side as:
    contexts       the data it works on and knows: directories and repositories (contexts.json)
    connectors     the other systems it reaches: APIs, tools, MCP servers (mcp.json, tools/)
    environment    what it runs in: the commands and runtimes the deployment provides
  definition     its own directory: who it is and how it works, and which model and context it uses
  remembers in   sessions: conversations
  started by     triggers: requests, messages, events, time, itself
```

The formula is the [agent model](agent-model.md)'s. Each of the three is supplied by someone else: the model by a
model provider, the harness by pi, the context by the repositories, clouds and MCP servers the agent works with.
FastAgent defines the agent and composes the three, in its definition, and serves the result. Declaring the context
apart from the definition is what lets a box be wiped and rebuilt from the declarations (§10.2), and what lets a team
share it across its agents (§1).

### 3.1 Why three: every action has three parts

Everything an agent does outside its model is an action: a tool call. An action has exactly three parts: **where it
executes**, **which state it reads or changes**, and **which other system it affects**. A skill script, for example,
runs `git` in the environment, edits files in a context, and opens a ticket through a connector. So the three cover
everything an agent touches outside its model, and they do not overlap.

| | Environment | Context | Connector |
|---|---|---|---|
| Is | Compute: the agent's body | Data the team owns: documents, materials, code | Another system's operations |
| Examples | node 22, git, ffmpeg, a sandbox | A directory, a git repository, an S3 bucket used as a working store | GitHub issues, Jira, email, payments, a company API, an MCP server |
| Lifetime | Disposable; rebuilt from its declaration | Persistent and versioned | The other system's |
| A write can be undone | Holds no durable data | Yes: it has history, and it can be reviewed and reverted | Often not: a sent email, a payment |
| Access | None needed | Read and write, plus the credentials to sync it | Authority delegated per action (OAuth, API keys), scoped |
| Credentials (§6) | Supplied at start, never built in | Declared by the context | Declared by the connector |
| Shared across a team's agents | The declaration; each agent runs its own instance | The same data: a team asset | The same integration, with per-agent scopes |
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
| A team's own S3 bucket used as a working store | Context | Generic get, put and list, and the team owns it |
| Notion or Google Drive used through their API | Connector | Synced to files, the same pages are a context |
| A production database behind a business API | Connector | The state and its rules belong to the other system |
| Feishu, Slack | The channel is a trigger; the agent's send tool is a connector | One system, two relationships |

Knowledge and long-term memory prefer contexts made of files, such as markdown in git: people can read, review and
revert them, and they travel with a deployment. A memory service such as a vector store is a connector.

### 3.3 What knowledge, memory, skills and tools are

They are uses of the three, not further categories.

| Term | Is |
|---|---|
| Knowledge | Reading contexts, and querying connectors (a search) |
| Memory | Long-term: writing to a writable context. A conversation's: its session (§3.5) |
| Skill | Know-how stored in the definition or a context, executed in the environment, possibly calling connectors |
| Tool | How an action is presented to the model. `read`, `write` and `bash` act on the environment and contexts. A code tool is part of the definition, and the system it reaches is a connector; an MCP tool is a connector's |

### 3.4 The agent's own directory

An agent's own directory is its definition: who it is and how it works. It stays writable on a host as on a laptop; how
what the agent changes there is kept is designed later (§2).

### 3.5 Sessions and triggers

A **session** is a conversation's continuity: the invokes of one session share its history. It is named by the
caller (§7.2), and may start as a fork of another session. A session is the agent's working memory of a
conversation: what should outlast it belongs in a context, and a chat place's own history is the platform's (§10.2).

A **trigger** is where an invoke comes from: a request (HTTP, another agent), a message (a channel), an event (a
webhook), time (a schedule), or the agent itself (`wake`, a subagent). A channel is a trigger and a connector of one
system: messages arrive through it, and the agent's send tool posts through it.

## 4. The deployed environment is declared

Today an agent inherits the machine it runs on, the way `bash` inherits the `PATH`, and `deploy.apt` adds apt packages
to the generated image. The image is the environment a team's cloud agent runs in, so what it installs belongs to the
agent rather than to one deploy:

```ts
export default {
  environment: { apt: ["gh", "ripgrep"] },   // today's deploy.apt: what deploy installs into the image
};
```

Locally the machine still lends the agent its environment, and nothing compares the two. A check of the machine
against the declaration waits for a case that needs it: an apt package is not the command it installs (`ripgrep`
installs `rg`), so the check would need a second list.

## 5. Connectors are declared

Today a connector is a code tool in `tools/` or a channel's send tool. Pi's MCP extension is not loaded when serving,
because its server connections live as long as a session and a served session lives one turn
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). Proposed, on pi 1.0.4 (§12):

- **A service that speaks MCP** is declared in `mcp.json` at the agent's root, in pi's format, which Claude Code,
  Cursor and VS Code share (`mcpServers`: a `command` or a `url`, `headers` or `env` that name values as `${VAR}`, and
  a `description` the agent reads). `.pi/mcp.json` is read too, below it, as for every file pi and FastAgent both
  have a place for. Pi brings OAuth sign-in (`mcp login`) and per-server exposure with it.
- **A service without MCP** needs no new kind of file. Each way to reach it already has its declaration:

  | The service offers | Reach it with | Declared in | Its credential |
  |---|---|---|---|
  | A CLI in Debian's repositories (`gh`, `awscli`) | The CLI in the environment, and a skill that teaches it | `environment.apt`, `skills/` | The variable the CLI reads |
  | An API this agent calls | Code tools, one per operation, beside the client they share | `tools/` (`defineTool`, §8.1) | `defineTool({ secrets })` |
  | An API several agents or harnesses reuse | An MCP server of one's own, run locally (stdio) or hosted | `mcp.json` | `${VAR}` in `env` or `headers` |
  | An OpenAPI or Smithy description, or a Lambda function, on AWS | AgentCore Gateway, which turns it into an MCP server and handles the outbound authorization | `mcp.json` (`url`) | The Gateway's own |
  | A REST call or two | A skill with a script (`curl`, Python) | `skills/` | The variable the script reads |

- A vendor CLI outside Debian's default repositories (Stripe's) has no install path in the generated image: it needs
  a `Dockerfile` of the author's own, which `deploy` keeps.
- `fastagent info` lists every connector in one place: the MCP servers, the code tools with the secrets they declare,
  and the packages the environment installs (a package is not the command it installs, §4).
- An MCP connection lives as long as the process or the conversation, not one turn, which is #678.

## 6. Credentials

A credential is proof of authority over another system. Three questions decide how one is handled:

1. **Who uses it**: the model's provider client, a tool's code, a channel, a connector, git for a context, or a
   command the agent runs in its environment. The model itself never needs one.
2. **How it is obtained**: as a value, or as an interactive grant.
3. **On whose authority**: the agent's own, or the member who asked.

### 6.1 Declared by what uses it

A credential that code or configuration uses is declared next to it, the way `defineTool` and `defineChannel` declare
`secrets` today. The commands the agent runs are the exception: they read the process environment.

| Used by | Declared as | Today |
|---|---|---|
| The model's provider | `model`, then its provider's env key or a `login` grant | Exists |
| A code tool | `defineTool({ secrets })` | Exists |
| A channel | `defineChannel({ secrets })` | Exists |
| A context | Its kind's credential: a `github` context reads `GITHUB_TOKEN` after git's own helpers, and may name another variable | Read; `deploy` notes when it is missing; not declared |
| An MCP server | `${VAR}` in its `env` or `headers` in `mcp.json`, or an OAuth sign-in (`mcp login`) | MCP is not served yet |
| A command the agent runs (`gh`, `aws`) | Nothing: it reads the process environment, which holds every value | As today |

A declaration does what it does for tools and channels today:

- it makes the value required: a serving path refuses to start without it and names the file that declared it, and
  `deploy` refuses before its first side effect. A context's credential is the exception: git's own helpers come first
  and a public repository needs none, so a missing one is a note, as `deploy`'s preflight gives today, and its
  declaration only attributes the value and carries it;
- it attributes the value: runbooks and `info` say which part needs which name, and whether it is set, never the value;
- for code, it hands the value back to the code that declared it, so the read cannot drift from the declaration.

### 6.2 Stored by how it is obtained

| Obtained as | Examples | Stored | Provided locally | On a deployed host | Renewed |
|---|---|---|---|---|---|
| A value | API keys, bot tokens, signing secrets, a GitHub App's private key | `.secrets/.env`, by env-var name | Written by the author, or by `add <channel>` | `deploy` carries the value file | Rotated by hand |
| A grant to a model | OAuth to a model subscription | `.secrets/auth.json`, by provider | `fastagent login <provider>` | `fastagent login <provider> --deployment <host>` runs the flow on the box | Refreshed in place by the runtime |
| A grant to an MCP server | OAuth to an MCP server | Pi's `mcp login` keeps it in `~/.pi/agent/mcp-auth.json`, by server name and URL | `pi mcp login <server>` | Open (§13): a container's home is not on the storage a deploy keeps | Refreshed by pi |

- Values keep env-var names because every SDK and CLI reads them (`GITHUB_TOKEN`, `OPENAI_API_KEY`). Two
  declarations of one name share one value; two parts that need different values declare different names
  (`ACME_GITHUB_TOKEN`).
- Grants exist today for model providers, including the machine-wide store `login -g` writes. Pi signs in to an MCP
  server itself (`mcp login`) and keeps its tokens on the machine; where they live for a deployed agent is decided
  with MCP (§13).

### 6.3 On whose authority

Every credential today carries the agent's own authority: a bot, a service account, a team token. Acting as the member
who asked (their calendar, their mailbox) needs a consent flow started from a channel and grants stored per
principal. It needs a structured principal, which comes with permissions (§9.5).

### 6.4 The trust boundary

Today the agent's shell runs on the same box, as the same user, as the service that holds the credentials. The agent
can read every value and grant there (`cat .secrets/.env` works whatever the shell's environment holds), and so can
whoever steers it through a prompt injection. Removing values from the shell's environment would break the commands
that read them and protect nothing, so the shell keeps inheriting the process environment.

Isolation needs a boundary: the environment in a sandbox that holds no credentials, and the calls that need one made by
the service outside it. That is a later level, on the harness's execution-environment seam (pi-durable runs its
built-in tools through a pluggable `ExecutionEnv`).

Until then, give an agent only credentials you would hand it directly, scoped as narrowly as the other system allows:
fine-grained, and read-only where possible.

## 7. Invoke

`invoke(scope, prompt)` keeps its name and its shape, and it stays the only way to start work. What changes is who
owns the work: once the service takes an invoke, its **run** is the service's, and the caller may go away and come
back to it by its id. A run is the unit the session plane already reports, with its `runId`.

### 7.1 What changes

| | Today | Proposed |
|---|---|---|
| Ownership | A caller that stops reading aborts the run (SPEC MUST 3) | Once taken, the run is the service's: a caller that stops reading detaches, and the run goes on until it settles or is canceled (§7.5) |
| Identity | None on the data plane; the observation plane reports a `runId` | The stream's first event says how the invoke was taken, and `run_started` names the run |
| A busy session | Fails with `session_busy`. Channels queue their own turns and poll while another caller's run holds the session; schedules skip; wake-ups retry | The invoke says what its message is: `followUp` (the default) runs it next, `steer` joins the running run, `reject` answers `busy` (§7.4) |
| How it ends | `completed` or `failed` | One terminal event, `run_settled`, carrying the outcome and the usage |
| Events | Two vocabularies: the invoke stream's (`text`, `completed`) and the session stream's (`message_delta`, `run_settled`) | One: the session stream's (§7.3) |

Steering and following up become ways to invoke, and aborting becomes cancelling (§7.4, §7.5).

A caller that went away comes back by the run's id, wherever it could invoke: it reads the run's status (pending,
running, or settled, with its outcome, usage and text) and cancels it (§7.5). The service names a run when it takes
the invoke, so a pending follow-up has its id before it starts, and the stream's first event gives it. Where the
control plane is served, a client also follows the session live: it subscribes to `events()`, waits for the
subscription to be ready, then reads `entries()` and `state()`. pi-durable reconnects the same way, from the current
view, without replaying.

One gap stays: a caller whose connection drops before the first event arrives cannot tell whether its invoke was
taken. Idempotency keys would close it, and they wait for a caller that needs them (§14).

### 7.2 Scope

```ts
interface Agent {
  invoke(scope: Scope, prompt: Prompt, options?: InvokeOptions): Invocation;
}

/** Facts the caller asserts about this invoke. Never a choice among the agent's options. */
interface Scope {
  /** The conversation, named by the caller. */
  session: string;
  /** Where a new session starts. Applied when the session has no turns yet; how `at` names the point is open (§13). */
  fork?: { from: string; at?: string };
}

interface InvokeOptions {
  /** What this message is when the session is running another run (§7.4). Default: "followUp". */
  whenBusy?: "followUp" | "steer" | "reject";
}

/** Session events: first how the invoke was taken (it runs now, waits as a follow-up, or joined the running run),
 *  last `run_settled`. An invoke that started no run is the single `Rejected` instead. */
type Invocation = AsyncIterable<SessionEvent | Rejected>;
```

- **Facts, not choices.** Choices among the agent's options, such as a session's model and thinking level, are session
  properties set on the control plane, where the options can be listed (`models()`).
- **Whoever creates a thing names it.** Callers name sessions, because they map their places to conversations. The
  service names runs and entries, and gives the names back: an entry id comes from `run_settled`'s `leafEntryId` or
  from `entries()`.

### 7.3 Outcome, events, errors

```ts
/** `run_settled`'s data. */
interface RunSettled {
  outcome: Outcome;
  /** What the run spent, as the harness reports it: tokens and cost. */
  usage: Usage;
}

type Outcome =
  | { status: "completed"; leafEntryId: string }
  | { status: "failed"; error: AgentError; leafEntryId?: string }
  | { status: "canceled"; leafEntryId?: string };

/** The whole stream of an invoke that started no run: nothing ran and nothing was recorded. */
interface Rejected {
  type: "rejected";
  error: AgentError;
}

interface AgentError {
  code: string;        // stable and machine-readable
  message: string;
  retryable: boolean;  // whether the same request may succeed if sent again
  details?: Json;
}
```

`rejected` and a failed run are separate on purpose: a rejected invoke is safe to send again, while a failed run may
have recorded entries or run tools. A rejected invoke starts no run, so it is not a run event: its stream is the one
`rejected` event, which is never published to the session's `events()`, and over HTTP it is an error status instead
of a stream.

The invoke stream adopts the session stream's vocabulary, so the same thing has one name in both: `run_started`,
`user_message`, `message_started`, `message_delta`, `message_finished`, `tool_started`, `tool_progress`,
`tool_finished`, `retry_scheduled` and `run_settled`. A session's stream adds `queue_changed`, `state_changed` and the
compaction events. The one thing missing is added: how a busy invoke was taken.

Proposed error codes, one set for every call: `invalid_request`, `unsupported`, `not_found`, `busy` (its `details`
carry the running run's id), `nothing_to_compact`, `missing_model`, `auth_required`, `model_error`, `partial_update`,
`unavailable`, `internal`. A harness may add codes under its own prefix; a client that meets an unknown code acts on
`retryable`.

A process that stops takes its runs with it: their streams end without `run_settled`, and what they recorded stays in
the session (§9.3).

### 7.4 A busy session

A session runs one run at a time, because each turn extends the history the next one reads. What a message that
arrives meanwhile means (an addition, a correction, or something that only makes sense right now) is the caller's to
say, on each invoke:

| `whenBusy` | When the session is running another run |
|---|---|
| `followUp` (the default) | Taken and pending. It runs as the session's next run when the running one ends, in arrival order |
| `steer` | Joins the running run after its current tool round. The invoke's stream continues with that run's events from there |
| `reject` | Rejected with `busy` (retryable; nothing ran and nothing was recorded), carrying the running run's id |

An idle session runs the invoke at once, whatever `whenBusy` says. pi's SDK refuses a prompt to a busy session that
does not say which, rather than guess; pi-durable's `submit` offers the same three choices and defaults to a
follow-up, and so does this, because a follow-up never disturbs work already running.

The service decides, because only it can decide without a race: a caller that hears `busy` and then follows up can
find the run ended in between, and every caller would write its own wait loop, as channels and wake-ups each do today.

What the service holds stays small. Pending follow-ups are kept in memory beside the running run and share the
process's fate: a restart loses them with the run (§9.3). There is no durable queue, no recovery, and nothing to
coordinate across instances.

- When a run settles, however it ended, the session's next pending follow-up starts. pi-durable's inbox keeps them
  after a failed run until the next submission; the difference is revisited when moving to it.
- A session holds at most 20 pending follow-ups, the cap a conversation's wake-ups already have; past it, an invoke is
  rejected with `busy`. That bounds one session's queue. It does not bound a caller, who names its sessions and can
  spread work over new ones, and whose runs go on after it leaves, so a process also caps its runs in flight, running
  and pending together: past the cap, an invoke is rejected with `busy`. Its size is set with SPEC v1 (§13).
- Cancelling a session, which a chat's stop command does, stops everything the session is doing at once: the running
  run, every pending follow-up and a manual compaction, so no follow-up starts in between. pi's own abort likewise
  returns queued messages to the editor. It reports what it stopped, so a stop command can say when nothing was
  running.
- A steer the running turn can no longer take, because the turn ended first, is taken as a follow-up instead, behind
  those already pending; the stream's first event says how it was taken.
- A steer's message is recorded as a user entry. The run's usage stays with the run it joined, so nothing is counted
  twice, and the id a steer is given is that run's: cancelling it stops the run it joined.
- Busy is decided in process. Today's lease (`inProcessLease`) is a set in one process, and the run layer keeps
  nothing on disk, so nothing detects a run another process holds on the same session: both would write its record.
  What prevents that is topology: one serving process per agent's state on a resident host (the deployment lease),
  one runtime session on AgentCore, and a session of its own for each one-off `fastagent invoke`. Scaling out needs a
  lease across processes, designed with it (§13).

`steer` and `followUp` leave the session control plane: `invoke` becomes the one way to hand a session a message.

| Caller | `whenBusy` | What changes |
|---|---|---|
| Channels | `followUp`; a channel may offer `steer` | Their busy wait, which polls every 5 seconds, goes. Whether they keep their own queue (`turn-queue`) is decided when they move (§12); their turn store stays, because it is what they owe the chat |
| Schedules | `reject` | Nothing: an occurrence on a busy session is skipped |
| Wake-ups | `followUp` | One that fires into a busy session runs right after the running run, instead of retrying |
| duang and other clients | Their choice | `session.steer` becomes `invoke` with `steer` |

### 7.5 Control plane

`cancel` replaces `abort`, at two scopes:

- **A run**, by its id: a running run stops and settles `canceled`; a pending follow-up is withdrawn. The same id reads
  the run's status, and the service keeps a settled run's status for a while, so a caller that comes back late still
  learns how it ended.
- **A session**: everything it is doing at once (§7.4), a manual compaction included, which has no run.

A run's status and its cancel are reachable wherever invoke is, so no run is out of its caller's reach:

| Where | Status and cancel, by run id |
|---|---|
| In process | `agent.runs.get(id)`, `agent.runs.cancel(id)` |
| HTTP | `GET /runs/{id}`, `POST /runs/{id}/cancel`, served with `/invoke`: a run id cannot be guessed, and holding it is the permission |
| AgentCore | `kind: "run"` and `kind: "cancel"` envelopes on the IAM-gated `InvokeAgentRuntime`, which the forwarder never emits, beside `kind: "invoke"` |

The session's `cancel` stays on the control plane. `steer` and `followUp` become `invoke` options, and `no_active_run`
goes, since only those three returned it. The other session operations are unchanged.

### 7.6 SPEC changes (v1)

| Section | Change |
|---|---|
| §2 | `invoke`'s stream starts with how the invoke was taken and ends with `run_settled`, or is a single `rejected`. The run outlives its caller, which reads and cancels it by its id (§7.5) |
| §3 | The `Scope` rule (facts, never choices); `fork` |
| §5 | One event vocabulary, the session stream's (§7.3). `completed.data` goes: no harness produces it, and a structured result waits for a design (§14) |
| §6, the three endings | (a) `run_settled`; (b) `rejected`, for an invoke that started no run; (c) the caller stops reading: its stream ends without a terminal event, and the run goes on |
| §6, MUST 1 | "Exactly one terminal event", `run_settled` or `rejected`, unless the process stops |
| §6, MUST 2 | Every failure is still an event, never a thrown iteration error, but no longer a `failed` event: a failed run settles with a `failed` outcome inside `run_settled`, and a refusal is `rejected` |
| §6, MUST 3 | Reversed: a caller that stops reading detaches, and `cancel`, by run or by session, stops the run. `embedding.md`, which says a client disconnect cancels the invoke, follows with v1 |
| §6, MUST 4 | The terminal set changes once, from `{ completed, failed }` to `{ run_settled, rejected }`, and is frozen again |
| §6, MUST 6 | Weaker: while a run is active, `whenBusy` needs a session's invokes to reach the process running it; portable conformance needs a session router in front (§9.3). `conformance-levels.md` says so with v1 |
| §7 | Buffered consumption: `collect` joins the run's text `message_delta`s and returns `{ text }` when the run settles `completed`; it throws on any other outcome or on `rejected` |
| §8 | The lineage, identity and source rows are replaced by §7.2; the mid-turn steering row by `whenBusy` (§7.4) and `cancel` (§7.5) |
| New | The harness port (§9.1): what a harness implements, beside what a caller uses |

## 8. Interfaces

Every interface ends in one operation, `invoke` (§7).

### 8.1 The directory

The directory is the only source of an agent.

```text
my-agent/
  SYSTEM.md · APPEND_SYSTEM.md · AGENTS.md   identity and behavior
  skills/ · prompts/                          know-how
  tools/                                      code tools: every value defineTool makes, in any file below
  extensions/                                 pi extensions
  channels/                                   triggers: messages
  schedules/<name>.md                         triggers: time
  contexts.json                               contexts: the data it works on and knows
  contexts/<name>/                            where each context is: a clone, a link, a mount; never in git
  mcp.json                                    connectors that speak MCP
  fastagent.config.ts                         what only the author sets: the model, environment, serving, deploy
  .secrets/ · .state/                         machinery, never in git
```

What the agent, a `fastagent` command or another tool writes is a data file of its own: contexts (`fastagent context
add`), MCP servers (`pi mcp add -l`), schedules (the agent). None of them edits TypeScript, and each is in a format others
already read or plain enough for a model to write. The config keeps what only the author sets: the model, the
environment, serving and deploy options, and `tools`, code tools defined in code beside `tools/`. Code stays code
(`tools/`, `channels/`, `extensions/`).

`tools/` is anchored on `defineTool`, the way Trigger.dev finds every exported `task()` in its task directories:

- Every module below `tools/` is loaded, at any depth, except tests (`*.test.*`, `*.spec.*`) and `.d.ts` files.
  Every value a module exports that `defineTool` made is a tool; a module that exports none is a helper.
- A tool is named by `defineTool({ name })`. Without one, a module directly in `tools/` that exports only that tool
  lends it its file name, as today; a module that exports several, or one below a folder, names each tool, so two
  services' `search.ts` cannot collide by accident. Today the file name wins over a `name`; that reverses, so a tool
  whose `name` differs from its file is renamed, which `fastagent info` shows.
- Folders only organize: a service's tools and the client they share sit together and travel as one folder. Grouping
  is `defineTool({ namespace })`.
- A module that fails to load still refuses the start, and a name two tools share is still reported. A file meant to
  export a tool that does not is no longer refused: the tool is missing from the startup report and `fastagent info`,
  which list every tool with its file.

`contexts.json` is one map by name, in JSON like `mcp.json`, `models.json` and `package.json`, with a JSON Schema
for editors. A context's entry is a few fields and one sentence for the agent, the size the ecosystem keeps in a
manifest (`.gitmodules`, west's `west.yml`, `mcp.json`); and JSON reads `ref: 1.10` as the string it is, where YAML
reads the number 1.1:

```json
{
  "$schema": "https://fastagent.sh/schema/contexts.json",
  "contexts": {
    "app": { "github": "acme/app", "ref": "main", "description": "The product's repository. Open pull requests against main." },
    "handbook": { "github": "acme/handbook", "readonly": true }
  }
}
```

Each context is materialized at `contexts/<name>/`, the way a manifest's projects land at their paths (DVC's `.dvc`
file beside its data, a submodule's directory, a west project). What is there is the place's choice: a clone by
default; on a laptop, a link to the author's own checkout, so no machine's path is committed; on a host, a link into
the host's storage, which a release does not replace. A context's home stays outside the agent's directory (agent
model §2); `contexts/<name>/` is only where this place mounts it, and neither git nor a deploy's build context
includes it.

```ts
export default {
  model: "openai-codex/gpt-5.5",
  environment: { apt: ["gh"] },
} satisfies FastagentConfig;
```

### 8.2 The CLI

| Stage | Today | Proposed |
|---|---|---|
| Create | `init`, `add <channel>`, `add skill`, `context add/list/remove` | Unchanged |
| Develop | `dev`, `chat`, `invoke`, `tool`, `info`, `models` | Unchanged: the one-off `invoke` keeps a fresh session per call, so nothing it runs can collide with a session a serving process holds |
| Ship | `deploy <host>`, `login [--deployment <host>]` | `deploy` installs `environment.apt` |
| Operate | `start`, `logs`, `destroy`, `schedules list` | Unchanged |

### 8.3 In code

An agent opened in this process (`createAgentService`) and one reached over HTTP (`connectAgent`) present the same
interface. Today the remote side is two clients, `connectAgent` and `connectSessionControl`; they become one.

```ts
type RunStatus =
  | { status: "pending" | "running" }
  | { status: "settled"; settled: RunSettled; text: string };   // text: the run's answer, as `collect` joins it

interface Agent {
  invoke(scope: Scope, prompt: Prompt, options?: InvokeOptions): Invocation;
  runs: {
    get(id: string): Promise<RunStatus | undefined>;   // undefined: an unknown id, or a settled run no longer kept
    cancel(id: string): Promise<{ ok: true } | { ok: false; error: AgentError }>;
  };
  capabilities(): SessionCapabilities;
  commands(): Promise<AgentCommand[]>;
  models(): Promise<ModelDescriptor[]>;
  sessions: SessionCollection;   // list, fork, get(id): a session, with cancel in place of steer, followUp and abort
}
```

The agent-level reads that sit on `SessionControl` today move onto `Agent`, so a caller writes
`agent.sessions.get(id).cancel()` and `agent.models()`.

### 8.4 HTTP

| Route | Does | Served |
|---|---|---|
| `POST /invoke` | Starts work: an SSE stream of session events (§7.2). A rejected invoke answers with an error status; `whenBusy` goes in the body | With `http.invoke` (on by default) |
| `GET /runs/{id}`, `POST /runs/{id}/cancel` | A run's status, and its cancel (§7.5) | With `/invoke`: a run id cannot be guessed, and holding it is the permission |
| `/control/sessions/*` | Session control; a `cancel` action replaces `steer`, `follow_up` and `abort` | With `/control/*`, as today |

### 8.5 Channels

A channel turns a platform message into an invoke:

| From the message | To |
|---|---|
| The place it was posted (a chat, a thread) | `session` |
| Where a thread began | `fork` |

Channels keep their turn store and their redelivery dedup; whether they keep their own queue is decided when they move
to `whenBusy` (§12).

### 8.6 Clients

A client such as duang shows conversations by session: what each is running, from `state()`, and what it cost, from its
entries. Clients live outside this repository.

## 9. Architecture

### 9.1 Two contracts: the agent and the harness

```text
Callers ──► Agent (SPEC v1)      invoke; sessions
              │  the run layer: whenBusy, runs that outlive their callers, cancel, the terminal event. Written once
              ▼
            Harness (the port)   run one turn on a session and steer it; the session operations
              │
              ▼
            pi today; pi-durable, the Claude Agent SDK or Codex later
```

The agent's semantics are written once, above a port that a harness implements. Two ways to place them:

| | A: the run layer above a harness port | B: each harness implements it |
|---|---|---|
| The semantics | Written once, the same on every harness | Written per harness, and the copies drift |
| A harness without durability, which is most of them | Works as it is | Needs the same layer written for it anyway |
| A durable harness (pi-durable) | Plugs in below; recovering a run from a checkpoint is added to the port when it is designed | Fits directly |

A wins. Today's `Agent`, where `invoke` runs one turn and a caller that stops reading aborts it, plus the session
control plane, is already close to the port: the pi implementation and its conformance suite become the first
harness, and the run layer is new code above them. The port's turn operation gets its own name (`run`), so `invoke`
keeps one meaning. The code and the SPEC call this layer the engine today (`src/engines/`, "engine-neutral"); they
take the name harness in a refactor of their own (§12, step 1).

A running turn offers the layer one operation, `steer`. Follow-ups are the layer's, run as the next turn, and stopping
a turn is the `AbortSignal` passed to `run`. Steering stays in the port because only the loop knows where its turns
end: from outside, the layer could only stop the turn, killing a tool mid-call, or wait for it to end, which is a
follow-up.

### 9.2 Layers

```text
Entry points    CLI · SDK · HTTP/SSE · channels · schedules · wake
                  ↓ every one calls invoke(scope, prompt, options)
Agent           the run layer · session control · triggers (the scheduler) · credentials
                  ↓ the harness port
Harness         pi today; others later
                  ↓ storage: the state root (a filesystem today)
Works with      Contexts (contexts/<name>/) · Connectors (tools, MCP) · Environment (the image, or the machine)
```

### 9.3 The run layer

It keeps nothing on disk. In memory, per session, it holds the running run, to steer and cancel it, and the pending
follow-ups (§7.4); and for a while, the status of each run that settled, so a caller that went away can read how its
run ended (§7.5).

Memory is enough because a run lives in one process, and process affinity exists only while a run is active, with
routing across instances belonging to a session router above FastAgent
([session control](session-control.md) §9). FastAgent's deployments meet it by topology: one process per agent on a
resident host, and on AgentCore the microVM of the runtime session the call names. Scaling out keeps that affinity by
giving each conversation its own runtime session (§10.2).

This is weaker than SPEC MUST 6, which forbids requiring a session's invocations to land in one process. A pending
follow-up or a steer is state only the process running the session's active run holds, and nothing external
reconstructs it. While a run is active, the same `followUp` is queued in that process and meets no queue in another
(§7.4), so portable conformance needs that router in front (§7.6).

| What happens | The running run | A pending follow-up |
|---|---|---|
| The caller stops reading | Continues | Stays pending, and runs in its turn |
| `cancel` by its id | Stops, and settles `canceled` | Withdrawn, and settles `canceled` |
| Cancelling the session | Stops, and settles `canceled` | Withdrawn, and settles `canceled` |
| The process stops: a restart or a deploy | Its stream ends without `run_settled`; what it recorded stays | Lost |

The service never reruns anything: a run's tools may already have had effects (§3.1, invariant 3). A caller that owes
an answer may invoke again; the channels do, from their turn stores, and bound their replays. A run that survives a
restart needs a harness that checkpoints it, such as pi-durable (§13).

### 9.4 Where state lives

| Where | Holds | In git, and on a deploy |
|---|---|---|
| The definition | Identity, behavior, skills, tools, triggers, the config | In git; built into the image |
| `.state/` | The service's state: session records, schedule claims, wake-ups, channel state | Not in git; where the deployment puts it (§10.2) |
| `contexts/<name>/` | Each context, as this place reaches it: a clone, a link, a mount | Not in git; on a host, a link into the host's storage |
| `.secrets/` | Values and grants | Not in git; values reach the host through its secret store |

### 9.5 Principal

Deferred. Channels already write the sender into the prompt, which is what the agent needs today. A structured
principal comes with permissions, when they are designed, and is then asserted this way:

- a channel asserts the platform account, because the platform's signature has already authenticated the message;
- over HTTP, FastAgent authenticates nobody, so it accepts one only from a trusted gateway configured for it.

### 9.6 Agents calling agents

An agent reaches another through `connectAgent`. For the caller that is a connector; for the callee it is a request
trigger. No further concept is needed.

## 10. Deployment

### 10.1 What a deploy builds

An image holds the base runtime, the environment (§4), the definition, and a release manifest; the agent's
dependencies are installed on the host's storage. It holds no credential, no state and no context: values reach the
box through the host's secret store, grants are made on the box (`login --deployment`), and contexts are cloned
there at start, which preflight checks.

### 10.2 Two kinds of host

| | Resident (Docker, Fly, Railway) | AgentCore |
|---|---|---|
| Process | One per agent, holding the storage lease | One microVM per runtime session. Today every entry point uses one fixed runtime session, so one microVM. It scales to zero after 180 idle seconds by default |
| Storage | A volume that outlives deploys | SessionStorage, one per runtime session: it survives scaling to zero; AWS resets it on every deploy and after 14 idle days |
| Clock | The local scheduler | EventBridge |

AgentCore is where most agents run: an idle agent costs nothing, and the platform is built for agents. A run that
outlives its caller counts as background work, so `/ping` answers `HealthyBusy` and AgentCore keeps the microVM until
the run settles, up to the runtime's maximum lifetime of 8 hours.

A box is disposable by design. The program comes from the image; contexts are cloned, connectors connect and the
environment is installed from the agent's declarations; a chat place's history is read from the platform
([place history](place-history.md)). So a deploy may wipe the box.

What remains is the service's **state**: sessions, the agent's working memory of each conversation; wake-ups;
schedule claims; channel records. State is declared apart from the contexts, because the service writes it and the
agent does not, it changes on every turn, and each piece must have one writer. Where it lives is the deployment's
choice: a volume on a resident host, and on AgentCore today the session storage, which a deploy wipes. That stays
until scaling out, whose design moves state to storage reached through an API (AgentCore Memory for conversations,
DynamoDB or S3 for the rest): it is shared by every microVM, outlives a deploy, needs no VPC, and costs nothing while
idle. A file system shared over a VPC (EFS, S3 Files) is not used: it would add a standing NAT bill and still need
the state split by writer.

Scaling out is the serving goal on AgentCore: a runtime session per conversation instead of one for all, so
conversations run on separate microVMs, and each scales to zero on its own. It needs the ingress to route each message
to its conversation's runtime session, and what spans conversations (redelivery dedup, the session list, schedules) to
live outside any one of them (§13).

### 10.3 Operations

`logs` shows what the service printed. What an agent is doing is each session's `state()`, and what it cost is in its
entries, where the harness records each answer's usage.

## 11. What changes in FastAgent

| Area | Today | Proposed |
|---|---|---|
| Environment | `deploy.apt` | `environment.apt`, installed by `deploy` (§4) |
| Declarations | What the agent works with, in the TypeScript config | What the agent or a tool writes is a data file of its own; the config keeps what only the author sets (§8.1) |
| Contexts | `contexts` in the config, cloned into `.contexts/` | `contexts.json`; each at `contexts/<name>/`: a clone, a link to the author's checkout, a mount (§8.1). Later, more storage kinds; writable contexts as long-term memory |
| State | `.state/` on the host's storage | Declared apart from the contexts; on AgentCore, API storage when scaling out (§10.2) |
| Code tools | One per file directly in `tools/`, default-exported; helpers kept outside | Every `defineTool` value exported from any module below `tools/`; helpers beside them (§8.1) |
| Connectors | `tools/`, channel send tools; MCP off when serving | MCP servers in `mcp.json` (#678); a service without MCP through a CLI, code tools or an MCP server of one's own; all listed by `fastagent info` (§5) |
| Credentials | Declared by tools and channels; one value file and the model's grants | Declared by everything that uses one (§6) |
| `invoke` | A function call that ends with its stream | A run that outlives its caller, read and canceled by its id; one terminal event; one event vocabulary (§7) |
| A busy session | Rejected; each caller waits its own way | `whenBusy`, `followUp` by default (§7.4) |
| Stopping and steering | `abort`, `steer` and `followUp` on the session | `cancel` on the session; steering through `invoke` (§7.5) |
| The harness boundary | `Agent` is both what callers use and what pi implements | Two contracts: the agent above, the harness port below (§9.1) |
| AgentCore | One fixed runtime session for every entry point | A runtime session per conversation (§10.2) |
| The agent's own changes on a host | Lost at the next deploy | Designed later (#605) |

## 12. Order of work

| Step | Work |
|---|---|
| 0 | Finish this design |
| 1 | Rename engine to harness in the code and the SPEC: a refactor, no change in behavior |
| 2 | Upgrade to pi 1.0.4 |
| 3 | Connectors and contexts as files: `mcp.json` (#678), `contexts.json` and `contexts/<name>/`; `tools/` anchored on `defineTool` |
| 4 | SPEC v1 and the harness port, after `fork` is re-checked (§13); channels, schedules, wake-ups and duang move to `whenBusy` and `cancel` |
| 5 | Scaling out on AgentCore: a runtime session per conversation, and state in API storage (§10.2) |
| Later | The agent's update loop (#605); evaluation; pi-durable as a harness; more context kinds |

## 13. Open questions

1. The shapes of `contexts.json` (naming a context's credential) and of `environment`; where an MCP server's OAuth
   tokens live for a deployed agent.
2. How `fork.at` names the point a thread starts from: an entry id the service gave out, which each channel would map
   its messages to, or the platform message id, which the service would record on the entry it belongs to. Feishu,
   the only user, holds message ids; today it finds the point by searching the parent's text for them.
3. The exact event vocabulary, the error codes, the cap on runs in flight, and how long a settled run's status is kept,
   in the SPEC v1 draft.
4. Scaling out on AgentCore: how the ingress routes each message to its conversation's runtime session; a lease that
   holds across processes; how state is split by writer (each conversation's own, and what spans conversations:
   redelivery dedup, the session list, schedules); and which API storage holds each part. Pending wake-ups are part
   of it: a deploy must not wipe them.
5. What the port adds for a harness that checkpoints its runs, so a run survives a restart (pi-durable).
6. Contexts that are not directories, such as S3.
7. Acting as the member who asked (§6.3), with permissions.

## 14. Decisions made in review

- `Scope` carries facts the caller asserts. Choices among the agent's options are made on the control plane.
- Whoever creates a thing names it: callers name sessions; the service names runs and entries.
- `invoke` keeps its name and shape; its semantics change as in §7.
- No new waiting states for human input: steering, follow-ups and cancelling cover it.
- A unit above agents (a team, members, a shared deployment) is outside FastAgent; sharing is through the contexts
  and connectors several agents declare.
- `Agent = model + harness + context`: the model from a model provider, the harness pi (the loop that runs an agent,
  as the ecosystem uses the word), and the context everything it works with from outside. FastAgent defines the agent
  and composes the three in its definition, its own directory, which the agent model called the harness until this
  review, and serves the result.
- The context is declared side by side, not nested: contexts (the data it works on and knows), connectors (the other
  systems it reaches) and environment (what the deployment provides). The test in §3.2 separates contexts from
  connectors.
- The deployed environment is declared (`environment.apt`); locally the machine still lends its environment (§4).
- A busy session: each invoke says what its message is (`whenBusy`: `followUp` by default, `steer`, `reject`). Pending
  follow-ups live in memory, at most 20 per session, and share the process's fate (§7.4).
- `invoke` is the one way to hand a session a message: `steer` and `followUp` leave the session control plane (§7.4).
- A run outlives its caller: a caller that stops reading detaches. Whoever holds the run's id reads its status and
  cancels it wherever invoke is reachable: in process, over HTTP beside `/invoke`, and on AgentCore through IAM-gated
  envelopes (§7.5). Runs in flight are capped per process (§7.4).
- Cancelling a session withdraws its pending follow-ups (§7.4).
- After a failed run, pending follow-ups start as usual, until the move to pi-durable revisits it (§7.4).
- Channels drop their busy wait. Whether they keep their own queue is decided when they move; their turn store stays
  (§7.4).
- `cancel` replaces `abort`, at two scopes: a run, by its id, and a session, everything it is doing (§7.5). A running
  turn offers the harness port only `steer`; stopping it is the `AbortSignal` given to `run` (§9.1).
- Steering and follow-ups move into `invoke` as `whenBusy`, reversing the SPEC §8 "Mid-turn steering" row, which kept
  them on the session control plane (§7.6).
- Credentials are declared by the code or configuration that uses them and stored by how they are obtained (§6). The
  shell keeps inheriting the process environment; isolation waits for a sandboxed environment (§6.4).
- The agent's semantics are written once, above a harness port, so another harness can be added (§9.1).
- Removed or deferred after a first-principles review, because nothing needs them yet:
  - a ledger of invocations, listing them, and attaching to one by id with replay: a run's status is kept in memory
    by its id, and a client follows a session live on the control plane (§7.1);
  - idempotency keys: pi-durable's `requestId` provides them when a caller needs them;
  - marking runs a restart interrupted;
  - `principal`, until permissions are designed (§9.5);
  - an optional `session`, and a structured `result`, with which `completed.data`, which no harness produces, goes
    too (§7.6);
  - the environment's secrets, runtimes and contexts' needs, and a check of the local machine;
  - the host-identity credential, and commands to add or remove connectors.
- The deployed definition stays writable. The agent's update loop is designed later, in #605 (§2); the core now is
  serving.
- AgentCore is the main host, because an idle agent costs nothing there. A box is disposable by design: the program
  comes from the image and what lasts lives outside the box, so a deploy wiping the box is expected. Scaling out, a
  runtime session per conversation, is the serving goal (§10.2).
- State is declared apart from the contexts, and where it lives is the deployment's choice. On AgentCore it stays in
  the session storage until scaling out moves it to API storage; no EFS stopgap (§10.2).
- Evaluation comes later.
- What the agent, a `fastagent` command or another tool writes is a data file of its own (contexts, MCP servers,
  schedules); the config keeps what only the author sets: the model, the environment, serving and deploy options, and
  `tools` (§8.1).
- Contexts are declared in `contexts.json` (JSON, a map by name, with a description for the agent and a JSON Schema),
  and each is materialized at `contexts/<name>/`: a clone, a link to the author's checkout, or a mount, never committed
  (§8.1).
- A service that speaks MCP is declared in `mcp.json` at the root, in pi's format (`.pi/mcp.json` is read too). A
  service without MCP is reached through a CLI and a skill, code tools, or an MCP server of one's own: there is no
  connector file type, and `fastagent info` lists every connector (§5).
- `tools/` is anchored on `defineTool`: every value it makes, exported from any module below `tools/` (tests and
  `.d.ts` aside), is a tool, and a module that exports none is a helper. A tool is named by `defineTool({ name })`;
  only a module directly in `tools/` that exports one tool may fall back to its file name. Folders only organize;
  grouping is `namespace` (§8.1).
- The order: finish this design; rename engine to harness, in a refactor of its own; upgrade to pi 1.0.4; then MCP
  (#678). The update loop and evaluation come later (§12).
- No field is reserved for a use nobody has designed.
