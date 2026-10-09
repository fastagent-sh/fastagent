---
title: Agent service
description: "Proposed: FastAgent for teams that build, run and use a set of agents together as cloud services. The product loop, what an agent works with (contexts, connectors, environment), state, credentials, the serving protocol (sessions, runs, entries) and its harness port, disposable boxes, the interfaces, the architecture, and deployment."
type: design-doc
status: proposed
---

# Agent service

**Status: proposed, not implemented.** It extends the [agent model](agent-model.md), replaces the
[Agent Handler SPEC](../SPEC.md) with the serving protocol (§7; §7.8 lists what changes), and answers
[#688](https://github.com/fastagent-sh/fastagent/issues/688): `Scope` goes, and §7.2 says what replaces it. §14 lists
the decisions made in review; everything else is a proposal to settle before implementation.

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
- waiting states for human input: steering, queued runs, cancelling and aborting cover it.

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
  contexts       the data it works on and knows: directories and repositories (contexts.json)
  connectors     the other systems it reaches: APIs, tools, MCP servers (mcp.json, tools/)
  environment    what it runs in: the commands and runtimes the deployment provides (environment, in the config)
  definition     its own directory: who it is and how it works, and which model and context it uses
  remembers in   sessions: conversations
  started by     triggers: requests, messages, events, time, itself
```

The formula is the [agent model](agent-model.md)'s. Each of the three is supplied by someone else: the model by a
model provider, the harness by pi, and the context, which is the agent's contexts, connectors and environment, by the
repositories, clouds and MCP servers it works with. FastAgent defines the agent and composes the three, in its
definition, and serves the result. Declaring the context
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
| Fails as | A missing command, when something runs it | Unreachable, or a conflicting write | Authorization, rate limits, an effect whose outcome is unknown |

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
caller or created by the service, and may start as a fork of another session (§7.4). A session is the agent's working
memory of a conversation: what should outlast it belongs in a context, and a chat place's own history is the
platform's (§10.2).

A session's record is an append-only log of entries, in pi's format: the messages (the asks, the answers with their
usage, the tool calls and results), model and thinking-level changes, compactions, the start and end of each run, and
FastAgent's own markers, which the model never sees. Each entry names its parent, so forks and branches share what
they inherited. That log is the session's durable history. The live events (`message_delta`, `tool_*`) are not
stored: a client that reconnects follows the log from its last entry (`follow`, §7.4). What the service prints is its
own log, kept by the host (§10.3).

A **trigger** is where an invoke comes from: a request (HTTP, another agent), a message (a channel), an event (a
webhook), time (a schedule), or the agent itself (`wake`, a subagent). A channel is a trigger and a connector of one
system: messages arrive through it, and the agent's send tool posts through it.

## 4. The deployed environment is declared

Today an agent inherits the machine it runs on, the way `bash` inherits the `PATH`, and `deploy.apt` adds apt packages
to the generated image. The image is the environment a team's cloud agent runs in, so what it installs belongs to the
agent rather than to one deploy. Most of what an image installs is packages, so the environment is declared as lists,
one per package manager, the way Claude Managed Agents (`packages`), Modal (`apt_install`, `pip_install`) and Railway's
Nixpacks (`aptPkgs`) declare it, with shell commands for the rest:

```ts
export default {
  environment: {
    apt: ["gh", "ripgrep"],                                  // Debian packages
    npm: ["@mermaid-js/mermaid-cli"],                        // CLIs, installed globally
    pip: ["pypdf", "openpyxl==3.1.5"],                       // Python libraries for skills' scripts
    run: ["curl -fsSL https://example.com/install.sh | sh"], // anything else: shell commands, run as root
  },
};
```

- `deploy` turns it into the install steps of the `Dockerfile` it generates, right after `FROM`, where the apt layer
  is today, in this order: `apt`, `npm`, `pip`, `run`. It writes what authors get wrong by hand, such as refreshing and
  then cleaning apt's lists, and its layers come before the definition is copied in, so they stay cached while the
  definition changes. A version is written the package manager's own way (`openpyxl==3.1.5`, `express@4.18.0`).
- `npm` installs with the agent's package manager: npm, or Bun's for a Bun agent.
- `pip` installs into a virtual environment `deploy` creates and puts on the `PATH`, after adding `python3` and
  `python3-venv` to the apt packages: the base image has no Python, and Debian refuses `pip` into the system's own.
- `run` holds what no list covers, such as a CLI from a vendor's own apt repository (Stripe's), as shell commands that
  need no Dockerfile. Each command can rely on what the lists installed before it.
- `deploy.apt` becomes `environment.apt`. An edit makes the generated `Dockerfile` stale, which is reported and gates
  `--run` until `--force` regenerates it, as for any generated artifact today.
- An author who wants the whole image keeps writing their own `Dockerfile`, which `deploy` keeps byte for byte;
  `environment` does not apply to it, and `deploy` says so.
- AgentCore builds `linux/arm64`: a binary a `run` command downloads must be built for it.

Locally the machine still lends the agent its environment, and nothing compares the two: a package is not the command
it installs (`ripgrep` installs `rg`).

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
  | A CLI (`gh`, `aws`, `stripe`) | The CLI in the environment, and a skill that teaches it | `environment` (`apt`, `npm` or `run`), `skills/` | The variable the CLI reads |
  | An API this agent calls | Code tools, one per operation, beside the client they share | `tools/` (`defineTool`, §8.1) | `defineTool({ secrets })` |
  | An API several agents or harnesses reuse | An MCP server of one's own, run locally (stdio) or hosted | `mcp.json` | `${VAR}` in `env` or `headers` |
  | An OpenAPI or Smithy description, or a Lambda function, on AWS | AgentCore Gateway, which turns it into an MCP server and handles the outbound authorization | `mcp.json` (`url`) | The Gateway's own |
  | A REST call or two | A skill with a script (`curl`, Python) | `skills/` | The variable the script reads |

- `fastagent info` lists every connector in one place: the MCP servers, the code tools with the secrets they declare,
  and what `environment` installs.
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

## 7. The serving protocol

The protocol is what every caller uses to work with a served agent: an app, a client such as duang, another agent,
and FastAgent's own channels, schedules and wake-ups. It is FastAgent's own, synthesized from the two harnesses built
for durable, multi-entry, long-running agents: pi-durable and DeepSeek Harness (dsh). ACP's v2 drafts arrive at the
same model independently. ACP is validated as a compatibility target in both directions (§7.9) rather than adopted as
the contract: its center is a person in an editor driving a local coding agent, and the parts this design needs most
are still drafts.

### 7.1 Concepts

| Concept | Is | A user uses it to | Exposed as |
|---|---|---|---|
| **Session** | A conversation: the invokes of one session share its history | Continue a conversation; list, read, follow, fork, compact or abort it. An operator also names it and sets its model | Named by the caller, or created by the service (§7.4) |
| **Message** | One thing said in a session, by a user or by the agent | Send one (`invoke`); read the history | Content only: entries in the history and the live text. No id and no operations |
| **Run** | One stretch of the agent working: from taking a message to stopping, across model calls and tool calls | See whether the agent is busy; learn how its work ended and what it cost; stop it | The unit a caller holds (`runId`), with a status, events and a cancel (§7.3). A session runs one at a time |
| **Entry** | One record in a session's history: a message, a tool result, a run's start or end, a settings change, a compaction | Read the history; reconnect from a point; fork from a point | Ids that are the cursor for `follow` and the point for `fork` (§7.5) |

A *step*, one model request and the tool calls it causes, belongs to the harness and is not exposed. *Turn* is not
used: the ecosystem uses it for both a step (pi) and a run (dsh, ACP). The v0.1 SPEC's turn is a run.

A user message is taken by exactly one run. A message sent with `queue` starts a run of its own; one sent with `steer`
joins the running run; on an idle session, either starts a new run. A run takes one message or more, writes the
agent's messages and tool results, and ends with one outcome.

| This protocol | pi | pi-durable | DeepSeek Harness | ACP |
|---|---|---|---|---|
| Session | session | conversation | session | session |
| A user's message | a prompt, steer or follow-up input | Submission (input) | message (`MessageId`) | user message (`messageId`) |
| Run | an agent run, until `agent_settled` | run | turn | prompt turn, or foreground work |
| Step (not exposed) | turn | `pi.generation` task | step | — |
| Entry | session entry | entry | session event | session update |

Names follow one rule: fields are camelCase; enum values and discriminators are snake_case. A field that refers to
another object names its kind: `sessionId`, `runId`, `entryId`, `parentEntryId`.

### 7.2 Invoke

```ts
interface Agent {
  invoke(request: InvokeRequest): AsyncIterable<InvokeEvent>;
}

interface InvokeRequest {
  /** The session. Absent: the service creates one and names it in the receipt. */
  sessionId?: string;
  prompt: { text: string; images?: ImageRef[] };
  /** What the message is when the session is running another run. Default: "queue". */
  whenBusy?: "queue" | "steer" | "reject";
  /** The caller's key for this message, unique within the session: the same key returns the same run. */
  idempotencyKey?: string;
}

type InvokeEvent =
  | { type: "accepted"; sessionId: string; run: RunStatus; joined: boolean; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | SessionEvent;
```

- **Accepted.** The first event names the session and the run. `joined` says the message was steered into the
  running run; `duplicate` says the key had been seen, and `run` is that run as it is now. The run's events follow
  (§7.5), and the stream ends after the run's `run_ended` entry. A caller that stops reading detaches: the run goes
  on, and the caller can come back to it (§7.3).
- **Rejected.** The only event of an invoke that was not accepted: nothing ran and nothing was recorded, so it is safe
  to send again. Over HTTP it is an error status instead of a stream.
- **A busy session.** The caller says what a message that arrives during a run is, and the service applies it,
  because only the service can do so without a race:

  | `whenBusy` | When the session is running another run |
  |---|---|
  | `queue` (the default) | A new run, queued. It starts when the runs before it end, in arrival order |
  | `steer` | Joins the running run after its current tool round. `joined` is reported once the harness has taken the message; one that arrives too late becomes a new run |
  | `reject` | Rejected with `busy` |

  An idle session starts a run whatever `whenBusy` says. pi-durable offers the same three choices with the same
  default; dsh and ACP's inject draft offer `queue` and `steer`.
- **Sessions.** A caller that names the session gets that session, created empty by its first invoke: a channel names
  a chat place, a schedule names `schedule:<name>`. A caller that names none gets a new session per invoke, named in
  the receipt. Forking happens only through `sessions.create` (§7.4). The harness's own ids are mapped by the serving
  layer and never reach a caller.
- **Idempotency.** A key is unique within its session and requires `sessionId`: without one, every invoke creates a
  new session, and a retry could never match. A channel uses the platform's message id, a schedule its occurrence id.
  pi-durable keys its submissions the same way, and dsh stores a client-minted id on the message.
- **Without a stream.** Over HTTP, `Accept: application/json` answers `202` with the `accepted` event, and the caller
  follows or polls the run.

The caller holds a run, not a message. dsh and ACP both decline a handle for "the result of this message", because
steered messages and injected context share the same work; a run is the unit whose outcome is real. Its answer
belongs to the run, which steered messages share. A caller that needs an outcome of its own uses a session of its own.

### 7.3 Runs

```ts
type RunStatus = {
  runId: string;
  /** What started it: a channel, a schedule, a wake-up, or a caller of the API. */
  source?: { kind: "channel" | "schedule" | "wake" | "api"; name?: string };
  /** The user messages it took: the one that started it and those steered into it. */
  messages: { entryId?: string; idempotencyKey?: string }[];
} & (
  | { status: "queued"; position: number }
  | { status: "running"; startedAt: number }
  | { status: "done"; startedAt?: number; endedAt: number; outcome: RunOutcome; usage?: Usage;
      answer?: { entryId: string; text: string } }
);

type RunOutcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "intercepted" }    // a command or an extension took the message; no model was called
  | { status: "interrupted" }    // the process stopped while it ran; derived when read
  | { status: "canceled"; by: "cancel" | "abort" | "delete" }   // includes a queued run withdrawn before it started
  | { status: "failed"; error: AgentError };

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }

interface Session {
  runs: {
    get(key: { runId: string } | { idempotencyKey: string }): Promise<RunStatus | undefined>;
    follow(runId: string, options?: { after?: string }): AsyncIterable<SessionEvent>;
    cancel(runId: string): Promise<Result>;
  };
}
```

- `answer` is the run's last agent message.
- `runs.follow` is the session's events for that run, from a cursor: a caller that lost its invoke stream reattaches
  without following the whole session.
- `runs.cancel` withdraws a queued run, which ends `canceled` without starting, or stops a running one. Runs queued
  after it start as usual.
- A session holds at most 20 queued runs, the cap a conversation's wake-ups already have, and a process caps its runs
  in flight, queued and running together. Past either, and for `whenBusy: "reject"`, an invoke is rejected with
  `busy`, whose `details.reason` says which: `running` (with the running `runId`), `queue_full` or `capacity`.
- `run_started` and `run_ended` are entries in the session's log (§7.5), so a run's status after the fact is read from
  the log. A run that started and never ended, and is not running, is reported `interrupted`. Whether queued runs
  survive a restart, and whether a running one continues after it, depend on the harness (`durableQueue`,
  `durableRuns`, §9.3). The service never reruns a run: its tools may already have had effects (§3.1, invariant 3).

### 7.4 Sessions

```ts
interface Agent {
  sessions: {
    create(options?: { sessionId?: string; fork?: { sessionId: string; entryId?: string } }): Promise<{ sessionId: string }>;
    list(): Promise<SessionSummary[]>;
    get(sessionId: string): Session;
  };
  info(): AgentInfo;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}

