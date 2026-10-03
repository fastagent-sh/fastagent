---
title: Agent model
description: "What an agent is, as a program: model + harness + context, the instance that runs it in its own workspace, and how each kind of context reaches every place an agent runs. The user-facing vocabulary every later design builds on."
type: design-doc
status: proposed
---

# Agent model

**Status: proposed.** This note fixes the concepts and the vocabulary, seen from the author's side. It says what
an author declares and what an agent sees, not how it is stored or implemented, and it does not cover versioning
or distribution (§8). Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

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
| Workspace | The instance's own directory | The agent's working directory; every context appears inside it by name (§4) |
| Runtime state | What the instance accumulates | Conversations, credentials, channel state, schedule state (§5) |

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own workspace and runtime state.
- One context can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent.

## 2. Harness and context: program and data

The line between harness and context is the line between a program and the data it works on, not who may write
them (§6) and not how widely a change is seen.

- **Harness** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same harness at another
  project and it is the same agent working on different data.
- **Context** is what the agent works on, and what that project tells it. It stays with the project.

`AGENTS.md` is context, and so are skills a project provides. They change how the agent behaves, but they belong
to the project, not to the agent, the way a repository's `.eslintrc` changes how eslint behaves and is still the
repository's file. The agent's identity belongs in `persona.md`.

## 3. Contexts and their types

An agent declares its contexts in `fastagent.config.ts`. `init` scaffolds the declaration for the layout it
creates, so the common case is written down rather than implied:

```ts
export default {
  // app/fastagent/ working on app/, which is the GitHub repository acme/app
  contexts: [{ github: "acme/app", local: ".." }],
};
```

An agent that declares no context has none: a chat-only assistant gets an empty workspace. The declaration
decides what a deployment carries, so it is visible in the definition instead of being a hidden default.

### Types

A context's type says how it reaches an instance that runs somewhere else.

| Type | Declared as | On this machine | On another deployment | Where changes go |
|---|---|---|---|---|
| **local** | `{ local: "../notes" }` | That directory, edited in place | Absent: deploying is refused (below) | The directory |
| **local, copied** | `{ local: "../notes", copy: true }` | That directory, edited in place | A copy | Each deployment keeps its own |
| **github** | `{ github: "acme/app" }` | A clone, or an existing checkout (`local`, below) | A clone of the same repository | Back to the repository (versioning, §8) |

Attributes:

| Attribute | Types | Meaning | First version |
|---|---|---|---|
| `name` | all | The directory name inside the workspace. Defaults to the repository or folder name | yes |
| `copy` | local | Each deployment gets a copy | yes |
| `ref` | github | Branch, tag or commit. Defaults to the default branch | yes |
| `local` | github | A path to use on a machine where it is a checkout of that repository; otherwise the repository is cloned | yes |
| `readonly` | all | The agent reads it and does not write it, for example a company handbook | later |
| `path` | github | Only a subdirectory of the repository (monorepos) | later |

Rules:

- **When a copy is made follows from whether the context is writable.** A writable copied context is copied once,
  when the instance is created, and belongs to that instance afterwards: copying it again on every deployment
  would destroy what the deployed agent wrote. A `readonly` copied context is copied again on every deployment:
  there is nothing local to lose, and it always matches what was released.
- **A local context without `copy` refuses to deploy.** The refusal names the two ways out: add `copy`, or move
  the directory to a repository and declare it as `github`. A deployment never starts with a context silently
  missing.
- **A copied context does not carry the agent's own directory.** When the harness sits inside a context
  (`app/fastagent/` inside `app/`), the copy leaves the agent directory out. The harness reaches a deployment as
  the definition, and a second copy inside the context would be one the running agent does not use. A `github`
  context has the same overlap, since its clone contains the agent directory when that directory is committed.
  Which of the two a deployment runs is open: running the harness from the clone would give self-changes the
  repository's history, which is a versioning question (§8).
- **Paths in a declaration are relative to the agent's directory.** They describe this machine's layout; the
  `github` type is what makes a context independent of where anything sits.

A service for sharing and synchronizing local directories between agents, the way GitHub does for repositories,
would be another context type. It is not part of this note.

