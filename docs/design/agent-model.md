---
title: Agent model
description: "What an agent is, as a program: model + harness + context, composed by FastAgent in a definition, the instance that holds its state, the content it works on and knows, and how each kind of content reaches every place an agent runs. The user-facing vocabulary every later design builds on."
type: design-doc
status: implemented
---

# Agent model

**Status: implemented.** This note fixes the concepts and the vocabulary, seen from the author's side. It says what
an author declares and what an agent sees, not how it is stored or implemented, and it does not cover
synchronization, distribution or deployment (§8). Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

The test every rule here answers to: an agent an author shaped with a coding agent runs as a service without being
rewritten, and behaves the same wherever it runs.

## 1. The model

```text
Agent    = model + harness + context      composed by a definition: the agent's own directory
Instance = runtime state                  one Agent's life in one place
```

Each of the three is supplied by someone else: the model by a model provider, the harness by pi-durable, the context
by the repositories, clouds and other systems the agent works with. FastAgent defines the agent and composes the three, in its
definition, and serves the result.

What an author thinks: **I created an agent. It works on some things, and it knows others.**

| Concept | Is | Contains |
|---|---|---|
| **Agent** | A model, a harness and a context, composed by a definition, the way a program is | As declared in its directory |
| Model | What the agent thinks with, from a model provider | The default model and thinking level. Credentials are not part of it |
| Harness | The loop that runs it: pi-durable | Supplied by pi-durable. The word means what it means across the ecosystem |
| Context | What the agent works with: its content, connectors and environment | Below |
| Content | The data: a directory the agent **works on** (writable) or **knows** (read-only) | A project, a folder, a repository. Its type says how it reaches each instance (§3) |
| Definition | The program: who the agent is and how it works, and which model and context it uses | `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `src/tools/`, `src/extensions/`, `src/channels/`, `src/schedules/`, `fastagent.config.ts`, `context.json`, `package.json`; §2 lists where each format comes from |
| **Instance** | One Agent in one place: on this machine, or on one host | Its runtime state: conversations, credentials, channel state, schedule state, and what it fetched (§5). It exists while no process runs; one or more processes serve it (a `dev`, a `start`, a one-off `invoke`) |

A context has three kinds of parts, each reaching the agent its own way ([agent service](agent-service.md) §3):

- **Content** is data the agent reads and writes as files: a project, a folder, a repository. Most of this note is
  about content.
- **Connectors** are the systems that are not files the agent reaches: an API, a service, and their credentials. The  code tools and extensions that reach them are part of the definition; the system each one reaches is the
  connector (agent service §3.3). MCP servers are not supported yet (#678).
- **The environment** is the commands and runtimes the agent runs, declared under `environment` in its `context.json`
  and installed on every instance, each at the newest release its version allows there
  ([agent service](agent-service.md) §4). An agent with none borrows the machine's (below).

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own runtime state.
- One content entry can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent, and exactly one copy of its definition.

### What this layer guarantees

Every instance of an Agent, given the same version of its definition, runs the same program on content
resolved the same way: the same declarations, the same names, the same working directory (its own), and the same
`AGENTS.md` and skills, from its definition. A repository an instance clones is brought to its
declared version at each start while it holds nothing of the agent's (§3). A checkout the user names with `local` is the exception: it
is read as the user left it, and a difference from the declared version is reported, not corrected. A laptop instance and a hosted one behave the same on the same data.

The one exception is the machine's environment. What a machine lends an agent (the programs on its `PATH` that the
agent's environment does not declare, and the variables its processes inherit) comes from that machine wherever the
agent runs, and is not compared between instances ([core](core.md) §5). It lends nothing of the agent itself: no
skill, no prompt template, no system prompt, since a prompt from someone's machine would make the agent theirs. A skill
an agent must have everywhere belongs in its definition.

Keeping the data itself the same across instances afterwards is not this layer's job. It belongs to
collaboration and synchronization (§8): git for a repository, a content service for what is not one.

## 2. Definition and content: program and data

The line between definition and content is the line between a program and the data it works on, not who may write
them (§6) and not how widely a change is seen.

- **Definition** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same definition at another
  project and it is the same agent working on different data.
- **Content** is what the agent works on or knows. It stays with the project.

A project's `AGENTS.md` and the skills it provides are content too: files in the project, which the agent reads when
it works there, as it reads any other file. None of them is added to the agent's prompt. What the agent is told and
what it knows how to do come from its definition, wherever it works; a coding harness loads its working directory's
`AGENTS.md` and skills because there the project is where the agent is defined, and an agent here has a directory of
its own for that, so loading a project's would let each project it works on change how it behaves. An entry whose
`AGENTS.md` the agent should read before changing anything says so in its `description`, which the prompt carries.

The agent's identity and what it does for its users belong in `SYSTEM.md`, which is its whole system prompt as
written: nothing is added to it and nothing replaces it. The `AGENTS.md` in the agent's own directory belongs to the
definition: it is for whoever works on the agent, the coding agent that develops it and the agent itself, which works
in that directory and improves itself there. So it is a section of every prompt, the way a harness loads its working
directory's `AGENTS.md`. It says how this agent is built and how to change it.

### Formats

Only the markdown is an open standard. Code has no cross-tool standard to follow, so it is the harness's interface or
FastAgent's, and the definition says which ([architecture.md](architecture.md) §3):

| Files | Format | From |
|---|---|---|
| `AGENTS.md` | Markdown | Open standard ([agents.md](https://agents.md)) |
| `skills/<name>/SKILL.md` | Markdown with frontmatter | Open standard ([Agent Skills](https://agentskills.io/specification)) |
| `SYSTEM.md`, `prompts/<name>.md` | Markdown; a prompt template has a `description` in its frontmatter | FastAgent, as pi spells them |
| `src/tools/`, `src/extensions/` | TypeScript modules: pi-durable's `defineTool` and `defineExtension` | pi-durable |
| `src/channels/`, `src/schedules/`, `fastagent.config.ts` | TypeScript modules: a channel, `defineSchedule`, `defineAgent`; `needs([...])` around any module that reads a secret | FastAgent |
| `context.json` | JSON | FastAgent |
| `package.json` | npm | npm |

The tool standard across ecosystems is MCP, and it is not supported yet
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). `src/tools/` holds tools. `src/extensions/` holds what is
not only a tool: prompt sections, hooks, named bundles of tools.

Each file of the definition has one place, so there is no order to decide between two: no `.pi/` directory, no
`APPEND_SYSTEM.md`, and nothing from the machine's `~/.pi/agent`. A file elsewhere is not read, and two modules of one
name are refused, naming both files.

What FastAgent adds to the prompt does not depend on `SYSTEM.md`, because an agent needs it whoever wrote the rest:

| FastAgent's section | Says |
|---|---|
| Skills | Each skill's name, description and location, for the model to read when a task matches |
| Content | What the agent works on and what it knows, where each is, and how to work in it (§4) |
| Changing itself | On a deployed host: what takes effect when, where a lasting result belongs, and how long this host keeps its files (§6) |

FastAgent writes no identity line of its own: who the agent is is `SYSTEM.md`'s alone.

**One directory, two readers.** The agent directory is also where its author develops it, often with a coding agent.
`AGENTS.md` is the one file both read: the development session as its working directory's, and the agent on every
message (above). So it holds what both need, how this agent is built and how to change it, which is a development note
too now that the agent changes itself. What only the development session should read goes where the coding agent looks
and FastAgent does not: an `AGENTS.md` in a directory above the agent's, or the coding agent's own configuration.

### They are kept apart

**Content never contains the agent directory, and never sits inside it.** A definition and content ask for
opposite things when a new version arrives:

| | Definition | Writable content |
|---|---|---|
| A new version | Is a release: every instance must receive it | Must not overwrite what the instance wrote |
| Lifetime | Moves with the agent, across projects | Stays with the project, across agents |

One store can hold both only when it can merge both sides' changes. A copy cannot: copying again overwrites
the instance's data, and not copying leaves the release behind. So the two live in separate directories, joined
only by a binding this machine keeps (§3). An agent's directory is its own, and often its own repository:

```text
~/agents/reviewer/            the Agent: its definition and declarations, its local instance (.state/, .secrets/)
  context.local.json          where this machine has the content: "app" is ~/code/app; never in the definition
