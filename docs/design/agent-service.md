---
title: Agent service
description: "Proposed: the concepts and contracts for agents a team builds, runs and uses together as cloud services. The world an agent acts in (environment, contexts, connectors), and invoke as a durable unit of work."
type: design-doc
status: proposed
---

# Agent service

**Status: proposed, not implemented.** It extends the [agent model](agent-model.md) and changes the
[Agent Handler SPEC](../SPEC.md) (§4.5). It answers [#688](https://github.com/fastagent-sh/fastagent/issues/688)
(what `Scope` means). §8 lists the decisions already made in review; everything else is a proposal to settle before
implementation.

## 1. Who it is for

Teams that build and maintain a set of agents together, run them in the cloud continuously, and use them from where
they already work: chat, their own apps, other agents. Four needs follow, and every section below serves one of them:

| Need | Means |
|---|---|
| Develop together | An agent is a directory in git. Every change to it, including the agent's own, can be reviewed and reverted |
| Use together | Members reach the agents from team channels and apps, and who asked matters |
| Run continuously | Work outlives a connection, a restart and a deploy |
| Share infrastructure | The knowledge, code and integrations a team's agents work with are shared, not copied |

Sharing happens through the contexts and connectors that several agents declare. A unit above agents (a team, its
members, shared secrets, one deployment target) is outside FastAgent.

## 2. The model

```text
Agent = model + definition        who it is and how it works (identity, behavior, skills, tools)
  runs in        Environment      compute
  works on       Contexts         state
  acts through   Connectors       effects
  remembers in   Sessions         conversations
  started by     Triggers         requests, messages, events, time, itself
```

### 2.1 Why three: every action has three parts

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
| Credentials | Never | Belong to the context | Belong to the connector |
| Shared across a team's agents | The declaration; each agent runs its own instance | The same state: a team asset | The same integration, with per-agent scopes |
| Fails as | A missing command, said at start | Unreachable, or a conflicting write | Authorization, rate limits, an effect whose outcome is unknown |

Three invariants follow:

1. **An environment is stateless and reproducible.** Durable data and credentials never live in it.
2. **A context is stateful and versioned.** Long-term memory and work products live there, where people can review
   and revert them.
3. **A connector is an external effect.** Authorization, approval and idempotency apply to it, more strictly than to a
   context. Merging the two would govern a payment like a file edit, or a file edit like a payment.

### 2.2 Context or connector: the test

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

### 2.3 What knowledge, memory, skills and tools are

They are uses of the three, not further categories.

| Term | Is |
|---|---|
| Knowledge | Reading contexts, and querying connectors (a search) |
| Memory | Long-term: writing to a writable context. A conversation's: its session (§2.5) |
| Skill | Know-how stored in a context, executed in the environment, possibly calling connectors |
| Tool | How an action is presented to the model. `read`, `write` and `bash` act on the environment and contexts; MCP tools and code tools are usually connectors |

### 2.4 The agent's own directory

An agent's directory is both its definition and its first, writable context. This is where it improves itself
([#605](https://github.com/fastagent-sh/fastagent/issues/605)): what an agent changes in itself is versioned and
reviewable like any other context.

### 2.5 Sessions and triggers

A **session** is a conversation's continuity: the invokes of one session share its history. It is named by the
caller, optional on `invoke` (§4.2), and may start as a fork of another session. A session is a conversation's
memory; what should outlast a conversation belongs in a context.

A **trigger** is where an invoke comes from: a request (HTTP, another agent), a message (a channel), an event (a
webhook), time (a schedule), or the agent itself (`wake`, a subagent). A channel is a trigger and a connector of one
system: messages arrive through it, and the agent's send tool posts through it.

## 3. The environment is declared

Today an agent inherits the machine it runs on, the way `bash` inherits the `PATH`, and nothing compares that machine
with a deployment; `deploy.apt` only adds apt packages to the generated image. A team's cloud agents need a
reproducible environment:

- the definition declares what it needs: commands (`git`, `ffmpeg`) and runtimes (node 22, python);
- `dev` checks the machine against it and says what is missing at start;
- `deploy` installs it into the image;
- a context may declare its own needs (a repository that requires node 22), and the agent's environment is the union
  of its own declaration and its contexts', the way contexts already contribute skills.

A possible shape, to settle (§7):

```ts
export default {
  environment: {
    commands: ["git", "ffmpeg", "rg"],   // checked by dev and at start: each must be on PATH
    apt: ["ffmpeg", "ripgrep"],          // how deploy installs what the base image lacks (today's deploy.apt)
  },
};
```

This reverses a working rule: "the machine lends the agent an environment" in AGENTS.md, "the machine is an
environment, not a dependency" in [principles.md](../principles.md), and "nobody is told their local `ffmpeg` is not
in the image". Both change when this is implemented.

## 4. Invoke

`invoke(scope, prompt)` keeps its name and its shape, and it stays the only way to start work. What one invoke means
changes: it becomes a durable unit of work, an **invocation**, which the service owns once it accepts it.

### 4.1 What changes

| | Today | Proposed |
|---|---|---|
| Ownership | A caller that stops reading aborts the work (SPEC MUST 3) | Once accepted, the work is the service's. A dropped connection does not stop it; `cancel` does |
| Identity | None | The service mints an invocation id and reports it in the first event |
| Reattach | Impossible | Any client attaches by id: the events after a cursor, then live ones |
| Retries | A retry can run the work twice | `idempotencyKey`: the same key returns the same invocation |
| A busy session | Fails with `session_busy`, and channels retry | Queued by default; `whenBusy: "reject"` keeps today's answer |
| How it ends | Two terminal events, `completed` and `failed` | One `settled` event carrying a structured outcome |

Steering, follow-ups and aborting a run stay as they are today.

### 4.2 Scope

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
  /** Who is asking, as the entry point (a channel, a gateway) authenticated them: permissions and attribution. */
  principal?: Principal;
}

interface InvokeOptions {
  idempotencyKey?: string;
  whenBusy?: "queue" | "reject";
}

/** Begins with `accepted` (the invocation id, the session), ends with `settled`. */
type Invocation = AsyncIterable<InvokeEvent>;
```

- **Facts, not choices.** Choices among the agent's options, such as a session's model and thinking level, are session
  properties set on the control plane, where the options can be listed (`models()`).
- **Whoever creates a thing names it.** Callers name sessions, because they map their places to conversations. The
  service names invocations and entries, and gives the names back: an entry id comes from a settled outcome's
  `leafEntryId` or from `entries()`.

### 4.3 Outcome, events, errors

```ts
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
recorded entries or run tools.

One event vocabulary serves the invocation's stream and a session's observation stream, so the same thing has one
name in both. Proposed: `accepted`, `user_message`, `text_delta`, `thinking_delta`, `message_finished`,
`tool_started`, `tool_progress`, `tool_finished`, `queue_changed`, `retry_scheduled` and `settled`; a session's stream
adds `state_changed` and the compaction events.

Proposed error codes, one set for every call: `invalid_request`, `unsupported`, `not_found`, `busy` (with
`whenBusy: "reject"`), `no_active_run`, `nothing_to_compact`, `missing_model`, `auth_required`, `model_error`,
`partial_update`, `unavailable`, `internal`. An engine may add codes under its own prefix; a client that meets an
unknown code acts on `retryable`.

### 4.4 Control plane

Added, by invocation: `attach(id, { after? })`, `cancel(id)` for a running or a queued invocation, and a list of
invocations by session and status, so a team can see what its agents are doing. The session operations (`state`,
`entries`, `update`, `steer`, `followUp`, `abort`, `compact`, `fork`, `delete`) are unchanged by this proposal.

### 4.5 SPEC changes (v1)

| Section | Change |
|---|---|
| §2 | `invoke` returns an invocation stream that begins with `accepted`; accepted work belongs to the service |
| §3 | The `Scope` rule (facts, never choices); `session` optional; `fork`; `principal` |
| §5 | The event vocabulary above; one terminal event, `settled` |
| §6 | MUST 1 becomes "exactly one `settled`". MUST 3 changes: a caller that stops reading detaches, and `cancel` stops the work. Portable conformance is unchanged |
| §8 | The lineage, identity and source rows are replaced by §4.2 |

## 5. Connectors are declared

Today a connector is a code tool in `tools/` or a channel's send tool. Pi's MCP extension is not loaded when serving,
because its server connections live as long as a session and a served session lives one turn
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). Proposed:

- connectors are declared in the definition beside contexts: MCP servers, and code tools;
- credentials belong to the connector that uses them (today one `.env` holds them all), scoped per agent;
- the governance in §2.1 applies here: approval rules per tool, idempotency keys for effects, and what a restart does
  to an interrupted call (rerun only when the tool declares it safe);
- an MCP connection lives as long as the process or the conversation, not one turn, which is #678.

## 6. What changes in FastAgent

| Area | Today | Proposed |
|---|---|---|
| Environment | Inherits the machine; `deploy.apt` | Declared; checked by `dev`; installed by `deploy` (§3) |
| Contexts | `local` and `github` | Unchanged; later, more storage kinds; writable contexts as long-term memory |
| Connectors | `tools/`, channel send tools; MCP off when serving | Declared; credentials per connector; #678 (§5) |
| Credentials | One `.env` per agent | Owned by a context or a connector |
| `invoke` | A function call that ends with its stream | A durable invocation (§4) |
| Durability | Written by hand: channel turn stores, schedule claims, the wake store, leases | A durable runtime underneath, such as pi-durable, if a spike shows it fits (§7) |

## 7. Open questions

1. Who authenticates `principal`: each channel (the platform's user), a gateway in front of HTTP, or both.
2. The declaration shapes of `environment` and connectors.
3. What the machine lends pi today (skills, prompt templates, engine settings) once the environment is declared.
4. The exact event vocabulary and error-code set, in the SPEC v1 draft.
5. The durable runtime: implement one path end to end (HTTP and Feishu) on pi-durable, and measure how much of
   FastAgent's own durability code it replaces.
6. Context kinds that are not directories, such as S3.

## 8. Decisions made in review

- `Scope` carries facts the caller asserts. Choices among the agent's options are made on the control plane.
- Whoever creates a thing names it: callers name sessions; the service names invocations and entries.
- `invoke` keeps its name and shape; its semantics change as in §4.
- Steering, follow-ups and aborting stay as they are; no new waiting states for human input.
- A unit above agents (a team, members, a shared deployment) is outside FastAgent; sharing is through contexts and
  connectors.
- The world an agent acts in is environment, contexts and connectors, separated by the test in §2.2.
- The environment is declared, reversing the rule that an agent inherits the machine and that nothing compares the
  two.
- No field is reserved for a use nobody has designed.
