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

Each of the three is supplied by someone else: the model by a model provider, the harness by pi, the context by the
repositories, clouds and other systems the agent works with. FastAgent defines the agent and composes the three, in its
definition, and serves the result.

What an author thinks: **I created an agent. It works on some things, and it knows others.**

| Concept | Is | Contains |
|---|---|---|
| **Agent** | A model, a harness and a context, composed by a definition, the way a program is | As declared in its directory |
| Model | What the agent thinks with, from a model provider | The default model and thinking level. Credentials are not part of it |
| Harness | The loop that runs it: pi | Supplied by pi. The word means what it means across the ecosystem |
| Context | What the agent works with: its content, connectors and environment | Below |
| Content | The data: a directory the agent **works on** (writable) or **knows** (read-only) | A project, a folder, a repository. Its type says how it reaches each instance (§3) |
| Definition | The program: who the agent is and how it works, and which model and context it uses | `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `tools/`, `channels/`, `schedules/`, `extensions/`, `fastagent.config.ts`, `context.json`, `models.json`, `models-store.json`, `package.json`, `.agents/skills/`, and pi's project files in `.pi/` (`settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills/`, `prompts/`); §2 lists where each format comes from and which wins |
| **Instance** | One Agent in one place: on this machine, or on one host | Its runtime state: conversations, credentials, channel state, schedule state, and what it fetched (§5). It exists while no process runs; one or more processes serve it (a `dev`, a `start`, a one-off `invoke`) |

A context has three kinds of parts, each reaching the agent its own way ([agent service](agent-service.md) §3):

- **Content** is data the agent reads and writes as files: a project, a folder, a repository. Most of this note is
  about content.
- **Connectors** are the systems that are not files the agent reaches: an API, a service, and their credentials. The
  code tools and pi extensions that reach them are part of the definition; the system each one reaches is the
  connector (agent service §3.3). MCP servers are not supported yet (#678).
- **The environment** is the commands and runtimes the agent runs: today the machine lends it (below).

Relations:

- One Agent can run as several instances (on a laptop, on a host). Each has its own runtime state.
- One content entry can be the data of several Agents (an engineer's and a PM's agent on one repository).
- An instance runs exactly one Agent, and exactly one copy of its definition.

### What this layer guarantees

Every instance of an Agent, given the same version of its definition, runs the same program on content
resolved the same way: the same declarations, the same names, the same working directory (its own), the same
`AGENTS.md`, and the same skills from its definition and its content. A repository an instance clones is brought to its
declared version at each start while it holds nothing of the agent's (§3). A checkout the user names with `local` is the exception: it
is read as the user left it, and a difference from the declared version is reported, not corrected. A laptop instance and a hosted one behave the same on the same data.

The one exception is the machine's environment. What a machine lends an agent (pi's user-level skills and prompt
templates, `.agents/skills` found above the agent directory, installed pi packages, harness settings, the programs
on its `PATH`) comes from that machine wherever the agent runs, and is not compared between instances
([core](core.md) §5). A skill an agent must have everywhere belongs in its definition or in its content. A machine
never lends a system prompt: its `~/.pi/agent/SYSTEM.md` and `APPEND_SYSTEM.md` are not read, because a prompt
from someone's machine would make the agent theirs.

Keeping the data itself the same across instances afterwards is not this layer's job. It belongs to
collaboration and synchronization (§8): git for a repository, a content service for what is not one.

## 2. Definition and content: program and data

The line between definition and content is the line between a program and the data it works on, not who may write
them (§6) and not how widely a change is seen.

- **Definition** is what the agent is and how it works: its identity, its skills and tools, the channels it
  answers on, the work it does on a schedule. It moves with the agent. Point the same definition at another
  project and it is the same agent working on different data.
- **Content** is what the agent works on or knows, and what that project tells it. It stays with the project.

A project's `AGENTS.md` is content, and so are skills a project provides. They change how the agent behaves, but
they belong to the project, not to the agent, the way a repository's `.eslintrc` changes how eslint behaves and is
still the repository's file. An identity of the agent's own belongs in `SYSTEM.md`; `APPEND_SYSTEM.md` holds
standing instructions added to pi's default (below). One reading holds everywhere: an `AGENTS.md` is written for
whoever works in its directory. The one in a project is for the agent working on that project. The one in an
agent's own directory belongs to the definition: it is for whoever works on the agent, the coding agent that develops it and the
agent itself, which works in that directory and improves itself there. So it is loaded on every turn, before
the content entries' ones, the way a harness loads its working directory's `AGENTS.md`. It says how this agent is built and how
to change it; what the agent does for its users belongs in `APPEND_SYSTEM.md`.

### Formats, and which one wins

Only the markdown is an open standard. Code has no cross-tool standard to follow, so it is FastAgent's own
interface or pi's, and the definition says which:

| Files | Format | From |
|---|---|---|
| `AGENTS.md` | Markdown | Open standard ([agents.md](https://agents.md)) |
| `skills/<name>/SKILL.md` | Markdown with frontmatter | Open standard ([Agent Skills](https://agentskills.io/specification)) |
| `tools/`, `channels/`, `fastagent.config.ts` | TypeScript modules (`defineTool`, `defineChannel`) | FastAgent |
| `schedules/<name>.md` | Markdown with a `cron`/`tz` frontmatter | FastAgent |
| `context.json` | JSON | FastAgent |
| `SYSTEM.md`, `APPEND_SYSTEM.md`, `prompts/`, `extensions/`, `.pi/`, `models.json`, `models-store.json` | pi's conventions and APIs | pi, the reference harness: these do not carry over to another harness |
| `<content>/<skill>` | A skill name | FastAgent's convention, not the Agent Skills specification (below) |
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
| Skills | `skills/`, then `.pi/skills/`, then `.agents/skills/` in the agent directory, then the machine's (§1). A content entry's skills are read from its `.pi/skills/`, then its `.agents/skills/`, the places pi reads a project's, and are named apart (below) |
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
| Content | What the agent works on and what it knows, where each is, and how to work in it (§4) |
| Changing itself | What takes effect when, where a lasting result belongs, and how long this host keeps its files (§6) |
| Tools not loaded yet | That deferred tools exist and are reached through `tool_search`, when there are any |

FastAgent writes no identity line of its own, which settles two things:

- **Authored tools stay listed.** pi's default lists a tool only when it has a `promptSnippet`. FastAgent sets one
  for each authored tool from the first line of its description, so `defineTool` needs no field for it.
- **The identity has to match the tools.** pi's default says the agent reads files, runs commands and edits code,
  which is true of every agent a command opens: they all mount the coding tools. An embedder can replace them
  (`createPiAgentFromDefinition(dir, { tools })`), and then that sentence is false. So replacing the coding tools
  requires a prompt that matches what is left: the `base` option, which replaces pi's default as
  `SYSTEM.md` does, or a `SYSTEM.md`. Without either, assembling the agent is refused with that reason, rather than
  serving an agent that claims tools it does not have. `createPiAgent({ instructions })` already takes its prompt
  whole.

**A content entry's skills carry its name.** A skill `deploy` that the entry `app` provides is the skill `app/deploy`:
it is about working in `app`, and the name says so. It never collides with the agent's own `deploy`, or with
another entry's, so content entries need no order and no precedence among them. Inside one entry, `.pi/skills/deploy`
wins over `.agents/skills/deploy`, and the two are reported like any two places holding one name. Renaming a content entry renames its skills. That holds
because no other skill may have a `/` in its name. pi only warns about one, so FastAgent refuses a definition skill
named that way and leaves such a machine skill out, saying so; the slash stays the namespace's. The part after it keeps the Agent Skills
grammar; the whole name is FastAgent's convention.

**One directory, two readers.** The agent directory is also where its author develops it, often with pi itself.
pi run there treats it as a project and loads the same `.pi/` files and `.agents/skills/` the served agent reads: a
`.pi/SYSTEM.md` makes the author's development session the agent, and a development skill kept in
`.agents/skills/` ("how to write a fastagent tool") ships with the agent. The root spellings (`SYSTEM.md`,
`skills/`, `prompts/`) are invisible to pi as a coding agent, which is what keeps the two readers apart; `.pi/`
and `.agents/skills/` are read for compatibility at that cost. `AGENTS.md` is the one file both readers share: the
development session reads it as its working directory's, and the agent loads it every turn (above). So it holds
what both need, how this agent is built and how to change it, which is a development note too now that the agent
changes itself. What only the development session should read goes where pi looks and FastAgent does not: an
`AGENTS.md` in a directory above the agent's (one for all the agents kept there), or the machine's
`~/.pi/agent/AGENTS.md`.

### They are kept apart

**Content never contains the agent directory, and never sits inside it.** A definition and content ask for
opposite things when a new version arrives:

| | Definition | Writable content |
|---|---|---|
| A new version | Is a release: every instance must receive it | Must not overwrite what the instance wrote |
| Lifetime | Moves with the agent, across projects | Stays with the project, across agents |

One store can hold both only when it can merge both sides' changes. A copy cannot: copying again overwrites
the instance's data, and not copying leaves the release behind. So the two live in separate directories, joined
only by a link this machine keeps (§3). An agent's directory is its own, and often its own repository:

```text
~/agents/reviewer/            the Agent: its definition and declarations, its local instance (.state/, .secrets/)
  content/app -> ~/code/app   where this machine reaches the content: a link, never in the definition