interface Session {
  readonly sessionId: string;
  read(options?: { after?: string; before?: string; limit?: number }):
    Promise<{ state: SessionState; entries: Entry[]; next?: string; prev?: string }>;
  follow(options?: { after?: string }): AsyncIterable<SessionEvent>;
  attachment(ref: string): Promise<Attachment | undefined>;
  abort(): Promise<AbortResult>;
  rewind(entryId: string): Promise<Result>;
  compact(options?: { instructions?: string }): Promise<Result>;
  // the control plane (§7.7)
  update(settings: { name?: string; model?: string; thinkingLevel?: string }): Promise<Result>;
  delete(): Promise<Result>;
}

interface SessionState {
  name?: string;
  status: "idle" | "running" | "compacting";
  run?: { runId: string; startedAt: number };
  queued: { runId: string; idempotencyKey?: string; preview: string }[];
  model?: string; thinkingLevel?: string; thinkingLevels?: string[];
  context?: { tokens?: number; window?: number };
  leafEntryId?: string;
}

interface SessionSummary {
  sessionId: string; name?: string; status: "idle" | "running";
  createdAt: number; updatedAt: number; preview?: string;
}

type AbortResult =
  | { ok: true; stopped: { runId?: string; queued: string[]; compaction: boolean } }
  | { ok: false; error: AgentError };
```

- **`create`** names the session, or lets the service name it, and is the only way to fork: the new session starts
  with the source's history, up to `entryId` or all of it. A session that already exists is a `conflict`. An invoke
  into a session that does not exist yet creates it empty.
- **`read`** returns the state and one page of history, after or before a cursor; `limit: 0` reads the state alone.
- **`follow`** catches up on the history after a cursor, then continues with live events; without a cursor it starts
  from the beginning. A client that opens a session reads its latest page, then follows from its last entry. Every
  harness keeps an ordered log, so the port only reads it after a cursor and the serving layer builds `follow` once
  for all of them (§9.1).
- **`abort`** stops everything the session is doing: the running run, every queued run and a manual compaction. It
  reports what it stopped, so a stop command can say when nothing was running. A chat's stop command calls it.
- **`rewind`** moves the session's active branch to an entry, and the next run continues from there. Nothing is
  deleted: the earlier branch stays in the history.
- **`compact`** belongs to the user plane. `update` (a session's name, model and thinking level) and `delete` belong
  to the control plane, because the operator decides what a team's agent runs on and how its conversations are named
  and kept (§7.7).
- **`list`** returns every session of the deployment: FastAgent does not know users, so a gateway in front of many
  users filters it.

### 7.5 Entries and events

```ts
interface Entry {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  runId?: string;      // the run that wrote it
  kind: string;        // the known kinds below; a client skips others
  data: Json;
}
// user_message       { text, images?, idempotencyKey?, source? }
// assistant_message  { text, thinking?, toolCalls?, outcome? }
// tool_result        { toolCallId, toolName, isError, text, images? }
// run_started        {}
// run_ended          { outcome: RunOutcome, usage: Usage }
// settings_changed   { name?, model?, thinkingLevel? }
// compaction         { summary, firstKeptEntryId }

