---
title: Agent model
description: "What an agent is, as a program: model + harness + context, the instance that runs it in its own workspace, and how each kind of context reaches every place an agent runs. The user-facing vocabulary every later design builds on."
type: design-doc
status: proposed
---

# Agent model

**Status: proposed.** This note fixes the concepts and the vocabulary, seen from the author's side. It says what
an author declares and what an agent sees, not how it is stored or implemented, and it does not cover
synchronization, distribution or deployment (§8). Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

The test every rule here answers to: an agent an author shaped with a coding agent in their own repository runs
as a service without being rewritten, and behaves there the way it did on their machine.

## 1. The model

```text
Agent    = model + harness + context      the definition
Instance = workspace + runtime state      one running Agent
```

| Concept | Is | Contains |
|---|---|---|
| **Agent** | The definition, the way a program is | Its model, harness and contexts, as declared in its directory |
| Model | What the agent thinks with | The default model and thinking level. Credentials are not part of it |
| Harness | The program | `persona.md`, `skills/`, `tools/`, `channels/`, `routines/`, `fastagent.config.ts`, `models.json` |
| Context | The data, declared | A directory the agent works on, with a type that says how it reaches each instance (§3) |
| **Instance** | One running Agent | Its workspace and its runtime state |
| Workspace | The instance's own directory | The agent's own files, and the contexts the instance has to place itself (§4) |
| Runtime state | What the instance accumulates | Conversations, credentials, channel state, schedule state (§5) |

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own workspace and runtime state.
- One context can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent, and exactly one copy of its harness.

### What this layer guarantees

Every instance of an Agent, given the same version of its definition, runs the same program on contexts
resolved the same way: the same declarations, the same names, the same working directory, the same `AGENTS.md`,
and the same skills from its harness and its contexts. A laptop instance and a hosted one behave the same on the
same data.

The one exception is the machine's environment. What a machine lends an agent (pi's user-level skills and prompt
templates, installed pi packages, engine settings, the programs on its `PATH`) comes from that machine wherever
the agent runs, and is not compared between instances ([core](core.md) §5). A skill an agent must have
everywhere belongs in its harness or in a context.

Keeping the data itself the same across instances afterwards is not this layer's job. It belongs to
collaboration and synchronization (§8): git for a repository, a context service for what is not one.

## 2. Harness and context: program and data

The line between harness and context is the line between a program and the data it works on, not who may write
them (§6) and not how widely a change is seen.

- **Harness** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same harness at another
  project and it is the same agent working on different data.
- **Context** is what the agent works on, and what that project tells it. It stays with the project.

`AGENTS.md` is context, and so are skills a project provides. They change how the agent behaves, but they belong
to the project, not to the agent, the way a repository's `.eslintrc` changes how eslint behaves and is still the
repository's file. The agent's identity belongs in `persona.md`. One reading holds everywhere: an `AGENTS.md` is
written for whoever works in its directory. The one in a project is for the agent working on that project; the
one in an agent's own directory is for the coding agent that develops it, and is not loaded into the agent.

### They are kept apart

**An agent directory and its contexts never contain one another.** A harness and a context ask for opposite
things when a new version arrives:

| | Harness | A writable context |
|---|---|---|
| A new version | Is a release: every instance must receive it | Must not overwrite what the instance wrote |
| Lifetime | Moves with the agent, across projects | Stays with the project, across agents |

One store can hold both only when it can merge both sides' changes. A copy cannot: copying again overwrites
the instance's data, and not copying leaves the release behind. So the two live in separate directories, linked
only by the declaration. An agent's directory is its own, and often its own repository:

```text
~/agents/reviewer/            the Agent: harness, its declaration, its local instance (.state/, .secrets/)
~/code/app/                   a context: the project, which holds no agent
```

The check runs when an agent is loaded, and a nested layout is refused with the way out: move the agent directory
out, or declare another context.

A git repository can merge both sides, so an agent committed inside the repository it works on is coherent in
principle: one repository, one clone per instance, the harness running from it. It is not supported yet. Starting
strict leaves that option open; allowing it first and taking it back would break the people relying on it.

## 3. Contexts and their types

An agent declares its contexts in `fastagent.config.ts`. The first one is the **primary context**: the agent's
working directory. `init` writes the declaration from the contexts it is given ([CLI](agent-cli.md) §3):

```ts
export default {
  contexts: [{ github: "acme/app", local: "/Users/me/code/app" }],
};
```

An agent that declares no context has none: a chat-only assistant works in an empty workspace. The declaration
decides what an instance on a host receives, so it is visible in the definition instead of being a hidden
default.

### Types

A context's type says how it reaches an instance that runs somewhere else.

| Type | Declared as | On this machine | On a host | Where changes go |
|---|---|---|---|---|
| **local** | `{ local: "/Users/me/notes" }` | That directory, edited in place | Absent: deploying is refused (below) | The directory |
| **local, copied** | `{ local: "/Users/me/notes", copy: true }` | That directory, edited in place | A copy | Each instance keeps its own |
| **github** | `{ github: "acme/app" }` | A clone, or an existing checkout (`local`, below) | A clone of the same repository | Back to the repository (synchronization, §8) |