~/code/app/                   content: the project, which holds no agent
```

The check runs when an agent is loaded, and a link to a nested layout is refused with the way out: move the agent
directory out, or link other content. The clones an instance makes for itself are its own, kept at
`content/<name>` (§3), beside its runtime state (§5) and not inside it; they are not part of the definition.

A git repository can merge both sides, so an agent committed inside the repository it works on is coherent in
principle: one repository, one clone per instance, the definition running from it. It is not supported yet. Starting
strict leaves that option open; allowing it first and taking it back would break the people relying on it.

## 3. Content

An agent declares its content in `context.json`, beside its config: a map of entries by name, whose order carries no
meaning. `init` and `fastagent content` write it ([CLI](agent-cli.md) §3, §4):

```json
{
  "content": {
    "app": { "github": "acme/app", "description": "The product. Open pull requests against main." },
    "handbook": { "github": "acme/handbook", "readonly": true }
  }
}
```

An agent that declares no content has none: a chat-only assistant works only in its own directory. The
declaration decides what an instance on a host receives, so it is visible in the definition instead of being a
hidden default. It names no path of any machine: the definition is shared, and a path describes one machine.

### Where an entry is: `content/<name>`

On every instance the agent reaches an entry at `content/<name>` in its own directory. What is there is the place's
choice, the way a manifest's projects land at their paths (a submodule's directory, a west project):

- **A link to a directory of this machine**: the author's checkout, or a folder. `fastagent content add` makes it.
- **A clone the instance makes**, for a repository with nothing linked.
- **Nothing**, for a directory entry on a machine that links none.

`content/` belongs to the machine, never to the definition: it carries its own `.gitignore`, and a deployment keeps it
out of the image. On a host it is a link into the host's storage, which a release does not replace.

### Types

A content entry's type says where its data lives, and so how an instance anywhere reaches it and where its changes go.
`init` and `fastagent content` infer it from what they are given, and every command prints it (§4), so an author
rarely writes one.

| Type | Declared as | Where it lives | On a machine that links it | Elsewhere (a host) | Where changes go |
|---|---|---|---|---|---|
| **local** | `{}` | A directory of each machine that links one | That directory, edited in place | Absent, and said to be (below) | The directory |
| **github** | `{ "github": "acme/app" }` | A repository | The linked checkout, used as it is | A clone the instance makes | To the repository, when pushed |

**Only data with a home every instance can reach is the same data everywhere.** A local directory lives on one
machine, so it is content of that machine's instance alone. A copy of it on a host would not be the same data:
each copy would become its own, and nothing would bring them back together. So content reaches a host only by a
type whose home the host reaches: a repository today; object storage, or a service that shares directories, are
further types (§8). The declaration says where the data lives; how each place reaches it (a clone, a sync, a mount)
is that place's.

**The agent directory is the one local directory that reaches a host, and it does so as the definition.** A release
carries it; the next replaces it whole, the same on every instance (§2). So what an author wants on every instance,
read but not kept (reference material, examples), belongs in the agent directory and ships with each release. What
the agent works on and must keep, on a host, needs content with a home.

Attributes:

| Attribute | Types | Meaning | Supported |
|---|---|---|---|
| the key | all | The entry's name: how the agent and the commands refer to it, and where the agent reaches it (`content/<name>`). `init` and `content add` default it to the repository or folder name | yes |
| `readonly` | all | The agent knows it and does not write it, for example a company handbook | yes |
| `description` | all | One sentence for the agent: what it is and how to treat it, given in the prompt beside the entry | yes |
| `ref` | github | Branch, tag or commit. Defaults to the default branch | yes |
| `path` | github | Only a subdirectory of the repository (monorepos) | not yet |

### Rules

- **Read-only is an instruction, not enforced.** The agent is told not to write content it only knows;
  nothing stops a shell from writing it. A read-only `github` entry is never pushed back.
- **A repository is the user's checkout when this machine links one, else a clone the instance makes and brings up
  to date in place.**
  - A linked checkout is the user's: FastAgent never fetches it and never switches its branch. When it is not at
    the declared `ref`, startup says so. A link to anything but a checkout of that repository is refused.
  - With nothing linked, the instance clones the repository at its declared `ref` the first time it starts, and at
    each later start brings that clone up to date in place by git's own rules (a fetch and a fast-forward), whether
    the agent works on it or only knows it. git refuses whatever would overwrite the agent's work, and the clone is
    then kept as it is, with the reason; so it is when the remote cannot be reached, or when the clone is on
    another branch than declared. Bringing the agent's work and the remote together is git's, the agent's or the
    user's (synchronization, §8). The clone is never replaced, so nothing the agent did is lost to a restart.
- **A clone lives as long as the instance's storage.** A host whose storage a deployment resets (AgentCore,
  [core](core.md) §9) clones every repository again, and what the agent did not push is lost; its deployment says
  so before it runs.
- **FastAgent never deletes a directory in `content/`.** Removing an entry removes its link; a clone is left, and
  said to be, because it may hold the agent's work.
- **A name is one path segment, unique within the agent regardless of case.** It becomes a directory name, so it
  is letters, digits, `-` and `_`, the spelling a release's agent name already has (`isReleaseAgentName`), and two
  names that differ only in case are the same name on a case-insensitive filesystem. A name that breaks either
  rule is refused when the agent is loaded; adding an entry whose default name is taken or misspelled asks for an
  explicit one.
- **A `local` entry is absent from an instance that links nothing for it, and said to be.** It is, by declaration,
  a directory of the machines that link one: another machine does not have it, which is what the type says, not an
  error. So an author keeps it for local work and still deploys. The instance elsewhere is not told of it, and is
  never missing it silently: the deployment names it (a warning when the agent works on it, since the deployed
  agent lacks data it was meant to work on), with the two ways to change that, and the instance's start names it
  again. What the agent only reads there can be copied into the agent directory, which every release carries; what
  it works on moves to a repository declared as `github`.
- **A `github` entry needs access.** Cloning a private repository and pushing to it take a credential: on this
  machine the user's own git credentials, on a host one held in its secret store, like any other credential of
  the instance.

A service for sharing and synchronizing local directories between agents, the way GitHub does for repositories,
would be another content type. It is not part of this note.

### Example: an agent with a folder of its own

A client such as duang may give a new agent a folder it creates for its work, and let the user attach folders
they already have. The agent's folder is content like any other, separate from its definition:

```json
{
  "content": {
    "researcher": { "description": "Your notes and output. Keep what you find here." },
    "papers": { "readonly": true },
    "handbook": { "github": "acme/handbook", "readonly": true }
  }
}
```

with `content/researcher` linked to `~/Documents/researcher` and `content/papers` to `~/Documents/papers` on this
machine. It is content, not part of the agent's directory, because it is data the user keeps, which a release must
not replace. On this machine that is all it needs. To run the same agent online as well, the folder needs a home
both reach: a repository today, so `researcher` becomes `{ "github": "me/researcher" }`, its link here becomes a
checkout of it, and both instances work on one history. A content type for object storage or a directory-sharing
service would give it another home; only the type in the declaration changes.

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
- **Project instructions come from its own directory and its content.** Its own `AGENTS.md` is loaded first,
  then each content entry's at its root, each marked with the directory it applies to, and so are the skills each
  entry provides from its `.pi/skills/` and `.agents/skills/`, named `<content>/<skill>` (§2). No `AGENTS.md`
  above the agent directory or a content entry is loaded.
- **pi's project scope is the agent's own directory.** What pi reads from a project (`.pi/settings.json`, which can
  change harness settings and the built-in extensions, `.pi/` prompts and skills, packages) is read from the agent
  directory, so it is part of the definition and ships with it, the same on every instance. Nothing of pi's
  project scope is read from content: a content entry contributes its `AGENTS.md` and its skills only.
- **What the agent creates lands in its own directory unless it puts it elsewhere.** Whether a file is temporary
  or part of the agent often cannot be decided when it is written: a helper script that proves useful is how a
  skill begins. The author decides what stays, with the tool every repository uses: version control and ignore
  files. What is shipped or shared is what the author keeps (§8).
- **A tool is told where each content entry is.** An authored tool that works on one reads its location from
  `ctx.content`, not by guessing.

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

An agent may change its definition and the content it works on while it runs: write a skill, edit its prompt, add
a tool, update `AGENTS.md`, change the project. Agent harnesses are built for this: pi's own README opens with
"Ask Pi to create the prompt templates, skills, extensions, and themes you need".

When a change takes effect:

| Changed | Takes effect |
|---|---|
| `SYSTEM.md`, `APPEND_SYSTEM.md`, skills in the agent directory and its content, prompt templates in the agent directory, `AGENTS.md`, scripts, project files | On the next turn |
| `extensions/` | On the next session: it is listed again, and changed code is loaded afresh |
| `models.json`, `models-store.json` (the agent's and the machine's) | On the next read: a turn, the model list or `update({ model })`. An edit that does not load, or drops the default model, keeps the models read before |
| `schedules/` | Within 30 seconds: the running clock re-reads it (on AgentCore, the container sets the recurring EventBridge schedules itself) |
| What a process loads once: `tools/`, `channels/`, `.pi/settings.json`, `fastagent.config.ts`, `context.json`, `package.json` | When the process next starts: the author's restart, or the next release. `dev` restarts on such an edit itself |

So an agent improves itself while it runs through what takes effect on the next turn: a skill whose script it runs
through `bash`, its prompt files and `AGENTS.md`, an extension when it needs a tool or a command of its own, a
schedule for recurring work, and `wake` for its own follow-up work. `tools/`, `channels/` and configuration are the
author's to put into service, with a restart or a release: the rule #600 set, which [core](core.md) §2 and the
deployed prompt give. Extensions are the code an agent can add for itself, because pi reloads them (jiti, with its
module cache off) where Node's own loader, which `tools/` and `channels/` use, cannot.

An earlier version of this note reversed that rule: every process would restart onto a changed definition by
itself once idle, after checking that it loads. It was not built:

- **No observed need.** What a script cannot be is a tool with a typed interface or a channel (an extension the
  agent writes is already live), and nothing so far has needed one written by the agent and put into service within
  the same run.
- **Its cost.** A supervisor for `start`, draining every way a turn starts (`/invoke`, chat channels, the
  scheduler, AgentCore) on four hosts, and a retry on AgentCore whose behavior is unknown.
- **Nothing worse without it.** The agent is told that changes to tools, channels and configuration take effect at
  a restart, so it does not count on one it has not had.

Reconsider with a case where an agent must write a code module and use it before the next release.

One risk remains: an agent can write a tool or channel module that does not load. The next start (a restart, a
crash, a host waking a scaled-to-zero instance, a release) fails on it and says why, and the way back is the author's: revert the
change with version control on this machine, or deploy again on a host, which ships the definition anew. Keeping
the last definition that loaded, and starting from it with a report, would close this gap; it is not part of this
model yet. An extension that does not load fails no start: sessions run without it, the log says so when it
appears (and again if it is repaired and then broken again), and every session's prompt names it with pi's reason
(`extension_errors`), so an agent that wrote it can repair it.

A change to content reaches other instances the way that content synchronizes. A change an agent on a host
makes to its definition lasts until the next deployment ships it again: keeping it is a question of where the
definition comes from, which is distribution (§8). Recording a self-change, reviewing it and reverting it
belong to the tools that keep the history, not to this layer.

Whether an agent may change its own default model is open, pending the definitions in pi 1.0 and pi durable.

## 7. Vocabulary

| Use | Do not use | Why |
|---|---|---|
| Agent | preset | A shared definition is an Agent. Clients express "make my own copy" in their interface, not with a second noun |
| Instance | deployment, for a running agent | Deployment is how an instance gets onto a host (§8) |
| works on / knows | primary content | What users see says what the agent may do with content. No entry is special |
| Content, for the data | context, for the data | *Context* is the whole the agent works with: content, connectors and environment ([agent service](agent-service.md) §3) |
| (nothing) | workspace | Not a concept any more: the working directory is the agent's own directory, and where an instance keeps what it fetches is storage |
| Definition | harness, for an agent's own files | Across the ecosystem a harness is the loop that runs an agent (pi). What an author writes is the definition |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | `persona.md` | `persona.md` replaced only the identity line; `SYSTEM.md` replaces pi's whole default and `APPEND_SYSTEM.md` adds to it, so neither is the same. `persona.md` is refused, naming both and when to use each |

A client that calls the running thing an agent (duang) maps it to an instance. [Session control](session-control.md) still
calls a running agent a deployment; there, the word means an instance.

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