type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; runId: string; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; runId: string; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; runId: string; toolCallId: string; text: string }
  | { type: "retry_scheduled"; runId?: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "serving_error"; message: string };
```

Only `entry` events are durable, and an entry's id is the cursor. The others are live: a client that reconnects sees
the settled records, not the deltas it missed. Deltas add up to the run's current agent message until its
`assistant_message` entry arrives, so they carry no message id. Entries are ordered as appended, and each names its
parent, so forks and branches share what they inherited.

### 7.6 Results, errors and capabilities

```ts
type Result = { ok: true } | { ok: false; error: AgentError };

interface AgentError {
  code: string;
  message: string;
  retryable: boolean;   // whether the same request may succeed if sent again
  details?: Json;
}

interface AgentInfo {
  protocolVersion: string;
  capabilities: {
    steer: boolean; fork: boolean; compaction: boolean; delete: boolean;
    updatable: ("name" | "model" | "thinkingLevel")[];
    durableQueue: boolean;   // queued runs survive a restart
    durableRuns: boolean;    // a running run continues after a restart
    toolProgress: boolean; usage: boolean;
  };
}
```

Codes: `invalid_request`, `unsupported`, `not_found`, `conflict`, `busy`, `missing_model`, `auth_required`,
`model_error`, `nothing_to_compact`, `partial_update`, `unavailable`, `internal`. A harness may add codes under its
own prefix; a client that meets an unknown code acts on `retryable`.

### 7.7 Planes and HTTP

The operations are grouped by who uses them:

| Plane | For | Operations | Served |
|---|---|---|---|
| User | People talking to the agent, and clients acting for them (duang, an app's front end) | `invoke`; runs; sessions: create, list, read, follow, attachment, abort, rewind, compact; the agent's info, models and commands | `http.api`, on by default |
| Control | Operators and builders | A session's name, model and thinking level; deleting a session. Agent-wide management joins it when a client needs it | `http.control`, off by default |
| Platform | Chat platforms | Channel webhooks, each verified by its platform's signature | When a channel is defined |
| Base | Hosts | Health checks | Always |

| Operation | HTTP |
|---|---|
| `invoke` | `POST /invoke`: a stream of events (SSE); `202` with the receipt for `Accept: application/json`; an error status when rejected |
| `sessions.create`, `sessions.list` | `POST /sessions`, `GET /sessions` |
| `read`, `follow` | `GET /sessions/{s}?after=&before=&limit=`; `GET /sessions/{s}/follow?after=` (SSE, each event's `id` is its entry id, so `Last-Event-ID` resumes) |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` |
| `abort`, `rewind`, `compact` | `POST /sessions/{s}/abort`; `POST /sessions/{s}/rewind`; `POST /sessions/{s}/compact` |
| `runs.get`, `runs.follow`, `runs.cancel` | `GET /sessions/{s}/runs/{r}` or `GET /sessions/{s}/runs?idempotencyKey=`; `GET /sessions/{s}/runs/{r}/events?after=` (SSE); `POST /sessions/{s}/runs/{r}/cancel` |
| `info`, `models`, `commands` | `GET /agent`, `GET /agent/models`, `GET /agent/commands` |
| `update`, `delete` (control) | `PATCH /control/sessions/{s}` with `{ name?, model?, thinkingLevel? }`; `DELETE /control/sessions/{s}` |
| Base | `GET /health`; on AgentCore, `POST /invocations` and `GET /ping` |

Every route carries its session, so a router in front of many boxes can route by session (§10.2).

FastAgent authenticates nobody, on either plane: it is a backend service. Exposing it publicly belongs to an API
gateway in front of it, which can treat the planes differently by path, for example authenticating users on the user
plane and admitting only operators to `/control`. When authentication is needed inside FastAgent, it plugs in as
middleware, per plane. The startup report keeps listing what is served unauthenticated. On AgentCore, both planes
travel as IAM-gated `InvokeAgentRuntime` envelopes, and IAM is the gateway. Channels, schedules and wake-ups call the
protocol in process.

### 7.8 SPEC changes (v1)

`docs/SPEC.md` is rewritten as this protocol. Against v0.1:

| Section | Change |
|---|---|
| §2 | `invoke(request)` returns the receipt and then the run's events, or a single `rejected` |
| §3 | `Scope` goes. The request carries an optional `sessionId`, `whenBusy` and `idempotencyKey`; forking is `sessions.create` |
| §5 | Events are durable entries and live events (§7.5). `completed.data` goes: no harness produces it, and a structured result waits for a design |
| §6, the three endings | (a) the run's `run_ended` entry; (b) `rejected`; (c) the caller stops reading and detaches, while the run goes on |
| §6, MUST 1 | An invoke stream holds exactly one `rejected`, or ends with its run's `run_ended`, unless the process stops |
| §6, MUST 2 | Every failure is an event: a failed run ends with a `failed` outcome, and a refusal is `rejected` |
| §6, MUST 3 | Reversed: a caller that stops reading detaches; `runs.cancel` and `abort` stop work |
| §6, MUST 4 | The terminal set changes once, from `{ completed, failed }` to `{ run_ended, rejected }`, and is frozen again |
| §6, MUST 6 | Weaker: while a run is active, a session's calls must reach the process running it; portable conformance needs a session router in front (§9.3). `conformance-levels.md` says so with v1 |
| §7 | `collect` returns the run's answer when it ends `completed`, and throws on any other outcome or on `rejected` |
| §8 | The lineage, identity and source rows are replaced by §7.2 and §7.4; the mid-turn steering row by `whenBusy`, `runs.cancel` and `abort` |
| New | The session operations (§7.3, §7.4), the planes (§7.7), and the harness port (§9.1) |

