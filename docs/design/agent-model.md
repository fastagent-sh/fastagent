---
title: Agent model
description: "What an agent is, as a program: model + harness + context, the instance that runs it, and what each part owns. The user-facing vocabulary every later design builds on."
type: design-doc
status: proposed
---

# Agent model

**Status: proposed.** This note fixes the concepts and the vocabulary, seen from the author's side. It does not
say how they are stored or implemented, and it does not cover versioning or distribution (§6). Tracking issue:
[#684](https://github.com/fastagent-sh/fastagent/issues/684).

## 1. The model

```text
Agent = model + harness + context
```

An **Agent** is a definition, the way a program is: what it runs on, the program, and the data it works on. An
**instance** is one running Agent.

| Concept | Is | Contains |
|---|---|---|
| **Agent** | The definition | Its model, harness and context, as declared in its directory |
| Model | What the agent thinks with | The default model and thinking level. Credentials are not part of it |
| Harness | The program | `persona.md`, `skills/`, `tools/`, `channels/`, `routines/`, `fastagent.config.ts`, `models.json` |
| Context | The data | `AGENTS.md`, the project's files and documents, skills the project provides (`.agents/skills/`) |
| **Instance** | One running Agent | Its runtime state: conversations, credentials, channel state, schedule state |

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own runtime state.
- One context can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent.

## 2. Harness and context: program and data

The line between harness and context is the line between a program and the data it works on, not who may write
them (§4) and not how widely a change is seen.

- **Harness** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same harness at another
  project and it is the same agent working on different data.
- **Context** is what the agent works on, and what that project tells it. It stays with the project.

`AGENTS.md` is context, and so are skills a project provides. They change how the agent behaves, but they belong
to the project, not to the agent, the way a repository's `.eslintrc` changes how eslint behaves and is still the
repository's file. An `AGENTS.md` inside an agent's own directory is context only when that directory is part of
the agent's context; the agent's identity belongs in `persona.md`.

An agent declares its context in `fastagent.config.ts` as a path relative to its own directory:

```ts
export default {
  context: "..", // the default: the directory the agent sits in
};
```

The default is the layout `init` creates today (`app/fastagent/` works on `app/`). How that path maps to a
location on another machine is a distribution question (§6).

A definition may name several contexts, one of them primary: the primary context is the agent's working
directory. The first implementation supports one.

## 3. Instance and runtime state

An instance is one running Agent. What it accumulates while running is **runtime state**, not part of the
definition and not part of the context:

| Runtime state | Why it is not context |
|---|---|
| Conversations (sessions) | They belong to the place a conversation happens and the people in it ([participant model](participant-model.md) §5). As data, a direct message would be readable by every agent working on the project |
| Credentials | They belong to the machine or host running the instance, and never travel with a definition |
| Channel and schedule state | Bookkeeping of one running process |

The difference shows in four places:

| | Context (data) | Runtime state |
|---|---|---|
| Who sees it | Every agent and person working on the project | This instance only |
| How the agent reads it | As files: read, search, edit | Its current conversation only; other sessions through FastAgent's interfaces, not as files |
| What it follows | The project | The instance |
| Deleting the instance | Context remains | Removed with it |

What is worth keeping beyond one conversation becomes data when the agent, or a person, writes it into the
context. That step is explicit and visible on purpose: an implicit transfer leaves nobody able to say what an
agent knows or why. Sharing conversations as context is deferred until FastAgent provides context sharing and
merging (§6).

## 4. An agent changes itself

An agent may change its harness and its context while it runs: write a skill, edit its persona, add a tool,
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

## 5. Vocabulary

| Use | Do not use | Why |
|---|---|---|
| Agent | preset | A shared definition is an Agent. Clients express "make my own copy" in their interface, not with a second noun |
| Instance | deployment, for a running agent | Deployment is how an instance gets onto a host (§6) |
| Context | workspace | Workspace meant "the agent directory's parent", a placement rule this model replaces |

A client that calls the running thing an agent (duang) maps it to an instance.

## 6. Out of scope

These belong to other layers, the way a program does not do its own package management:

- **Versioning and merging.** Recording an agent's changes, branches, conflicts, reverting a self-change.
- **Distribution.** Sharing and copying an Agent; reusing a harness by copying it into another Agent.
- **Deployment.** Running an instance on a host, and keeping the context of a laptop instance and a hosted one
  in step.
- **Context sharing.** Several instances and people writing one context, and sharing conversations as context.

## 7. What changes from today

| Today | In this model |
|---|---|
| The workspace is the agent directory's parent, by placement | The context is declared (`context`, default `..`) |
| `AGENTS.md` is read from the agent directory and the workspace's ancestors | `AGENTS.md` is read from the context |
| `.secrets/` and `.state/` live inside the agent directory | They are the instance's runtime state, not part of the definition |
| A code-module change needs a restart under `start` | The instance restarts itself between turns |
| A skill the agent writes lasts until the next deployment replaces it | The agent may change itself; keeping that change across deployments is versioning (§6) |
