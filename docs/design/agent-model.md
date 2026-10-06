---
title: Agent model
description: "What an agent is, as a program: model + harness + context, the instance that runs it, what it works on and what it knows, and how each kind of context reaches every place an agent runs. The user-facing vocabulary every later design builds on."
type: design-doc
status: proposed
---

# Agent model

**Status: proposed.** This note fixes the concepts and the vocabulary, seen from the author's side. It says what
an author declares and what an agent sees, not how it is stored or implemented, and it does not cover
synchronization, distribution or deployment (§8). Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

The test every rule here answers to: an agent an author shaped with a coding agent runs as a service without being
rewritten, and behaves the same wherever it runs.

## 1. The model

```text
Agent    = model + harness + context      the definition
Instance = runtime state                  one Agent's life in one place
```

What an author thinks: **I created an agent. It works on some things, and it knows others.**

| Concept | Is | Contains |
|---|---|---|
| **Agent** | The definition, the way a program is | Its model, harness and contexts, as declared in its directory |
| Model | What the agent thinks with | The default model and thinking level. Credentials are not part of it |
| Harness | The program: who the agent is and how it works | `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills/`, `prompts/`, `tools/`, `channels/`, `routines/`, `extensions/`, `fastagent.config.ts`, `models.json`, `models-store.json`, `package.json`, `.agents/skills/`, and pi's project files in `.pi/` (`settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills/`, `prompts/`); §2 lists where each format comes from and which wins |
| Context | The data: a directory the agent **works on** (writable) or **knows** (read-only) | A project, a folder, a repository. Its type says how it reaches each instance (§3) |
| **Instance** | One Agent in one place: on this machine, or on one host | Its runtime state: conversations, credentials, channel state, schedule state, and what it fetched (§5). It exists while no process runs; one or more processes serve it (a `dev`, a `start`, a one-off `invoke`) |

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own runtime state.
- One context can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent, and exactly one copy of its harness.

### What this layer guarantees

Every instance of an Agent, given the same version of its definition, runs the same program on contexts
resolved the same way: the same declarations, the same names, the same working directory (its own), the same
`AGENTS.md`, and the same skills from its harness and its contexts. A repository an instance clones is brought to its
declared version at each start while it holds nothing of the agent's (§3). A checkout the user names with `local` is the exception: it
is read as the user left it, and a difference from the declared version is reported, not corrected. A laptop instance and a hosted one behave the same on the same data.

The one exception is the machine's environment. What a machine lends an agent (pi's user-level skills and prompt
templates, `.agents/skills` found above the agent directory, installed pi packages, engine settings, the programs
on its `PATH`) comes from that machine wherever the agent runs, and is not compared between instances
([core](core.md) §5). A skill an agent must have everywhere belongs in its harness or in a context. A machine
never lends a system prompt: its `~/.pi/agent/SYSTEM.md` and `APPEND_SYSTEM.md` are not read, because a prompt
from someone's machine would make the agent theirs.

Keeping the data itself the same across instances afterwards is not this layer's job. It belongs to
collaboration and synchronization (§8): git for a repository, a context service for what is not one.

## 2. Harness and context: program and data

The line between harness and context is the line between a program and the data it works on, not who may write
them (§6) and not how widely a change is seen.

- **Harness** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same harness at another
  project and it is the same agent working on different data.
- **Context** is what the agent works on or knows, and what that project tells it. It stays with the project.

`AGENTS.md` is context, and so are skills a project provides. They change how the agent behaves, but they belong
to the project, not to the agent, the way a repository's `.eslintrc` changes how eslint behaves and is still the
repository's file. An identity of the agent's own belongs in `SYSTEM.md`; `APPEND_SYSTEM.md` holds standing
instructions added to pi's default (below). One reading holds everywhere: an `AGENTS.md` is
written for whoever works in its directory. The one in a project is for the agent working on that project. The
one in an agent's own directory is for whoever changes the agent: the coding agent that develops it, or the agent
itself. It is not loaded into every turn, since most turns do not change the agent; the agent is told where it is
and reads it before changing itself (§4).

### Formats, and which one wins

Only the markdown is an open standard. Code has no cross-tool standard to follow, so it is FastAgent's own
interface or pi's, and the definition says which:

| Files | Format | From |
|---|---|---|
| `AGENTS.md` (in a context) | Markdown | Open standard ([agents.md](https://agents.md)) |
| `skills/<name>/SKILL.md` | Markdown with frontmatter | Open standard ([Agent Skills](https://agentskills.io/specification)) |
| `tools/`, `channels/`, `routines/`, `fastagent.config.ts` | TypeScript modules (`defineTool`, `defineChannel`, `defineRoutine`) | FastAgent |
| `SYSTEM.md`, `APPEND_SYSTEM.md`, `prompts/`, `extensions/`, `.pi/`, `models.json`, `models-store.json` | pi's conventions and APIs | pi, the reference engine: these do not carry over to another engine |
| `<context>/<skill>` | A skill name | FastAgent's convention, not the Agent Skills specification (below) |
| `package.json` | npm | npm |

The tool standard across ecosystems is MCP, and it is not supported yet: its connections live as long as a session,
and a served session lives one turn (#678).

`tools/` holds tools. `extensions/` holds what is not a tool: event handlers, commands, model providers.

Where pi and FastAgent both have a place for the same thing, the agent directory's root is the canonical spelling
and `.pi/` is read too, for pi compatibility, below it. A name found in two places takes the first. Two places in
the definition holding the same name is reported, never silent: the author has two files and one of them does
nothing. The definition winning over the machine is not reported, because it is how an author overrides the
machine on purpose (`fastagent add skill` vendors a machine skill into `skills/` for exactly that):

| Resource | Read in this order |
|---|---|
| System prompt | `SYSTEM.md`, then `.pi/SYSTEM.md`, replace pi's default prompt; without either, pi builds its default itself, so it follows pi. `APPEND_SYSTEM.md`, then `.pi/APPEND_SYSTEM.md`, is added after it. Never the machine's (§1). FastAgent's own sections follow in every case (below) |
| Skills | `skills/`, then `.pi/skills/`, then `.agents/skills/` in the agent directory, then the machine's (§1). A context's skills are read from its `.pi/skills/`, then its `.agents/skills/`, the places pi reads a project's, and are named apart (below) |
| Prompt templates | `prompts/`, then `.pi/prompts/`, then the machine's |
| Extensions | `extensions/` only. `.pi/extensions/` is not loaded, and one that exists is reported as not loaded |

`SYSTEM.md` replaces pi's whole default: its identity line ("an expert coding assistant operating inside pi"),
its tool list, its rules and its pointers to pi's documentation. The model still receives every tool's schema.
`APPEND_SYSTEM.md` keeps the default and adds to it. So an agent that should be someone other than pi's coding
assistant writes `SYSTEM.md`, and one that only needs standing instructions writes `APPEND_SYSTEM.md`. Writing an
identity ("You are…") into `APPEND_SYSTEM.md` gives the model two.

What FastAgent adds to the prompt does not depend on either file, because an agent needs it whoever wrote the rest:

| FastAgent's section | Says |
|---|---|
| Contexts | What the agent works on and what it knows, where each is, and how to work in it (§4) |
| Changing itself | What takes effect when, where a lasting result belongs, and how long this host keeps its files (§6) |
| Tools not loaded yet | That deferred tools exist and are reached through `tool_search`, when there are any |

The rest of what FastAgent writes today (`piBasePrompt`) goes away with its identity line:

- **Authored tools stay listed.** pi's default lists a tool only when it has a `promptSnippet`. FastAgent sets one
  for each authored tool from the first line of its description, the line `piBasePrompt` lists today, so
  `defineTool` gains no field.
- **The identity has to match the tools.** pi's default says the agent reads files, runs commands and edits code,
  which is true of every agent a command opens: they all mount the coding tools. An embedder can replace them
  (`createPiAgentFromDefinition(dir, { tools })`), and then that sentence is false. So replacing the coding tools
  requires a prompt that matches what is left: the `base` option, which stays and replaces pi's default as
  `SYSTEM.md` does, or a `SYSTEM.md`. Without either, assembling the agent is refused with that reason, rather than
  serving an agent that claims tools it does not have. `createPiAgent({ instructions })` already takes its prompt
  whole.

**A context's skills carry its name.** A skill `deploy` that the context `app` provides is the skill `app/deploy`:
it is about working in `app`, and the name says so. It never collides with the agent's own `deploy`, or with
another context's, so contexts need no order and no precedence among them. Inside one context, `.pi/skills/deploy`
wins over `.agents/skills/deploy`, and the two are reported like any two places holding one name. Renaming a context renames its skills. That holds
because no other skill may have a `/` in its name. pi only warns about one, so FastAgent refuses a harness skill
named that way and leaves such a machine skill out, saying so; the slash stays the namespace's. The part after it keeps the Agent Skills
grammar; the whole name is FastAgent's convention.

**One directory, two readers.** The agent directory is also where its author develops it, often with pi itself.
pi run there treats it as a project and loads the same `.pi/` files and `.agents/skills/` the harness reads: a
`.pi/SYSTEM.md` makes the author's development session the agent, and a development skill kept in
`.agents/skills/` ("how to write a fastagent tool") ships with the agent. The root spellings (`SYSTEM.md`,
`skills/`, `prompts/`) are invisible to pi as a coding agent, which is what keeps the two readers apart; `.pi/`
and `.agents/skills/` are read for compatibility at that cost. An author who develops the agent with pi keeps
what is meant for the agent at the root, and what is meant for the development session in `AGENTS.md`.

### They are kept apart

**A declared context never contains the agent directory, and never sits inside it.** A harness and a context
ask for opposite things when a new version arrives:

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
out, or declare another context. It is about what an author declares. The clones and copies an instance makes for
itself are its own state, kept in `.state/` with the rest of it (§3); they are not declared contexts and not part
of the definition.

A git repository can merge both sides, so an agent committed inside the repository it works on is coherent in
principle: one repository, one clone per instance, the harness running from it. It is not supported yet. Starting
strict leaves that option open; allowing it first and taking it back would break the people relying on it.

## 3. Contexts

An agent declares its contexts in `fastagent.config.ts`. Their order carries no meaning. `init` and
`fastagent context` write the declaration ([CLI](agent-cli.md) §3, §4):

```ts
export default {
  contexts: [
    { github: "acme/app", local: "/Users/me/code/app" },      // works on
    { github: "acme/handbook", readonly: true },              // knows
  ],
};
```

An agent that declares no context has none: a chat-only assistant works only in its own directory. The
declaration decides what an instance on a host receives, so it is visible in the definition instead of being a
hidden default.

### Types

A context's type says how it reaches an instance that runs somewhere else. `init` and `fastagent context` infer
it from what they are given, and every command prints it (§4), so an author rarely writes one.

| Type | Declared as | On this machine | On a host | Where changes go |
|---|---|---|---|---|
| **local** | `{ local: "/Users/me/notes" }` | That directory, edited in place | Absent: deploying is refused (below) | The directory |
| **local, copied** | `{ local: "/Users/me/notes", copy: true }` | That directory, edited in place | A copy | Each instance keeps its own |
| **github** | `{ github: "acme/app" }` | An existing checkout (`local`), used as it is; otherwise a clone the instance makes | A clone the instance makes | To the repository, when pushed |

Attributes:

| Attribute | Types | Meaning | First version |
|---|---|---|---|
| `readonly` | all | The agent knows it and does not write it, for example a company handbook | yes |
| `name` | all | The context's identity within the agent: how the agent and the commands refer to it, and what an instance keeps its clone or copy under. Defaults to the repository or folder name | yes |
| `copy` | local | An instance on a host gets its own copy; when it is made follows from whether the context is writable (below) | yes |
| `ref` | github | Branch, tag or commit. Defaults to the default branch | yes |
| `local` | github | A path to use on a machine where it is a checkout of that repository; otherwise the repository is cloned | yes |
| `path` | github | Only a subdirectory of the repository (monorepos) | later |

### Rules

- **Read-only is an instruction in the first version.** The agent is told not to write a context it only knows;
  nothing stops a shell from writing it. A read-only `github` context is never pushed back.
- **A repository is the user's checkout when this machine has one, else a clone the instance makes and brings up
  to date in place.**
  - A checkout named by `local` is the user's: FastAgent never fetches it and never switches its branch. When it
    is not at the declared `ref`, startup says so.
  - Without one, the instance clones the repository at its declared `ref` the first time it starts, and at each
    later start brings that clone up to date in place by git's own rules (a fetch and a fast-forward), whether the
    agent works on it or only knows it. git refuses whatever would overwrite the agent's work, and the clone is
    then kept as it is, with the reason; so it is when the remote cannot be reached, or when the clone is on
    another branch than declared. Bringing the agent's work and the remote together is git's, the agent's or the
    user's (synchronization, §8). The clone is never replaced, so nothing the agent did is lost to a restart.
- **What a host copies follows from whether the context is writable.** A copy of a context the instance only knows
  is made again every time the instance is deployed: there is nothing local to lose, and it always matches the
  definition. A copy of one it works on is made once and belongs to the instance afterwards; a later deployment
  leaves it as it is and says so. That holds only where the instance's storage survives a deployment: a host whose
  storage a deployment resets (AgentCore, [core](core.md) §9) copies every context again, and what the instance
  wrote there is lost. Its deployment says so before it runs.
- **What an instance clones or copies, it keeps in its own storage, under the context's name.** It lives with the
  instance's runtime state (§5), not in the definition.
- **A name is one path segment, unique within the agent regardless of case.** It becomes a directory name, so it
  is letters, digits, `-` and `_`, the spelling a release's agent name already has (`isReleaseAgentName`), and two
  names that differ only in case are the same name on a case-insensitive filesystem. A name that breaks either
  rule is refused when the agent is loaded; adding a context whose default name is taken or misspelled asks for an
  explicit one.
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
they already have. The agent's folder is a context like any other, separate from its definition:

```ts
export default {
  contexts: [
    { local: "/Users/me/Documents/researcher", copy: true },           // works on: its notes and output
    { local: "/Users/me/Documents/papers", copy: true, readonly: true }, // knows
    { github: "acme/handbook", readonly: true },                       // knows
  ],
};
```

It is a context, not part of the agent's directory, because its content is data the user expects to find on
every instance of the agent: on a laptop and when a copy runs online. Until a context-sharing service exists, an
online instance starts from a copy and keeps its own; once one exists, the type changes from a copied local
directory to a synchronized one, and nothing else in the declaration does.

## 4. How the agent works

- **The working directory is the agent's own directory, everywhere.** One rule on a laptop and on a host, and an
  agent changing itself writes `skills/…` like any relative path.
- **The agent is told what it works on and what it knows.** For each context: its name, its location on this
  instance, whether it works on it or only knows it, and whether a change there reaches other instances. It is
  told that its own directory is itself, where that directory's `AGENTS.md` is for changing it, and that a result
  worth keeping belongs in a context it works on.
  Writing a finding where it does not travel is how knowledge gets lost, so the agent needs to know which is
  which.
- **Commands run in a context with `cd`.** A shell command that belongs in a project runs as
  `cd <its location> && …`; file tools take the location directly. Measured against an agent whose working
  directory is the project, and against a shell tool with a `cwd` argument, this made no difference: three models,
  180 runs, no command run in the wrong directory. So the shell tool stays as it is.
- **Project instructions come from the contexts.** Each context's `AGENTS.md` at its root is loaded, marked with
  the directory it applies to, and so are the skills each context provides from its `.pi/skills/` and
  `.agents/skills/`, named `<context>/<skill>` (§2).
  Nothing in the agent's own directory is loaded but its harness.
- **pi's project scope is the agent's own directory.** What pi reads from a project (`.pi/settings.json`, which can
  change engine settings and the built-in extensions, `.pi/` prompts and skills, packages) is read from the agent
  directory, so it is part of the definition and ships with it, the same on every instance. Nothing of pi's
  project scope is read from a context: a context contributes its `AGENTS.md` and its skills only.
- **What the agent creates lands in its own directory unless it puts it elsewhere.** Whether a file is temporary
  or part of the agent often cannot be decided when it is written: a helper script that proves useful is how a
  skill begins. The author decides what stays, with the tool every repository uses: version control and ignore
  files. What is shipped or shared is what the author keeps (§8).
- **A tool is told where each context is.** An authored tool that works on a context reads its location from its
  context, not by guessing.

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
| Deleting the instance | The context's source remains. What the instance fetched (its clones, a host's copies) goes with it, and with them anything it wrote there that was not pushed or synchronized | Removed with it |

This separation decides what travels and what an agent is given, not what it can open. An agent with a shell
runs with the permissions of the account running it and can read any file that account can, another agent's
`.state/` and `.secrets/` included. Keeping agents out of each other's files takes a sandbox or a separate
account, which this note does not provide.

What is worth keeping beyond one conversation becomes data when the agent, or a person, writes it into a
context. That step is explicit and visible on purpose: an implicit transfer leaves nobody able to say what an
agent knows or why. Sharing conversations as context is deferred until FastAgent provides context sharing and
merging (§8).

## 6. An agent changes itself

An agent may change its harness and the contexts it works on while it runs: write a skill, edit its prompt, add
a tool, update `AGENTS.md`, change the project. Agent harnesses are built for this: pi's own README opens with
"Ask Pi to create the prompt templates, skills, extensions, and themes you need".

When a change takes effect:

| Changed | Takes effect |
|---|---|
| `SYSTEM.md`, `APPEND_SYSTEM.md`, skills in the agent directory and its contexts, prompt templates in the agent directory, `AGENTS.md`, scripts, project files | On the next turn |
| What a process loads once: `tools/`, `channels/`, `routines/`, `extensions/`, `.pi/settings.json`, `fastagent.config.ts` (its `contexts` included), `models.json`, `models-store.json`, `package.json` | When each process serving the instance is idle: its running turns finish, then it restarts |

The second row is a commitment, for `dev` and `start` alike, and neither keeps it today. `start` does not restart
at all. `dev` restarts at once: its supervisor stops the worker 200 ms after the edit, so a running turn, the one
that wrote `tools/x.ts` included, is cut off, and a definition that fails to load stops `dev` until the next edit.
The commitment also covers `fastagent context add` on a running instance.

Every process serving the instance follows the rule on its own: a change made in a turn in one process restarts
another process once that one is idle, and a failure is reported in whichever process next runs a turn.

This reverses a decision. #600 removed in-process reloading of `tools/` and stated the rule `core.md` §2 and the
deployed prompt still give: an agent improves itself through skills, scripts run through `bash`, and `wake`;
`tools/`, `routines/` and `channels/` are the author's code and change with a restart or a release. Its reasons,
and how this model answers them:

- **The reload mechanism.** Reloading modules inside a running process had twelve documented limits (module
  caches per format and runtime, state leaking per reload, a helper loaded twice). A restart has none of them: it
  is a new process.
- **The need was already met.** Skills, scripts and `wake` remain the first path: they take effect on the next
  turn. A code module is a second path, for what a script cannot be: a tool with a typed interface, a channel, an
  extension. Agent harnesses now let an agent write those for itself, and this model follows them.
- **A routine written by the agent bypassed `wake`'s guards.** `wake` is mounted on every serve now (#612), so
  the guard left is its floor: a recurring wake fires at most every 10 minutes (`src/schedule/wakeups.ts`). Every
  routine is held to that floor, whoever wrote it. Telling the author's routines from the agent's would need a
  record of who wrote each file that survives a restart, and an agent can trigger a restart; one floor for all
  needs no record. A routine that must fire more often is the author's to drive from outside the agent: an
  external scheduler calling `POST /run`, the same way a host without a resident clock runs one.

One risk is new: an agent can break the module that reaches it. A process restarts only onto a definition that
loads; when the changed one does not (a tool or channel that throws while loading), the process keeps running
what it had and reports the failure to the log and to the agent's next turn. That protects a process that is
alive. The broken definition is still on disk, so the next fresh start (a machine restart, a crash, a host waking a
scaled-to-zero instance, the author running `start` again) fails to load it, and the instance serves nothing until
the definition is repaired. The failure is reported at that start, and the way back is the author's: revert the
change with version control on this machine, or deploy again on a host, which ships the definition anew. Keeping
the last definition that loaded, and starting from it with a report, would close this gap; it is not part of
this model yet. A channel that loads and then fails while handling messages is not caught either: the agent can
lose that channel until the author repairs it.

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
| works on / knows | primary context | What users see says what the agent may do with a context. No context is special |
| (nothing) | workspace | Not a concept any more: the working directory is the agent's own directory, and where an instance keeps what it fetches is storage |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | `persona.md` | `persona.md` replaced only the identity line; `SYSTEM.md` replaces pi's whole default and `APPEND_SYSTEM.md` adds to it, so neither is the same. `persona.md` is refused, naming both and when to use each |

A client that calls the running thing an agent (duang) maps it to an instance. Existing documents that call a
running agent a deployment ([session control](session-control.md), for one) move to "instance" with the
implementation.

## 8. Out of scope

These belong to other layers, the way a program does not do its own package management:

- **Collaboration and synchronization.** Recording an agent's changes, branches, conflicts, reverting a
  self-change, how changes in a `github` context get back to the repository, bringing a clone up to date, and
  reconciling copies that diverged. Done by external tools (git) or a future context service, not by the agent
  layer.
- **Distribution.** Sharing and copying an Agent, and what of its directory goes with it; reusing a harness by
  copying it into another Agent; and where an instance's harness comes from. A context has a source type; a
  harness can have one too: the directory an author points at, a copy shipped with a deployment, or later a clone
  of the agent's own repository, from which a hosted agent's changes to itself survive the next deployment.
- **Deployment.** Running an instance on a host, and planning each host's storage for each context type: what
  holds a writable copy (it needs storage that survives a restart), where fetched contexts live, and what a
  redeploy reports. Separating the program from its contexts is what lets each host plan this per type.
- **Context sharing.** A service through which several agents and people share and synchronize a context that is
  not a repository, and sharing conversations as context.

## 9. What changes from today

| Today | In this model |
|---|---|
| The workspace is the agent directory's parent, by placement | The agent directory and its contexts are separate directories, linked by the declaration; nesting is refused |
| The working directory is that parent | The working directory is the agent's own directory |
| `AGENTS.md` is read from the agent directory, and from the working directory up to the filesystem root | `AGENTS.md` is read from each context's root; never from the agent directory |
| A deploy seeds the whole workspace once, then replaces the definition | Each context's type decides what a host receives; the definition is shipped |
| `.secrets/` and `.state/` are part of the agent directory | They stay where they are, as the local instance's state ([CLI](agent-cli.md) §2): never part of the definition, never in a copied Agent |
| A code-module change needs a restart under `start`; `dev` restarts at once and cuts off a running turn | Each serving process restarts once idle, onto a definition that loads |
| `core.md` §2 and the deployed prompt say `tools/`, `routines/` and `channels/` are the author's code, and an agent improves itself through skills, scripts and `wake` | They say an agent may also change its code modules, effective once idle |
| A routine fires as often as its cron says | Every routine, the author's or the agent's, fires at most every 10 minutes, `wake`'s recurring floor |
| pi's project scope (`.pi/settings.json`, prompt templates, packages) is the workspace | It is the agent's own directory, part of the definition |
| `persona.md` replaces the identity line of a prompt FastAgent writes (`piBasePrompt`); `.pi/SYSTEM.md` is ignored | pi builds the default prompt; `SYSTEM.md` replaces it, `APPEND_SYSTEM.md` adds to it, each also read from `.pi/` |
| Prompt templates come from the workspace's `.pi/prompts/`, then the machine's | `prompts/` and `.pi/prompts/` in the agent directory, then the machine's |
| A project's skills are the workspace's `.pi/skills/` and the `.agents/skills/` found walking up to the repository root, read as the machine's; contexts do not exist | The agent directory's `.pi/skills/` and `.agents/skills/` are the definition's, `.agents/skills/` above it the machine's. Each context's `.pi/skills/` and `.agents/skills/` are its skills, named `<context>/<skill>` |
| The definition's skills silently win over the machine's | Still silent; two places inside the definition holding one name are reported |
| `createPiAgentFromDefinition` with replaced `tools` gets a non-coding identity line written by FastAgent | It needs `base` or a `SYSTEM.md`, and is refused without one |
| A skill the agent writes lasts until the next deployment replaces it | The same for a hosted agent's harness, until distribution can source a harness from its own repository (§8) |