### 7.9 Compatibility with ACP

Compatibility is checked in both directions, so the protocol stays expressible in ACP without being bound to it:

- **FastAgent as an ACP agent.** A bridge on stdio, for local editors, and at `/acp`, for remote clients, projects the
  protocol onto ACP v1: `session/new` creates a session the service names, `session/prompt` invokes and answers when
  the run ends, with the outcome mapped to a `stopReason`, `session/cancel` aborts, `session/list` lists, and
  `session/load` and `session/resume` follow the session with and without replaying its history. `session/delete`
  and the model and thought-level options are offered only where the control plane is served. `session/update`
  carries the events. ACP's own compatibility kit
  checks the bridge; its v2 drafts (the prompt receipt, `state_update`, inject, fork, resume with replay, the remote
  transport) are followed as they stabilize.
- **An ACP agent as a harness.** claude-agent-acp, codex-acp, Gemini CLI or dsh's ACP server plug in through the
  harness port (§9.1) with fewer capabilities: no steering under v1, no durable queue, and run boundaries written by
  the serving layer.
- **What ACP cannot express today:** caller-named sessions (the bridge maps them), idempotency keys, and a run's
  status by id. FastAgent does not use ACP's client file system and terminals, permission requests or elicitation.

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
  .secrets/                                   values and grants, never in git
  .state/                                     the service's state, never in git; where it lives is the deployment's
    sessions/<time>_<id>.jsonl                  each session's record: an append-only log of entries (§3.5)
    schedule/                                   schedules' claims and history, pending wake-ups
    channels/<kind>/                            what a channel owes (turns), redelivery dedup, attachments
```

A declaration that has a standard format, or that the agent, a `fastagent` command or another tool writes, is a file of
its own: contexts (`fastagent context add`), MCP servers (`mcp.json`, which `pi mcp add -l` writes), schedules (the
agent). None of them edits TypeScript, and each is in a format others already read or plain enough for a model to
write. The config keeps what only the author sets and nothing standard describes: the model, the environment (§4),
serving and deploy options, and `tools`, code tools defined in code beside `tools/`. Code stays code (`tools/`,
`channels/`, `extensions/`).

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
  http: { port: 8787 },
} satisfies FastagentConfig;
```

### 8.2 The CLI

| Stage | Today | Proposed |
|---|---|---|
| Create | `init`, `add <channel>`, `add skill`, `context add/list/remove` | `context add/list/remove` edit `contexts.json`; how a local checkout is linked at `contexts/<name>/` is settled with that file's shape (§13) |
| Develop | `dev`, `chat`, `invoke`, `tool`, `info`, `models` | Unchanged: the one-off `invoke` keeps a fresh session per call, so nothing it runs can collide with a session a serving process holds |
| Ship | `deploy <host>`, `login [--deployment <host>]` | `deploy` installs `environment` in the image it generates |
| Operate | `start`, `logs`, `destroy`, `schedules list` | Unchanged |

### 8.3 Channels, schedules and wake-ups

The entry points inside FastAgent call the protocol in process, like any other caller:

| Caller | Calls |
|---|---|
| A channel | `invoke({ sessionId: the chat place, whenBusy: "queue", idempotencyKey: the platform's message id })`. A thread's first message creates its session with `sessions.create({ sessionId, fork })` from the chat's session, and treats `conflict` as already done. Its stop command calls `abort` |
| A schedule | `invoke({ sessionId: "schedule:<name>", whenBusy: "reject", idempotencyKey: the occurrence })`: an occurrence on a busy session is skipped |
| A wake-up | `invoke({ sessionId, whenBusy: "queue", idempotencyKey: the wake-up and its instant })`: one that fires into a busy session runs after the running run |

Where a thread forks is found through the platform's reply chain: the message the thread starts from, then each
message it replies to, nearest first. The first message in the chain that names a run decides, and the thread forks at
that run's answer. Two kinds of message name a run:

- **A message the channel posted for a run**, such as an answer or one of its chunks. The channel records each one
  with its run, in its own state and bounded per place. This finds an answer in a direct message, which quotes
  nothing.
- **A user's message that a run took**, found by its idempotency key (`runs.get({ idempotencyKey })`). This replaces
  today's search for `msg <id>` in the chat's messages, which also matches a later message that quoted the same one.

When nothing in the chain names a run, the thread forks at the chat's present. That covers a thread under a message
the agent was not asked about, and under a message the agent posted itself through a send tool, such as a schedule's
digest. Such a post is not followed back to the session that produced it: forking from there would hand that
session's other content, such as a direct conversation or what a schedule posted to other chats, to the thread's
readers. The post still reaches the thread: it is quoted in the thread's first prompt, and the chat's discussion
arrives through the place's history read from the platform ([place history](place-history.md)).

Each records its `source` on the run. Channels keep their turn store, because it is what they owe the chat. Whether
`idempotencyKey` replaces their redelivery dedup, and whether they keep their own queue, is decided when they move
(§12).

### 8.4 Clients

A client such as duang uses the user plane: the session list, `read` and `follow`, `invoke` with `queue` or `steer`,
`runs.cancel`, `abort`, `rewind` and `compact`. Naming a session and changing its model or thinking level need the
control plane. The remote client (`connectAgent`) presents the same interface as an agent opened in process
(`createAgentService`); today's two remote clients, `connectAgent` and `connectSessionControl`, become one. Clients
live outside this repository.