Attributes:

| Attribute | Types | Meaning | First version |
|---|---|---|---|
| `name` | all | The directory name inside the workspace. Defaults to the repository or folder name | yes |
| `copy` | local | An instance on a host gets its own copy; when it is made follows from whether the context is writable (below) | yes |
| `ref` | github | Branch, tag or commit. Defaults to the default branch | yes |
| `local` | github | A path to use on a machine where it is a checkout of that repository; otherwise the repository is cloned | yes |
| `path` | github | Primary context only: the working directory inside the repository (monorepos). The context is still the whole repository | yes |
| `readonly` | all | The agent reads it and does not write it, for example a company handbook | later |

### Rules

- **When a copy is made follows from whether the context is writable.** A writable copied context is copied once,
  when the instance is created, and belongs to that instance afterwards: copying it again on every deployment
  would destroy what that instance wrote. A `readonly` copied context is copied again on every deployment:
  there is nothing local to lose, and it always matches what was released.
- **A clone is the instance's own once made.** A later deployment does not touch an existing clone of a `github`
  context, and says so. Bringing it up to date with the repository, and the repository up to date with it, is
  synchronization (§8).
- **A local context without `copy` refuses to deploy.** The refusal names the two ways out: add `copy`, or move
  the directory to a repository and declare it as `github`. An instance never starts with a context silently
  missing.
- **A `github` context needs access.** Cloning a private repository and pushing to it take a credential: on this
  machine the user's own git credentials, on a host one held in its secret store, like any other credential of
  the instance.
- **A path in a declaration is absolute or relative to the agent's directory.** Either way it describes this
  machine; the `github` type is what makes a context independent of where anything sits.

A service for sharing and synchronizing local directories between agents, the way GitHub does for repositories,
would be another context type. It is not part of this note.

### Example: an agent with a folder of its own

A client such as duang may give a new agent a folder it creates for its work, and let the user attach folders
they already have. The agent's folder is a context like any other, separate from its definition and declared
first so it is the working directory:

```ts
export default {
  contexts: [
    { local: "/Users/me/Documents/researcher", copy: true }, // created for the agent: its notes and output
    { local: "/Users/me/Documents/papers", copy: true, name: "papers" },
    { github: "acme/handbook" },
  ],
};
```

It is a context, not the workspace, because its content is what the user expects to find on every instance of
the agent: on a laptop and when a copy runs online. Until a context-sharing service exists, an online instance
starts from a copy and keeps its own; once one exists, the type changes from a copied local directory to a
synchronized one, and nothing else in the declaration does. The workspace stays what every instance has to
itself.

## 4. Workspace

Every instance has a directory of its own: its **workspace**. The agent's own files go there (scratch work,
downloads), and it is never copied or shared. Where the instance's contexts are depends on where it runs:

| | This machine | A host |
|---|---|---|
| The workspace | `.state/workspace/` in the agent directory ([CLI](agent-cli.md) §2) | A directory in the host's storage |
| A local context | Its own directory, in place | A copy inside the workspace, under its name |
| A `github` context | The checkout `local` names; without one, a clone inside the workspace, under its name | A clone inside the workspace, under its name |

```text
workspace/            on a host
├── app/              the primary context: the agent's working directory
└── notes/            another context
```

- **The working directory is the primary context.** Commands, relative paths and authored tools start in the
  project, exactly as they did when the author ran a coding agent in that repository. On this machine it is the
  real directory (`~/code/app`), not a link to it, or the clone in the workspace when a `github` context names
  no checkout. With no context declared, the working directory is the workspace itself.
- **On a host, contexts sit side by side under their names.** A path inside the primary context means the same
  file everywhere. A reference to another context uses the location the agent is told, not a relative path
  written into a file.
- **The agent's own files stay out of the contexts.** What the agent writes for itself goes to the workspace,
  which is inside the agent directory, never inside a context. Whether those files survive a restart depends on
  the host (§8).
- **The agent is told its contexts.** For each one: its location, its type, whether it is writable, and whether
  a change there reaches other instances. Writing a finding into a context that does not travel is how
  knowledge gets lost, so the agent needs to know which is which. It is also told where its harness and its
  workspace are.
- **Project instructions come from the contexts.** `AGENTS.md` is read from the working directory up to the root
  of the primary context (the whole repository, also when `path` puts the working directory inside it), and never
  above it, so a machine's home directory does not leak into an agent that runs the same way elsewhere. Another
  context contributes the `AGENTS.md` at its root. The skills a context provides are read from every context.
  Nothing is read from the agent's own directory but its harness.
- **A tool is told where each context is.** An authored tool that works on another context reads its location
  from its context, not by guessing from the working directory.

## 5. Runtime state

What an instance accumulates while running is **runtime state**: not part of the definition and not part of any
context.