~/code/app/                   content: the project, which holds no agent
```

The check runs when an agent is loaded, and a binding to a nested layout is refused with the way out: move the agent
directory out, or bind other content. The clones an instance makes for itself are its own, kept at
`content/<name>` (§3), beside its runtime state (§5) and not inside it; they are not part of the definition.

A git repository can merge both sides, so an agent committed inside the repository it works on is coherent in
principle: one repository, one clone per instance, the definition running from it. It is not supported yet. Starting
strict leaves that option open; allowing it first and taking it back would break the people relying on it.

## 3. Content

An agent's content is declared in two files beside its config, each a map of entries by name whose order carries no
meaning. `init` and `fastagent content` write both ([CLI](agent-cli.md) §3, §4):

- **`context.json`**, part of the definition, declares what every instance reaches: GitHub repositories.
- **`context.local.json`**, this machine's, binds directories of it: a checkout of a declared repository, or a
  directory only this machine has. It is never committed and never deployed.

```json
{
  "content": {
    "app": { "github": "acme/app", "description": "The product. Open pull requests against main." },
    "handbook": { "github": "acme/handbook", "readonly": true }
  }
}
```

An agent that declares no content has none: a chat-only assistant works only in its own directory. The shared
declaration decides what an instance on a host receives, so it is visible in the definition instead of being a
hidden default. It names no path of any machine: the definition is shared, and a path describes one machine. A path
is what `context.local.json` holds, which is why it is a file of its own that no other machine reads.

### Where an entry is

- **A repository** is a clone the instance makes at `content/<name>` in the agent directory, or, where
  `context.local.json` binds this machine's checkout of it under the same name, that checkout.
- **A directory only this machine has** is where its binding says, and on any other instance does not exist.

`content/` holds only those clones. It belongs to the machine, never to the definition: it carries its own
`.gitignore`, and a deployment keeps it out of the image. On a host it is a link into the host's storage, which a
release does not replace.

### Types

A content entry's type says where its data lives, and so how an instance anywhere reaches it and where its changes go.
`init` and `fastagent content` infer it from what they are given, and every command prints it (§4), so an author
rarely writes one.

| Type | Written in | Where it lives | Here | Elsewhere (a host) | Where changes go |
|---|---|---|---|---|---|
| **github** | `context.json`: `{ "github": "acme/app" }` | A repository | A clone, or this machine's checkout bound in `context.local.json`, used as it is | A clone the instance makes | To the repository, when pushed |
| **local** | `context.local.json`: `{ "path": "~/notes" }` | A directory of this machine | That directory, edited in place | Absent: never declared there (below) | The directory |

**Only data with a home every instance can reach is the same data everywhere.** A local directory lives on one
machine, so it is content of that machine's instance alone. A copy of it on a host would not be the same data:
each copy would become its own, and nothing would bring them back together. So the shared declaration holds only a
type whose home every instance reaches: a repository today; object storage, or a service that shares directories,
are further types (§8). The declaration says where the data lives; how each place reaches it (a clone, a checkout
of its own, a sync, a mount) is that place's.

**The agent directory is the one local directory that reaches a host, and it does so as the definition.** A release
carries it; the next replaces it whole, the same on every instance (§2). So what an author wants on every instance,
read but not kept (reference material, examples), belongs in the agent directory and ships with each release. What
the agent works on and must keep, on a host, needs content with a home.

Attributes:

| Attribute | Types | Meaning | Supported |
|---|---|---|---|
| the key | all | The entry's name: how the agent and the commands refer to it, and where a clone is (`content/<name>`). `init` and `content add` default it to the repository or folder name | yes |
| `readonly` | all | The agent knows it and does not write it, for example a company handbook. A binding of a declared repository takes it from the declaration | yes |
| `description` | all | One sentence for the agent: what it is and how to treat it, given in the prompt beside the entry. As `readonly` | yes |
| `ref` | github | Branch, tag or commit. Defaults to the default branch | yes |
| `path` | local, and a checkout bound for a github entry | Where the directory is on this machine | yes |
| a subdirectory | github | Only a subdirectory of the repository (monorepos) | not yet |

### Rules

- **Read-only is an instruction, not enforced.** The agent is told not to write content it only knows;
  nothing stops a shell from writing it. A read-only `github` entry is never pushed back.
- **A repository is the user's checkout when this machine binds one, else a clone the instance makes and brings up
  to date in place.**
  - A bound checkout is the user's: FastAgent never fetches it and never switches its branch. When it is not at
    the declared `ref`, startup says so. A binding to anything but the root of a checkout of that repository is
    refused; one to a directory that is gone is said, and the clone is used.
  - Otherwise the instance clones the repository at its declared `ref` the first time it starts, and at each later
    start brings that clone up to date in place by git's own rules (a fetch and a fast-forward), whether the agent
    works on it or only knows it. git refuses whatever would overwrite the agent's work, and the clone is then kept
    as it is, with the reason; so it is when the remote cannot be reached, or when the clone is on another branch
    than declared. Bringing the agent's work and the remote together is git's, the agent's or the user's
    (synchronization, §8). The clone is never replaced, so nothing the agent did is lost to a restart.
- **A clone lives as long as the instance's storage.** A host whose storage a deployment resets (AgentCore,
  [core](core.md) §9) clones every repository again, and what the agent did not push is lost; its deployment says
  so before it runs.
- **FastAgent never deletes a directory in `content/`.** Removing an entry removes it from both files; a clone is
  left, and said to be, because it may hold the agent's work.
- **A name is one path segment, unique within the agent regardless of case, across both files.** It becomes a
  directory name, so it is letters, digits, `-` and `_`, the spelling a release's agent name already has
  (`isReleaseAgentName`), and two names that differ only in case are the same name on a case-insensitive
  filesystem. A name that breaks either rule is refused when the agent is loaded; adding an entry whose default
  name is taken or misspelled asks for an explicit one.
- **A `local` entry is this machine's alone, and said to be when it is not there.** No other instance reads
  `context.local.json`, so no other instance is told of the directory; the deployment names each one it leaves
  behind (a warning when the agent works on it, since the deployed agent lacks data it was meant to work on), with
  the two ways to change that. What the agent only reads there can be copied into the agent directory, which every
  release carries; what it works on moves to a repository declared as `github`. On this machine, a binding whose
  directory is gone is left out with a warning rather than refused: the binding is this machine's own record, and
  the agent still runs without it.
- **A `github` entry needs access.** Cloning a private repository and pushing to it take a credential: on this
  machine the user's own git credentials, on a host one held in its secret store, like any other credential of
  the instance.

A service for sharing and synchronizing local directories between agents, the way GitHub does for repositories,
would be another content type. It is not part of this note.

### Example: an agent with a folder of its own

A client such as duang may give a new agent a folder it creates for its work, and let the user attach folders
they already have. The agent's folder is content like any other, separate from its definition, bound on this
machine in `context.local.json`:

```json
{
  "content": {
    "researcher": { "path": "~/Documents/researcher", "description": "Your notes and output. Keep what you find here." },
    "papers": { "path": "~/Documents/papers", "readonly": true }
  }
}
```

It is content, not part of the agent's directory, because it is data the user keeps, which a release must not
replace. On this machine that is all it needs. To run the same agent online as well, the folder needs a home both
reach: a repository today, so `researcher` becomes `{ "github": "me/researcher" }` in `context.json`, its binding
here becomes a checkout of it, and both instances work on one history. A content type for object storage or a
directory-sharing service would give it another home; only the type in the declaration changes.

## 4. How the agent works

- **The working directory is the agent's own directory, everywhere.** One rule on a laptop and on a host, and an
  agent changing itself writes `skills/…` like any relative path.
- **The agent is told what it works on and what it knows.** For each content entry: its name, its location on this
  instance, whether it works on it or only knows it, and whether a change there reaches other instances. It is
  told that its own directory is itself, and that a result worth keeping belongs in content it works on.
  Writing a finding where it does not travel is how knowledge gets lost, so the agent needs to know which is
  which.
- **Commands run in a content directory with `cd`.** A shell command that belongs in a project runs as
  `cd <its location> && …`; file tools take the location directly. Measured against an agent whose working
  directory is the project, and against a shell tool with a `cwd` argument, this made no difference: three models,
  180 runs, no command run in the wrong directory. So the shell tool stays as it is.
- **Project instructions come from its own directory alone.** Its own `AGENTS.md` is loaded. No `AGENTS.md` of a
  content entry or above the agent directory is, and no skill a content entry provides (§2).
- **What the agent creates lands in its own directory unless it puts it elsewhere.** Whether a file is temporary
  or part of the agent often cannot be decided when it is written: a helper script that proves useful is how a
  skill begins. The author decides what stays, with the tool every repository uses: version control and ignore
  files. What is shipped or shared is what the author keeps (§8).
- **The prompt names where each content entry is.** An authored tool that works on one is given its location the
  way any code is given a value: by its author, from `context.json`'s declaration and the instance's binding.

## 5. Runtime state

What an instance accumulates while running is **runtime state**: not part of the definition and not part of its
content.

| Runtime state | Why it is not content |
|---|---|
| Conversations (sessions) | They belong to the place a conversation happens and the people in it ([participant model](participant-model.md) §5). As data, a direct message would travel with the project: committed, copied and synchronized to every agent and person working on it |
| Credentials (model logins, channel tokens, repository access) | They belong to the machine or host running the instance, and never travel with a definition |
| Channel and schedule state | Bookkeeping of one running process |

The difference shows in four places:

| | Content (data) | Runtime state |
|---|---|---|
| Who sees it | Every agent and person working on that content | This instance only |
| How the agent is given it | As files: read, search, edit | Its current conversation; other sessions through FastAgent's interfaces, not as files |
| What it follows | The content | The instance |
| Deleting the instance | The content's source remains. What the instance fetched (its clones, a host's copies) goes with it, and with them anything it wrote there that was not pushed or synchronized | Removed with it |

This separation decides what travels and what an agent is given, not what it can open. An agent with a shell
runs with the permissions of the account running it and can read any file that account can, another agent's
`.state/` and `.secrets/` included. Keeping agents out of each other's files takes a sandbox or a separate
account, which this note does not provide.

What is worth keeping beyond one conversation becomes data when the agent, or a person, writes it into its
content. That step is explicit and visible on purpose: an implicit transfer leaves nobody able to say what an
agent knows or why. Sharing conversations as content is deferred until FastAgent provides content sharing and
merging (§8).

## 6. An agent changes itself

An agent may change its definition and the content it works on while it runs: write a skill, edit its prompt, update
`AGENTS.md`, change the project. Agent harnesses are built for this.

When a change takes effect:

| Changed | Takes effect |
|---|---|
| `SYSTEM.md`, `AGENTS.md`, skills and prompt templates in the agent directory, scripts, project files | On the next message |
| The definition's code (`src/`) and configuration (`fastagent.config.ts`, `context.json`, `context.local.json`, `package.json`) | When the process next starts: the author's restart, or the next release. `dev` restarts on such an edit itself |

So an agent improves itself while it runs through what takes effect on the next message: a skill whose script it runs
through `bash`, its prompt files and `AGENTS.md`, and `wake` for its own follow-up work, one-shot or recurring. A
command-line tool it needs is its author's to declare (`fastagent env add`); how an agent changes its own environment
is designed with how an agent is developed ([agent service](agent-service.md) §4). One it installs with the machine's
own means (`apt-get`, `npm install -g`) is the machine's, gone with the container on a host. Code (a tool, an
extension, a channel, a schedule) and configuration are the author's to put into service, with a restart or a
release, and the deployed prompt says so ([architecture.md](architecture.md) §3).

An earlier version of this note had every process restart onto a changed definition by itself once idle, after
checking that it loads. It was not built:

- **No observed need.** What a script cannot be is a tool with a typed interface or a channel, and nothing so far has
  needed one written by the agent and put into service within the same run.
- **Its cost.** A supervisor for `start`, draining every way a message starts (channels, the scheduler, AgentCore) on
  four hosts, and a retry on AgentCore whose behavior is unknown.
- **Nothing worse without it.** The agent is told that changes to code and configuration take effect at a restart, so
  it does not count on one it has not had.

Reconsider with a case where an agent must write a code module and use it before the next release.

One risk remains: an agent can write a module that does not load. The next start (a restart, a crash, a host waking a
scaled-to-zero instance, a release) fails on it and says why, and the way back is the author's: revert the change with
version control on this machine, or deploy again on a host, which ships the definition anew. Keeping the last
definition that loaded, and starting from it with a report, would close this gap; it is not part of this model yet.

A change to content reaches other instances the way that content synchronizes. A change an agent on a host
makes to its definition lasts until the next deployment ships it again: keeping it is a question of where the
definition comes from, which is distribution (§8). Recording a self-change, reviewing it and reverting it
belong to the tools that keep the history, not to this layer.

## 7. Vocabulary

| Use | Do not use | Why |
|---|---|---|
| Agent | preset | A shared definition is an Agent. Clients express "make my own copy" in their interface, not with a second noun |
| Instance | deployment, for a running agent | Deployment is how an instance gets onto a host (§8) |
| works on / knows | primary content | What users see says what the agent may do with content. No entry is special |
| Content, for the data | context, for the data | *Context* is the whole the agent works with: content, connectors and environment ([agent service](agent-service.md) §3) |
| (nothing) | workspace | Not a concept any more: the working directory is the agent's own directory, and where an instance keeps what it fetches is storage |
| Definition | harness, for an agent's own files | Across the ecosystem a harness is the loop that runs an agent (pi-durable). What an author writes is the definition |
| `SYSTEM.md` | `persona.md`, `APPEND_SYSTEM.md` | `SYSTEM.md` is the whole system prompt; there is no default for another file to replace a part of or add to |

A client that calls the running thing an agent (duang) maps it to an instance.

## 8. Out of scope

These belong to other layers, the way a program does not do its own package management:

- **Collaboration and synchronization.** Recording an agent's changes, branches, conflicts, reverting a
  self-change, how changes in a `github` entry get back to the repository, and merging a clone with what the
  repository gained. Done by external tools (git) or a future content service, not by the agent layer.
- **Distribution.** Sharing and copying an Agent, and what of its directory goes with it; reusing a definition by
  copying it into another Agent; and where an instance's definition comes from. Content has a source type; a
  definition can have one too: the directory an author points at, a copy shipped with a deployment, or later a clone
  of the agent's own repository, from which a hosted agent's changes to itself survive the next deployment.
- **Deployment.** Running an instance on a host, and how each host reaches each content type (a clone, a sync, a
  mount), where what it fetches lives, and what a redeploy reports. Separating the program from its content, and
  declaring where each entry's data lives, is what lets each host decide this per type.
- **Further content types.** Homes other than a repository, so data that is not code can reach a host too: object
  storage (S3 and compatible), or a service through which several agents and people share and synchronize a
  directory. Each is a content type, with its own answer to where changes go; sharing conversations as content
  waits for one.