## 9. Architecture

### 9.1 Two contracts: the protocol and the harness port

```text
Callers ──► the serving protocol (§7)     invoke; runs; sessions
              │  the serving layer: ids and mapping, idempotency, busy rules, limits, follow, planes. Written once
              ▼
            the harness port               submit; cancel and abort; read the log; sessions; capabilities
              │
              ▼
            pi today; pi-durable, DeepSeek Harness or an ACP agent later
```

Two ways to place the queue of a busy session:

| | A: in the serving layer | B: behind the port |
|---|---|---|
| The port offers | Run one turn, steer it, stop it, read the log | Submit with a mode, cancel a run, abort a session, read the log, settings, fork |
| A harness with a durable queue (pi-durable, dsh) | Its queue goes unused, and queued runs are lost on a restart | Its queue is used, and queued runs survive a restart |
| A harness that is only a loop (pi, an ACP agent) | Works as it is | A shared run helper adds the queue, run ids and run boundaries |
| The semantics | Written once | Defined once by the protocol, and held by one conformance suite every port implementation runs |

B wins: durable harnesses are the reason to plug in pi-durable and dsh at all, and A would leave their durability
unused.

| Port operation | Means |
|---|---|
| `submit(session, message, { whenBusy, idempotencyKey, source })` | Returns the run. A durable harness queues natively; the shared run helper queues for one that is only a loop |
| `cancelRun(session, runId)`, `abort(session)` | Withdraw or stop one run; stop everything the session is doing |
| `read(session, { after })`, live events | The serving layer builds `read`, `follow` and `runs.follow` on them |
| `create`, `open`, `fork`, `delete`, settings | Session lifecycle; the serving layer maps caller-named ids to the harness's own |
| Capabilities | `steer`, `fork`, `durableQueue`, `durableRuns`, and whether run boundaries are native or written by the helper |

|  | Withdraw a queued run | Stop the running run, keep the queue | Abort the session |
|---|---|---|---|
| DeepSeek Harness | `inbox.remove(id)` | `cancel(user, { keepInbox: true })` | `cancel()` |
| pi-durable | `submission.abort()` | To verify: `conversation.abort()` also withdraws queued input (§13) | `conversation.abort()` |
| pi, an ACP agent (the run helper) | Remove it from the helper's queue | The `AbortSignal` given to the turn | Both |

Steering stays a harness capability, because only the loop knows where its steps end: from outside, the serving
layer could only stop a step, killing a tool mid-call, or wait for the run to end, which is a queued run. The code and
the SPEC call this layer the engine today (`src/engines/`, "engine-neutral"); they take the name harness in a
refactor of their own (§12, step 1).

### 9.2 Layers

```text
Entry points    CLI · SDK · HTTP/SSE · channels · schedules · wake
                  ↓ every one calls the serving protocol
Serving layer   ids · idempotency · busy rules and limits · follow · planes · triggers (the scheduler) · credentials
                  ↓ the harness port
Harness         pi today; others later
                  ↓ storage: the state root (a filesystem today)
Works with      Contexts (contexts/<name>/) · Connectors (tools, MCP) · Environment (the image, or the machine)
```

### 9.3 Runs and durability

What a caller reads after the fact comes from the session's log: its entries, including each run's `run_started` and
`run_ended`, which a harness writes natively (dsh's turn boundaries, pi-durable's settled submissions) or the run
helper writes for it. A run's status is derived from the log and the queue. A run that started, never ended and is
not running is `interrupted`; the helper writes its closing entry when the session next runs, as dsh does. Only live
events, and for a harness that is only a loop the helper's queue and current run, are held in memory.

| What happens | A running run | A queued run |
|---|---|---|
| The caller stops reading | Continues | Stays queued, and runs in its turn |
| `runs.cancel` | Stops: `canceled` by `cancel` | Withdrawn: `canceled` by `cancel` |
| `abort` | Stops: `canceled` by `abort` | Withdrawn: `canceled` by `abort` |
| The process stops: a restart or a deploy | Continues with `durableRuns`; otherwise ends `interrupted`, and what it recorded stays | Stays queued with `durableQueue`; otherwise lost |

The service never reruns a run: its tools may already have had effects (§3.1, invariant 3). A caller that owes an
answer invokes again with the same idempotency key; the channels do, from their turn stores.

Process affinity exists only while a run is active, and routing across instances belongs to a session router above
FastAgent ([session control](session-control.md) §9). FastAgent's deployments meet it by topology: one process per
agent on a resident host, and on AgentCore the microVM of the runtime session the call names. Scaling out keeps it by
giving each conversation its own runtime session, and every route and envelope carries its session (§10.2). This is
weaker than SPEC MUST 6, which forbids requiring a session's invocations to land in one process: a queued run in a
helper's memory, or a steer, is state only the process running the session holds. Portable conformance needs that
router in front (§7.8).

### 9.4 Where state lives

| Where | Holds | In git, and on a deploy |
|---|---|---|
| The definition | Identity, behavior, skills, tools, triggers, the config | In git; built into the image |
| `.state/` | The service's state: session records, schedule claims, wake-ups, channel state | Not in git; where the deployment puts it (§10.2) |
| `contexts/<name>/` | Each context, as this place reaches it: a clone, a link, a mount | Not in git; on a host, a link into the host's storage |
| `.secrets/` | Values and grants | Not in git; values reach the host through its secret store |

### 9.5 Principal