| Runtime state | Why it is not context |
|---|---|
| Conversations (sessions) | They belong to the place a conversation happens and the people in it ([participant model](participant-model.md) §5). As data, a direct message would travel with the project: committed, copied and synchronized to every agent and person working on it |
| Credentials (model logins, channel tokens, repository access) | They belong to the machine or host running the instance, and never travel with a definition |
| Channel and schedule state | Bookkeeping of one running process |

The difference shows in four places:

| | Context (data) | Runtime state |
|---|---|---|
| Who sees it | Every agent and person working on that context | This instance only |
| How the agent is given it | As files: read, search, edit | Its current conversation; other sessions through FastAgent's interfaces, not as files |
| What it follows | The context | The instance |
| Deleting the instance | Context remains | Removed with it |

This separation decides what travels and what an agent is given, not what it can open. An agent with a shell
runs with the permissions of the account running it and can read any file that account can, another agent's
`.state/` and `.secrets/` included. Keeping agents out of each other's files takes a sandbox or a separate
account, which this note does not provide.

What is worth keeping beyond one conversation becomes data when the agent, or a person, writes it into a
context. That step is explicit and visible on purpose: an implicit transfer leaves nobody able to say what an
agent knows or why. Sharing conversations as context is deferred until FastAgent provides context sharing and
merging (§8).

## 6. An agent changes itself

An agent may change its harness and its contexts while it runs: write a skill, edit its persona, add a tool,
update `AGENTS.md`, change the project. Agent harnesses are built for this: pi's own README opens with "Ask Pi to
create the prompt templates, skills, extensions, and themes you need".

When a change takes effect:

| Changed | Takes effect |
|---|---|
| `persona.md`, `skills/`, `AGENTS.md`, scripts, project files | On the next turn |
| `tools/`, `channels/`, `routines/` (code modules) | Once the instance is idle: turns already running finish, then it restarts itself |

The second row is a commitment, not today's behavior: `dev` restarts on code edits already, `start` does not.
In-process reloading of code modules was built and removed (#598, #600); restarting when idle gives the same
result for the author without it.

A change to a context reaches other instances the way that context synchronizes. A change an agent on a host
makes to its harness lasts until the next deployment ships the definition again: keeping it is a question of
where the harness comes from, which is distribution (§8). Recording a self-change, reviewing it and reverting it
belong to the tools that keep the history, not to this layer.

Whether an agent may change its own default model is open, pending the definitions in pi 1.0 and pi durable.

## 7. Vocabulary

| Use | Do not use | Why |
|---|---|---|
| Agent | preset | A shared definition is an Agent. Clients express "make my own copy" in their interface, not with a second noun |
| Instance | deployment, for a running agent | Deployment is how an instance gets onto a host (§8) |
| Workspace (new meaning) | workspace as "the agent directory's parent" | It is now the instance's own directory; the placement rule it named is gone |

A client that calls the running thing an agent (duang) maps it to an instance. Existing documents that call a
running agent a deployment ([session control](session-control.md), for one) move to "instance" with the
implementation.

## 8. Out of scope

These belong to other layers, the way a program does not do its own package management:

- **Collaboration and synchronization.** Recording an agent's changes, branches, conflicts, reverting a
  self-change, how changes in a `github` context get back to the repository, bringing a clone up to date, and
  reconciling copies that diverged. Done by external tools (git) or a future context service, not by the agent
  layer.
- **Distribution.** Sharing and copying an Agent; reusing a harness by copying it into another Agent; and where an
  instance's harness comes from. A context has a source type; a harness can have one too: the directory an author
  points at, a copy shipped with a deployment, or later a clone of the agent's own repository, from which a
  hosted agent's changes to itself survive the next deployment.
- **Deployment.** Running an instance on a host, and planning each host's storage for each context type: what
  holds a writable copy (it needs storage that survives a restart), where the workspace lives, and what a
  redeploy reports. Separating the program from its contexts is what lets each host plan this per type.
- **Context sharing.** A service through which several agents and people share and synchronize a context that is
  not a repository, and sharing conversations as context.

## 9. What changes from today

| Today | In this model |
|---|---|
| The workspace is the agent directory's parent, by placement | The agent directory and its contexts are separate directories, linked by the declaration; nesting is refused |
| The working directory is that parent | The working directory is the first declared context |
| `AGENTS.md` is read from the agent directory, and from the working directory up to the filesystem root | `AGENTS.md` is read from the working directory up to the primary context's root, plus each other context's root; never from the agent directory |
| A project's skills are found by walking up from the working directory | A context's skills are read from each context |
| A deploy seeds the whole workspace once, then replaces the definition | Each context's type decides what a host receives; the definition is shipped |
| `.secrets/` and `.state/` are part of the agent directory | They stay where they are, as the local instance's state ([CLI](agent-cli.md) §2): never part of the definition, never in a copied Agent |
| A code-module change needs a restart under `start` | The instance restarts itself once idle |
| A skill the agent writes lasts until the next deployment replaces it | The same for a hosted agent's harness, until distribution can source a harness from its own repository (§8) |