## 4. Workspace

Every instance gets a new directory of its own: its **workspace**. It is the agent's working directory, and it is
never copied or shared.

```text
workspace/            the agent's cwd: its own files, scratch work, downloads
├── app/              context acme/app
└── notes/            context ../notes
```

- **Every context appears inside the workspace under its name.** The same name on every deployment, so a
  routine's prompt, a skill or `AGENTS.md` can say `app/CHANGELOG.md` and mean the same file everywhere.
- **The agent's own files stay out of the contexts.** What the agent writes for itself lands in the workspace,
  not in a repository it shares with others.
- **The agent is told its contexts.** For each one: its directory, its type, whether it is writable, and whether
  a change there reaches other deployments. Writing a finding into a context that does not travel is how
  knowledge gets lost, so the agent needs to know which is which.
- **Project instructions come from each context.** `AGENTS.md` at a context's root and the skills a context
  provides are read from every context, not by walking up from the working directory. An agent works in a
  context with `cd app && …` or with paths under `app/`.
- **A tool reads a context's location from its context, not from `cwd`.** An authored tool that works on project
  files is told where each context is.

## 5. Runtime state

What an instance accumulates while running is **runtime state**: not part of the definition and not part of any
context.

| Runtime state | Why it is not context |
|---|---|
| Conversations (sessions) | They belong to the place a conversation happens and the people in it ([participant model](participant-model.md) §5). As data, a direct message would be readable by every agent working on the project |
| Credentials | They belong to the machine or host running the instance, and never travel with a definition |
| Channel and schedule state | Bookkeeping of one running process |

The difference shows in four places:

| | Context (data) | Runtime state |
|---|---|---|
| Who sees it | Every agent and person working on that context | This instance only |
| How the agent reads it | As files: read, search, edit | Its current conversation only; other sessions through FastAgent's interfaces, not as files |
| What it follows | The context | The instance |
| Deleting the instance | Context remains | Removed with it |

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
| `tools/`, `channels/`, `routines/` (code modules) | Between turns: the instance notices its code changed and restarts itself |

The second row is a commitment, not today's behavior: `dev` restarts on code edits already, `start` does not.
In-process reloading of code modules was built and removed (#598, #600); restarting between turns gives the
same result for the author without it.

Whether an agent may change its own default model is open, pending the definitions in pi 1.0 and pi durable.

## 7. Vocabulary

| Use | Do not use | Why |
|---|---|---|
| Agent | preset | A shared definition is an Agent. Clients express "make my own copy" in their interface, not with a second noun |
| Instance | deployment, for a running agent | Deployment is how an instance gets onto a host (§8) |
| Workspace (new meaning) | workspace as "the agent directory's parent" | It is now the instance's own working directory; the placement rule it named is gone |

A client that calls the running thing an agent (duang) maps it to an instance.

## 8. Out of scope

These belong to other layers, the way a program does not do its own package management:

- **Versioning and merging.** Recording an agent's changes, branches, conflicts, reverting a self-change, and how
  changes in a `github` context get back to the repository.
- **Distribution.** Sharing and copying an Agent; reusing a harness by copying it into another Agent.
- **Deployment.** Running an instance on a host.
- **Context sharing.** A service through which several agents and people share and synchronize a context that is
  not a repository, and sharing conversations as context.

## 9. What changes from today

| Today | In this model |
|---|---|
| The workspace is the agent directory's parent, by placement | Each instance has its own workspace; what the agent works on is declared as contexts |
| `AGENTS.md` is read from the agent directory and the workspace's ancestors | `AGENTS.md` is read from the root of each context |
| A project's skills are found by walking up from the working directory | A context's skills are read from each context |
| A deploy seeds the whole workspace once, then replaces the definition | Each context's type decides what a deployment receives |
| `.secrets/` and `.state/` live inside the agent directory | They are the instance's runtime state, not part of the definition |
| A code-module change needs a restart under `start` | The instance restarts itself between turns |
| A skill the agent writes lasts until the next deployment replaces it | The agent may change itself; keeping that change across deployments is versioning (§8) |