Deferred. Channels already write the sender into the prompt, which is what the agent needs today, and every run
records its `source`: the channel, schedule, wake-up or API call that started it (§7.3). A structured principal, who
the person was, comes with permissions, when they are designed, and is then asserted this way:

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
to its conversation's runtime session, which every route and envelope makes possible by carrying its session (§7.7),
and what spans conversations (redelivery dedup, the session list, schedules) to live outside any one of them (§13).

### 10.3 Operations

`logs` shows what the service printed. What an agent is doing is each session's state and runs (`read`, `runs.get`),
and what it cost is in each run's `run_ended` entry, which carries its usage.

## 11. What changes in FastAgent

| Area | Today | Proposed |
|---|---|---|
| Environment | `deploy.apt` in the config | `environment`: `apt`, `npm`, `pip` and `run`, which `deploy` turns into the install steps of the image it generates (§4) |
| Declarations | What the agent works with, in the TypeScript config | A declaration with a standard format, or one the agent or a tool writes, is a file of its own; the config keeps what only the author sets (§8.1) |
| Contexts | `contexts` in the config, cloned into `.contexts/` | `contexts.json`; each at `contexts/<name>/`: a clone, a link to the author's checkout, a mount (§8.1). Later, more storage kinds; writable contexts as long-term memory |
| State | `.state/` on the host's storage | Declared apart from the contexts; on AgentCore, API storage when scaling out (§10.2) |
| Code tools | One per file directly in `tools/`, default-exported; helpers kept outside | Every `defineTool` value exported from any module below `tools/`; helpers beside them (§8.1) |
| Connectors | `tools/`, channel send tools; MCP off when serving | MCP servers in `mcp.json` (#678); a service without MCP through a CLI, code tools or an MCP server of one's own; all listed by `fastagent info` (§5) |
| Credentials | Declared by tools and channels; one value file and the model's grants | Declared by everything that uses one (§6) |
| The contract | The Agent Handler SPEC v0.1: `invoke(scope, prompt)` and a stream that ends with the caller | The serving protocol (§7): sessions, runs that outlive their callers, entries and events, idempotency keys |
| Sessions | Named by the caller; created by an invoke or an `update` | Named by the caller or by the service; created by an invoke or by `sessions.create`, the only way to fork (§7.4) |
| A busy session | Rejected; each caller waits its own way | `whenBusy`: `queue` (the default), `steer`, `reject` (§7.2) |
| Stopping and steering | `abort`, `steer` and `followUp` on the session | `runs.cancel` and the session's `abort`; steering through `invoke` (§7.3, §7.4) |
| HTTP | `POST /invoke` (`http.invoke`) and `/control/*` (`sessionControl`) | The user plane (`http.api`) and the control plane (`/control`, `http.control`) (§7.7) |
| The harness boundary | `Agent` is both what callers use and what pi implements | Two contracts: the protocol above, the harness port below, with the queue behind the port (§9.1) |
| AgentCore | One fixed runtime session for every entry point | A runtime session per conversation (§10.2) |
| The agent's own changes on a host | Lost at the next deploy | Designed later (#605) |

## 12. Order of work

| Step | Work |
|---|---|
| 0 | Finish this design |
| 1 | Rename engine to harness in the code and the SPEC: a refactor, no change in behavior |
| 2 | Upgrade to pi 1.0.4 |
| 3 | Declarations as files: `mcp.json` (#678), `contexts.json` and `contexts/<name>/`; `tools/` anchored on `defineTool`; `environment` with `apt`, `npm`, `pip` and `run` |
| 4 | The serving protocol (§7) on the harness port (§9.1), with the run helper for pi, and its conformance suite; the SPEC rewritten; channels, schedules, wake-ups and duang move to it |
| 5 | ACP compatibility in both directions (§7.9) |
| 6 | Scaling out on AgentCore: a runtime session per conversation, and state in API storage (§10.2) |
| Later | The agent's update loop (#605); evaluation; pi-durable and DeepSeek Harness as harnesses; more context kinds |

## 13. Open questions

Each is settled when the step that needs it is built (§12).

1. The shape of `contexts.json` (naming a context's credential); where an MCP server's OAuth tokens live for a
   deployed agent.
2. The final error codes, the cap on runs in flight, and the page limits of `read`.
3. Scaling out on AgentCore: routing each message to its conversation's runtime session; a lease that holds across
   processes; how state is split by writer (each conversation's own, and what spans conversations: redelivery dedup,
   the session list, schedules); which API storage holds each part. Pending wake-ups are part of it: a deploy must
   not wipe them.
4. pi-durable as a harness: reading its log after a cursor, and stopping a running run while its queue stays.
5. What the port adds for a harness whose runs continue after a restart (`durableRuns`); harnesses may differ.
6. Contexts that are not directories, such as S3.
7. Acting as the member who asked (§6.3), with permissions.

## 14. Decisions made in review

The product and the model:

- A unit above agents (a team, members, a shared deployment) is outside FastAgent; sharing is through the contexts
  and connectors several agents declare.
- `Agent = model + harness + context`: the model from a model provider, the harness pi (the loop that runs an agent,
  as the ecosystem uses the word), and the context everything it works with from outside. FastAgent defines the agent
  and composes the three in its definition, its own directory, which the agent model called the harness until this
  review, and serves the result.
- The context is declared side by side, not nested: contexts (the data it works on and knows), connectors (the other
  systems it reaches) and environment (what the deployment provides). The test in §3.2 separates contexts from
  connectors.
- The deployed environment is declared in the config as `environment`: package lists (`apt`, `npm`, `pip`) and `run`
  shell commands for the rest, which `deploy` turns into the install steps of the image it generates. `pip` installs
  into a virtual environment on the `PATH`. An author's own `Dockerfile` stays the way to own the whole image, and
  locally the machine still lends its environment (§4).
- Credentials are declared by the code or configuration that uses them and stored by how they are obtained (§6). The
  shell keeps inheriting the process environment; isolation waits for a sandboxed environment (§6.4).
- A declaration that has a standard format, or that the agent or a tool writes, is a file of its own (contexts, MCP
  servers, schedules); the config keeps what only the author sets and nothing standard describes: the model, the
  environment, serving and deploy options, and `tools` (§8.1).
- Contexts are declared in `contexts.json` (JSON, a map by name, with a description for the agent and a JSON Schema),
  and each is materialized at `contexts/<name>/`: a clone, a link to the author's checkout, or a mount, never
  committed (§8.1).
- A service that speaks MCP is declared in `mcp.json` at the root, in pi's format (`.pi/mcp.json` is read too). A
  service without MCP is reached through a CLI and a skill, code tools, or an MCP server of one's own: there is no
  connector file type, and `fastagent info` lists every connector (§5).
- `tools/` is anchored on `defineTool`: every value it makes, exported from any module below `tools/` (tests and
  `.d.ts` aside), is a tool, and a module that exports none is a helper. A tool is named by `defineTool({ name })`;
  only a module directly in `tools/` that exports one tool may fall back to its file name. Folders only organize;
  grouping is `namespace` (§8.1).
- The deployed definition stays writable. The agent's update loop is designed later, in #605 (§2); the core now is
  serving.
- No new waiting states for human input: steering, queued runs, cancelling and aborting cover it.

The serving protocol:

- FastAgent defines its own protocol, synthesized from pi-durable and DeepSeek Harness; ACP is a compatibility target
  checked in both directions, not the contract (§7, §7.9). `docs/SPEC.md` is rewritten as this protocol (§7.8).
- The concepts a user sees are the session, the message, the run and the entry; steps stay inside the harness and
  *turn* is not used. The run is the unit a caller holds; a message is content only (§7.1).
- `invoke` keeps its name and takes one request: an optional `sessionId`, the prompt, `whenBusy` and an
  `idempotencyKey`. Its stream starts with an `accepted` receipt naming the session and the run, or is a single
  `rejected`, and ends after the run's `run_ended` (§7.2).
- A session is named by the caller or created by the service. `sessions.create` is the only way to fork, and a session
  that exists is a `conflict`; an invoke into an unknown session creates it empty (§7.2, §7.4).
- A busy session: each invoke says what its message is (`whenBusy`: `queue` by default, `steer`, `reject`). A session
  holds at most 20 queued runs, and a process caps its runs in flight (§7.2, §7.3).
- An idempotency key is unique within its session and requires `sessionId`; the same key returns the same run (§7.2).
- A run outlives its caller: a caller that stops reading detaches. Runs are read, followed and canceled by id; the
  session's `abort` stops the running run, every queued run and a manual compaction (§7.3, §7.4).
- A session's history is read with `read` (state and a page, after or before a cursor) and followed with `follow`
  from a cursor; the serving layer builds both on the harness's ordered log, the same way for every harness (§7.4).
- `update` changes a session's name, model and thinking level, on the control plane, and creates nothing; moving the
  active branch is `rewind` (§7.4).
- Run boundaries are entries in the session's log, so a run's status after the fact is read from the log, and
  `interrupted` is derived when read (§7.3, §9.3).
- A thread forks at the answer of the run named by the nearest message of its reply chain: a message the channel
  posted for a run, which it records, or a user's message, by its idempotency key. When nothing names a run,
  including a post the agent made through a send tool, it forks at the chat's present; a post is never followed back
  to another session, whose other content would reach the thread's readers (§8.3).
- The operations are grouped by who uses them: the user plane (on by default) and the control plane (`/control`, off
  by default), which holds a session's name, model and thinking level, and its deletion (§7.7).
- FastAgent authenticates nobody: exposing it belongs to an API gateway in front, and authentication inside FastAgent
  would plug in as middleware (§7.7).
- Naming: fields are camelCase; enum values and discriminators are snake_case; a field that refers to another object
  names its kind (§7.1).

The architecture and deployment:

- The protocol is written once above a harness port, so another harness can be added; the queue of a busy session
  lives behind the port, so a durable harness's queue is used, and a shared run helper serves harnesses that are only
  a loop (§9.1).
- Steering is a harness capability; stopping a run is a signal the port receives (§9.1).
- After a failed run, queued runs start as usual, until a durable harness revisits it.
- `principal` is deferred until permissions are designed; a run records its `source` (§9.5).
- AgentCore is the main host, because an idle agent costs nothing there. A box is disposable by design: the program
  comes from the image and what lasts lives outside the box, so a deploy wiping the box is expected. Scaling out, a
  runtime session per conversation, is the serving goal (§10.2).
- State is declared apart from the contexts, and where it lives is the deployment's choice. On AgentCore it stays in
  the session storage until scaling out moves it to API storage; no EFS stopgap (§10.2).
- Evaluation comes later.
- The order: finish this design; rename engine to harness, in a refactor of its own; upgrade to pi 1.0.4; then
  declarations as files, with MCP (#678); then the serving protocol. The update loop and evaluation come later (§12).
- Removed or deferred after a first-principles review, because nothing needs them yet: a ledger of invocations; a
  structured `result`, with which `completed.data`, which no harness produces, goes too; the environment's secrets,
  runtimes and contexts' needs, and a check of the local machine; the host-identity credential, and commands to add
  or remove connectors.
- No field is reserved for a use nobody has designed.
