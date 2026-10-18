---
title: Agent service
description: "Proposed: FastAgent for teams that build, run and use a set of agents together as cloud services. The product loop, what an agent works with (content, connectors and environment), state, credentials, the serving protocol (sessions, messages, entries) and its harness port, disposable boxes, the interfaces, the architecture, and deployment."
type: design-doc
status: proposed
---

# Agent service

**Status: proposed, partly implemented** (§12 says which steps are done). It extends the
[agent model](agent-model.md), replaced the v0.1 Agent Handler SPEC with the serving protocol, now
[SPEC v1](../SPEC.md) (§7; §7.8 lists what changed), and answers
[#688](https://github.com/fastagent-sh/fastagent/issues/688): `Scope` goes, and §7.2 says what replaces it. §14 lists
the decisions made in review; what is not built yet is a proposal to settle before implementation. Shared contexts
(§3.6) are deferred: the current scope is each agent's own `context.json` for content and environment, and nothing
else in this design depends on them.

Three things are hard in serving an agent, and this design spends itself on them:

1. **Work that outlives its caller.** Work arrives from many entry points, has side effects, and keeps running when
   its caller goes away; the caller comes back to it by its message's id. Surviving a restart as well needs a harness
   that checkpoints its work (§9.3).
2. **Disposable boxes.** A deploy wipes a box, and scaling out adds boxes and removes them. So the program comes from
   the image, what has to last lives outside the box, and each conversation reaches the box that holds it (§10.2).
3. **What the agent works with, on a host.** The content it works on, the connectors it reaches, the environment it
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
| The agent | Writes to its writable content and to its own directory | Its own directory |

Outside FastAgent:

- a unit above agents: a team, its members, shared secrets, one deployment target. Sharing declarations across agents
  through contexts is deferred (§3.6);
- the model and the agent loop, which a harness provides (§9.1);
- a hosting platform of its own: agents deploy to existing hosts (§10);
- waiting states for human input: steering, queued messages, cancelling and aborting cover it.

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
  context        everything it works with from outside, in three kinds:
    content        data it reads and writes as files, synced to where it runs: repositories, directories
    connectors     the other systems it reaches: MCP servers, APIs and their credentials (mcp.json)
    environment    what it runs in: the commands and runtimes it needs, on every platform (context.json)
  definition     its own directory: who it is and how it works, and which model and contexts it uses
  remembers in   sessions: conversations
  started by     triggers: requests, messages, events, time, itself
```

The formula is the [agent model](agent-model.md)'s. Each of the three is supplied by someone else: the model by a
model provider, the harness by pi, and the context, which is the agent's content, connectors and environment, by the
repositories, clouds and MCP servers it works with. FastAgent defines the agent and composes the three, in its
definition, and serves the result. Declaring the context apart from the definition is what lets a box be wiped and
rebuilt from the declarations (§10.2), and what lets a team share it across its agents, a context at a time (§3.6).

### 3.1 Why three kinds: every action has three parts

Everything an agent does outside its model is an action: a tool call. An action has exactly three parts: **where it
executes**, **which state it reads or changes**, and **which other system it affects**. A skill script, for example,
runs `git` in the environment, edits files in the content, and opens a ticket through a connector. So the three cover
everything an agent touches outside its model, and they do not overlap.

| | Environment | Content | Connector |
|---|---|---|---|
| Is | Compute: the agent's body | Data the team owns, as files: documents, materials, code | Another system's operations |
| Examples | node 22, git, ffmpeg, a sandbox | A directory, a git repository, an S3 bucket synced to files | GitHub issues, Jira, email, payments, a company API, an MCP server |
| Lifetime | Disposable; rebuilt from its declaration | Persistent and versioned | The other system's |
| A write can be undone | Holds no durable data | Yes: it has history, and it can be reviewed and reverted | Often not: a sent email, a payment |
| Access | None needed | Read and write, plus the credentials to sync it | Authority delegated per action (OAuth, API keys), scoped |
| Credentials (§6) | Supplied at start, never built in | Declared by the content | Declared by the connector |
| Shared across a team's agents | The declaration; each agent runs its own instance | The same data: a team asset | The same integration, with per-agent scopes |
| Fails as | A missing command, when something runs it | Unreachable, or a conflicting write | Authorization, rate limits, an effect whose outcome is unknown |

Three invariants follow:

1. **An environment is reproducible.** It is rebuilt from its declaration and holds no durable data. Credentials are
   supplied when it starts and never built into it.
2. **Content is stateful and versioned.** Long-term memory and work products live there, where people can review
   and revert them.
3. **A connector is an external effect.** It may not be repeatable, so the service never repeats one behind the
   caller's back (§9.3), and its authority is scoped per agent. Merging connectors into content would govern a
   payment like a file edit, or a file edit like a payment.

### 3.2 Content or connector: the test

Local or remote does not separate the two, and neither does storage or API: S3 is an API, and GitHub has both files
and issues. Ownership and reversibility do. Two questions:

1. Can the agent work on the data directly, with generic operations (list, read, write, compare), and see all of it?
2. Can the team review and revert what the agent writes?

Yes to both: content. Otherwise: a connector. One system can provide both.

| Example | Is | Because |
|---|---|---|
| The files of a git repository | Content | Generic reads and writes, with history |
| GitHub issues, pull requests, comments | Connector | Reached only through GitHub's API; what is posted is an external effect |
| A team's own S3 bucket, synced to files | Content | Generic reads and writes, and the team owns it |
| Notion or Google Drive used through their API | Connector | Synced to files, the same pages are content |
| A production database behind a business API | Connector | The state and its rules belong to the other system |
| Feishu, Slack | The channel is a trigger; the agent's send tool is a connector | One system, two relationships |

Knowledge and long-term memory prefer content made of files, such as markdown in git: people can read, review and
revert them, and they travel with a deployment. A memory service such as a vector store is a connector.

### 3.3 What knowledge, memory, skills and tools are

They are uses of the three, not further categories.

| Term | Is |
|---|---|
| Knowledge | Reading content, and querying connectors (a search) |
| Memory | Long-term: writing to writable content. A conversation's: its session (§3.5) |
| Skill | Know-how stored in the definition, executed in the environment, possibly calling connectors. A context carries none (§3.6) |
| Tool | How an action is presented to the model. `read`, `write` and `bash` act on the environment and content. A code tool is part of the definition, and the system it reaches is a connector; an MCP tool is a connector's |

### 3.4 The agent's own directory

An agent's own directory is its definition: who it is and how it works. It stays writable on a host as on a laptop; how
what the agent changes there is kept is designed later (§2).

### 3.5 Sessions and triggers

A **session** is a conversation's continuity: the invokes of one session share its history. It is named by the
caller or created by the service, and may start as a fork of another session (§7.4). A session is the agent's working
memory of a conversation: what should outlast it belongs in content, and a chat place's own history is the
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

### 3.6 Contexts: the unit of sharing (deferred)

Deferred until a concrete need to share declarations across agents emerges; it is kept as the design to start from
then. Its implementation, [#787](https://github.com/fastagent-sh/fastagent/pull/787), was closed without merging.

A **context** is a named unit of what agents work with, shared on its own: content, connectors and environment that
belong together, declared once for every agent that uses it. A team's GitHub, for example: the repositories its agents
work on, `gh` and the variable holding its token, and, with MCP (§5), the GitHub MCP server. An agent is shared as its
definition; what it works with is shared a context at a time.

```text
acme-github/                  a context: a GitHub repository
  context.json                its content, its environment (gh, GITHUB_TOKEN), and a description
  mcp.json                    its MCP servers, with MCP (§5)
```

- **A context declares what an agent works with; it carries no prompt and no code the harness loads.** Its
  `context.json` is an agent's format, with `content`, `environment` and a `description`: one line for the people who
  choose it, shown by `context list` and `info` and never given to the model. `description` is a context's alone and
  `contexts` an agent's alone, each refused where it means nothing. Besides `context.json` and, with MCP, `mcp.json`,
  nothing in the repository is read: not its `AGENTS.md` or `SYSTEM.md`, skills, tools, prompts, extensions, channels
  or schedules. A context still changes what the model sees, as any content and connector does: its content entries
  are named in the prompt with their `description`, and its MCP servers bring tools with theirs. What it cannot do is
  tell the agent who it is, teach it a method, or run code inside its harness: those come from the agent's own
  directory, as with content (agent model §2). A skill that teaches a context's CLI therefore lives in each agent that
  uses it (`fastagent add skill` vendors one from a repository), or on the machine.
  - Considered: a context that brings skills and code tools, as Claude Code plugins, Gemini CLI extensions and Codex
    plugins bundle skills with MCP servers. A context would then be part of every agent's definition, written
    elsewhere: its instructions and its code would run as the agent's own, from a repository the agent's author does
    not hold.
- **An agent lists the contexts it uses** in its own `context.json` (§8.1), each by name with its GitHub repository
  and an optional `ref`, the way a content entry names its repository. A context lists none: nesting would make an
  agent's world a dependency graph, which nothing needs.
- **A context is used as its `ref` names it, and is locked only when its `ref` is a commit.** `ref` is a branch, a tag
  or a full commit; without one, the default branch. A branch or a tag follows the context, as the environment's
  packages follow their versions (§4); a full commit pins it, and moving it is an edit of `context.json`, reviewed like
  any. Each context is fetched into `.contexts/<name>/`, never in git; the copy is FastAgent's, and nothing writes in
  it.
  - The commands that develop the agent (`dev`, `chat`, `invoke`, `tool`, `env exec`) bring each context to its `ref`
    at start. When GitHub cannot be reached they run on the copy they have and say so; a context never fetched stops
    the start.
  - `fastagent context add`, `fastagent context fetch` and `deploy` fetch every context they need, and fail when one
    cannot be fetched: none goes on with an older copy.
  - What serves the agent in production never fetches: `start`, a deployed box, an embedder's `createAgentService`.
    Each runs on `.contexts/` as it is, and refuses to start, naming the context and `fastagent context fetch`, when
    one is missing. A host started by hand runs `fastagent context fetch` before `start`, as it runs `npm install`.
  - What only reports (`info`, `context list`, `env list`) fetches nothing, and says when a context is not fetched
    yet.
- **Following a context has costs, and pinning is how an agent avoids them.** A context's packages and, with MCP, a
  local server's command are code it makes every machine run. A push to a followed context's `ref` reaches each
  developer's next start and the next deploy, which checks that the joined declarations hold (a value for each
  variable, packages FastAgent installs) and reviews nothing. A change can stop every agent that follows the context:
  a content name another declaration already has, a package at another version than the agent's. A rollback rebuilt
  from an earlier commit uses each context as its `ref` names it then: a pinned one comes back, a followed one does
  not, as with packages (§4). So an agent pins a context its team does not control.
  - Considered: a lock for every context, a committed file that `fastagent context update` moves, as GitHub
    recommends pinning a third-party action to its full commit because a tag can be moved (the
    `tj-actions/changed-files` compromise). A full commit in `ref` is that lock, for the contexts that need one,
    without a second file or command. Reproducing every context to the commit by default is software packaging's
    guarantee, which an agent does not need (§4).
- **A deploy builds each context into the image, and a deployed box never fetches one.** `deploy` fetches every
  context on the machine that runs it, with that machine's git credentials, and stops when one cannot be fetched. It
  checks the joined declarations as it checks the agent's own and ships `.contexts/` in the build context, which the
  generated `.dockerignore` leaves in. A box reads its copy there. `init`'s `.gitignore` keeps `.contexts/` out of
  git, and Railway uploads only what git does not ignore, so a Railway deploy also writes a `.railwayignore` that
  re-includes it (`!/.contexts/`). The Railway CLI reads that file over the `.gitignore` (its upload walker takes
  `.railwayignore` as a custom ignore file, which outranks `.gitignore`, and skips every `.git` directory), so
  nothing else it uploads changes.
  - Considered: fetching on the box at each start, as content is cloned there. A change its author makes would reach
    every deployed agent at its next cold start without a deploy's checks, and stop it: a new variable with no value
    there, a private repository the host's token cannot read. Every cold start would also need the network and a
    credential that reads the context. Fetching in the image build, with a build secret, as an image installs a private
    npm package, was considered too: `deploy` fetches the contexts anyway to check them, and each host takes build
    secrets its own way.
- **The agent's declarations and its contexts' are joined, and nothing is overridden.**
  - Content: each entry, the agent's own or a context's, is cloned at `content/<name>/`, and `context.local.json`
    binds a checkout to any of them by name. A name declared twice, by the agent and a context or by two contexts,
    refuses the start, and the error names both.
  - Environment: the packages and the apt packages are joined. One package at two versions refuses the start, naming
    both, and is mended where it is declared.
  - Variables: a name declared twice is one variable with one value (§6.2), required by each declaration. The secrets
    gate, `info` and the runbooks attribute each: `context.json` for the agent's own, `context "acme-github"` for a
    context's.
  - MCP servers, with MCP: joined by name; a name declared twice refuses the start.
- **A context is a repository, because it is shared.** A local directory cannot be shared: a context's author tries a
  change on a branch, named by `ref`, before merging it. Other git hosts, and npm, can be added as sources the way
  content kinds are (§13).
- **The commands.** `fastagent context add github:owner/repo [--name <name>] [--ref <ref>]` fetches the context, checks
  that it joins the agent's declarations, installs its packages here as `fastagent env add` does, and declares it.
  `context list` shows each context with its description, repository, `ref`, the commit fetched and what it brings.
  `context fetch` brings every context to its `ref` here. `context remove <name>` drops it and its copy. `fastagent env`
  and `fastagent content` edit the agent's own declarations: `env remove gh` for a context's `gh` is refused, naming the
  context. `fastagent info` lists every entry with the context it comes from.

## 4. The environment is declared, for every platform

An agent without a declaration inherits the machine it runs on, the way `bash` inherits the `PATH`. Its environment is
declared in its `context.json`, under `environment`, in FastAgent's own format, and installed by mise on every
platform. The author never writes mise's files.

```json
{
  "environment": {
    "packages": {
      "gh": "2",
      "jq": "latest",
      "npm:@mermaid-js/mermaid-cli": "11",
      "python": "3.12",
      "uv": "latest",
      "pypi:markitdown": "0.1"
    },
    "aptPackages": ["chromium", "fonts-noto-cjk"],
    "variables": {
      "GITHUB_TOKEN": { "description": "gh's token, with repo scope" }
    }
  }
}
```

- **`packages`** are CLIs and runtimes, each mapped to a version: `latest`, a prefix (`2`) or an exact version. The
  name follows Railpack's `packages`; `tools` would collide with the agent's code tools.
- **A package is installed from what its publisher released.** It is a name from mise's registry (`gh`, `ripgrep`,
  `python`), or one written with `aqua:`, `github:`, `gitlab:` or `conda:` for a release, `npm:` for an npm package,
  or `pypi:` for a Python one. A registry name counts by the backend mise resolves it to, checked against an
  allowlist: a release (`aqua`, `github`, `gitlab`, `forgejo`, `http`, `packslip`), a conda-forge build (`conda`), a
  runtime (`core`), or an npm or PyPI package. Any other backend is refused, by name and with an alternative (the
  project's release with `github:`, or the author's own `Dockerfile`): `go`, `cargo` and `spm` build from source,
  which puts a whole toolchain in the image for one binary; `gem` compiles native extensions; `spinel` compiles Ruby
  into a binary; `asdf` runs a plugin's shell scripts at install and has no Windows; `vfox` runs a plugin's Lua at
  install and every time the environment is entered, from a clone nothing pins, so an image built twice from one
  commit can run different plugin code, and a container that cannot reach GitHub on its first start loses the
  tool from its `PATH` with only mise's warning; `dotnet` would join the way PyPI does, with `dotnet` declared beside
  it, once an agent needs it; and a backend mise adds later is refused until it is classified. `http:` is not written
  by hand, because its package needs a URL a version string cannot hold; a registry name that resolves to it carries
  its own. In the registry of mise 2026.10.7, 1,013 of the 1,064 names resolve to an allowed backend; most of the
  others (42 on `vfox`, such as `neovim`, `eza`, `poetry` and `yarn`) have a release or a package to name instead
  (`aqua:neovim/neovim`, `aqua:eza-community/eza`, `pypi:poetry`, `npm:yarn`).
- **What the allowlist cannot see.** FastAgent sets mise's `compile = false` for python, ruby, node and erlang
  (`MISE_PYTHON_COMPILE` and its peers), so a runtime with no prebuilt build for a platform fails there rather than
  compiling: mise compiles python by default when it has none (python 3.6.15 on arm64 macOS), and `all_compile`, already
  false, does not stop it. An npm or PyPI package whose native code has no prebuilt build for a platform still compiles
  there: it installs on a machine that has a compiler and fails in the image with the package manager's error, unless
  its build dependencies are in `aptPackages`. The format keeps out what builds from source where the backend says so,
  and promises no more than that.
- **`aptPackages`** are Debian packages the image installs, for what has no cross-platform build: a browser, fonts.
  A machine that runs the agent locally supplies its own: a start on Debian or Ubuntu names the missing ones with the
  `apt-get` command that installs them. `fastagent env add apt:chromium` writes the package without installing
  anything, since the image installs it; on Debian or Ubuntu it then says whether this machine has it, with that
  command, and never runs apt itself. A name apt does not know fails the image build.
- **The declaration is checked twice.** First its shape: a package in the vocabulary above, a non-empty version, a
  Debian package name, no unknown key. Then, wherever mise runs (`fastagent env add`, `fastagent env list`,
  `deploy`), the backend each registry name resolves to, against the allowlist, and a PyPI package for its runtime,
  below. What mise then cannot install fails `fastagent env add`, which installs a package before it writes it, or
  the image build, with mise's own error.
- **A Python package declares its runtime with it.** A PyPI package, written `pypi:` or a registry name that resolves
  to one (`ansible`), runs on `python` and installs with `uv`; mise takes both from the machine when they
  are not declared, and never adds them, so it would install on the author's machine and fail in the image. The same
  resolution decides it: `fastagent env add` and `fastagent env list` name what is missing with the command that adds
  it (`fastagent env add python uv`), and `deploy --run` stops on it. An `npm:` package runs on the
  image's Node. A runtime the agent works with itself (`go` or `rust` for a repository it builds) is a package like
  any other; for `rust`, the image adds curl, which rustup downloads with.
- **mise is the engine, not the interface.** The agent carries its own mise: its `package.json` lists mise's npm
  packages as optional dependencies, one per platform, of which npm and bun install only the machine's, so a machine
  needs nothing installed first and the image's `npm ci` installs the same mise. FastAgent gives mise the packages as
  arguments (`gh@2`) and lets it read no configuration file: never the machine's mise configuration, a `mise.toml` the
  author keeps for their own work, or a cloned content repository's.
- **Nothing is locked.** A package is a release the agent uses, the way a CLI on a developer's machine is: nobody pins
  `gh` to a patch release on a laptop, and an agent that meets a tool newer than it expected reads its output and
  adapts. Each place installs the newest release a declared version allows when it first needs a package, and keeps it.
  A process that runs the agent asks `mise where` of each package, which answers without the network, and installs only
  those with no install that matches, so a start needs no network once its packages are installed;
  `fastagent env install` asks mise for each again, which installs a newer release where one is out. The image installs
  every package when it is built. So an image may run a newer release than the author's machine, and a rollback rebuilt
  from an earlier commit installs the releases of the day it is rebuilt.
  - Considered: `environment/`, a committed lock (`mise lock` for linux-x64 and linux-arm64, with checksums and the
    dependency lock of npm and PyPI packages), locked again by every deploy and followed by local runs through a
    working copy. Every image of a commit then installs the same versions, and a rollback restores them. It costs a
    committed derived directory, a lock to keep in step with the declaration, `fastagent env update` to move it, a
    working copy for every mise run, and a check that a directory of that name is FastAgent's. Tools reproduced to the
    patch release are software packaging's guarantee, which an agent does not need.
- **The commands.** `fastagent env add gh@2 npm:prettier@3` checks and installs the packages, then writes
  `context.json` under the lock content edits take, applying the change to it as it is by then, so two edits at once
  keep both. `remove` and `list` complete it; `install` installs every package at its newest release, adding mise to
  `package.json` when it is missing; `exec -- <command>` runs a command in the environment. Every process that opens
  the agent (`dev`, `start`, `chat`, `invoke`, an embedder's `createAgentService`) and `tool` install what is missing
  and put the packages first on the `PATH` their commands inherit. A change to `context.json` restarts `dev`.
- **The image installs every package when it is built.** It installs `aptPackages` in its apt layer, with what
  FastAgent needs there (git, CA certificates, curl for rust), then copies `fastagent.packages`, the list every
  deploy writes, and runs `mise install --system` of what it lists, in a layer rebuilt only when the packages or the
  dependencies change. The Dockerfile reads the list rather than holding it, since a generated Dockerfile is kept once
  written and a changed one stops `deploy --run`. The tools go to mise's
  system directory, which every mise reads beside its own data directory and `mise where` finds, so a start on a host
  downloads nothing. On a host, mise's data directory is on the storage (`.state/mise/`). AgentCore builds
  `linux/arm64`.
- **mise's behavior is probed, not assumed.** Every fact above about what mise does was first a guess that a run of
  mise overturned. The offline suite runs a stand-in; `test/live/environment.live.test.ts` runs the agent's own mise
  at its newest version, so a mise release that changes one of them is caught there.
- An agent's environment is its own and those of the contexts it uses, together (§3.6): the packages, the apt packages
  and the variables are joined, and one package at two versions refuses the start.
- A skill script's Python libraries are not part of the environment: the script declares them inline (PEP 723) and
  runs with `uv run`, so a skill carries its own dependencies wherever it goes.
- `deploy.apt` is gone, and the config has no `environment`.
- **`variables` declares the environment variables the agent's commands read, by name; values come from the
  environment.** A declaration is a name and a sentence saying what it is for
  (`"GITHUB_TOKEN": { "description": "gh's token, with repo scope" }`), as `defineTool` declares the `secrets` its code
  reads: convention over configuration. The sentence sits in an object, because a string beside a variable's name is
  read as its value in every format an author knows (`.env`, Heroku's `app.json`, Compose), and a string is refused with
  where its value goes. The value comes from the stage's value file (`.secrets/.env` for dev, `.secrets/production/.env`
  for production, which `deploy` reads and carries) or, for a process started by hand, the variables it is started with,
  the same way a tool's secret does; a stage is one of the two environments the [channel
  environments](channel-environments.md) define. Nothing in `context.json` holds a value, so no value can be committed
  with it, and nothing needs rules for which of two values wins.
  - Every declared variable is required, as a tool's secret is: a serving path refuses to start without its value and
    names `context.json`, `deploy` refuses before its first side effect and lists it with its sentence, and `info` and
    `fastagent env list` say which are set. `fastagent tool` and `env exec` run one tool or one command, and are not
    gated by the agent's declarations, as they are not by another tool's.
  - A name the deployment sets itself (`PORT`, `FASTAGENT_MODEL`, the state and storage paths) is refused: the value
    file's copy never travels, so its declaration could never be satisfied.
  - A shared default that is not a secret (an enterprise host) goes in each stage's value file too; `.env.example` is
    the committed template for them. Defaults written in `context.json` were considered and left out: they make a
    committed file the place a secret can land, and need an order for which value wins.
- How an agent changes its own environment, on a laptop or on a host, is designed with how an agent is developed
  (§12, later): for an author and for the agent itself, it is the same work on the same files.

Measured on Linux arm64, the AgentCore build, and on macOS arm64: sixteen common tools installed the same versions on
both, in about 75 seconds. They were gh, ripgrep, jq, yq, duckdb, stripe, awscli, python, uv, ffmpeg, pandoc,
poppler, tesseract, ImageMagick, and an npm and a PyPI CLI. A PEP 723 script ran on both. In the generated image,
built with colima on arm64 and x64 and with Bun's image as well:

- `chromium` ran headless (`--dump-dom`, a screenshot, CJK text with `fonts-noto-cjk`); the Chromium layer is about
  700 MB and the CJK fonts about 300 MB, installed without apt's recommended packages. Pointing a tool at the browser
  (`PUPPETEER_EXECUTABLE_PATH` for mermaid-cli) needs an environment variable, declared in `variables` with its value in the stage's value file. A package outside the distribution's repositories, or another base image, needs the author's own
  `Dockerfile`, which `deploy` keeps byte for byte and which then owns the whole image, installing the packages
  included.
- A `pypi:` package built only with `python` and `uv` declared. A `cargo:` package needed `rust`, curl for rustup, and
  either `cargo-binstall` (a prebuilt binary; a 3.17 GB image) or `build-essential` (compiled; 3.54 GB): building from
  source puts a whole toolchain in the image for one binary, which is why the format leaves it out.
- The agent's mise adds about 135 MB to the image's `node_modules` (linux-arm64).
- mise gives each conda tool a prefix of its own, so shared libraries are copied per tool: the sixteen tools added
  about 1.65 GB (compressed) to the image, and fourteen of them in one pixi environment about 0.8 GB. A larger image
  starts slower on AgentCore, so declare only the native tools the agent uses.
- mise publishes no npm package for Windows, so an agent with an environment does not run there yet.

Why FastAgent's own format, with mise underneath:

- **mise's files, in part.** The first version took `mise.toml` and refused what FastAgent did not support (`[env]`,
  `[tasks]`, `[hooks]`, a tool's `postinstall`). An author then has to know which part of a familiar format works.
  None of the products surveyed does this: Railpack (Railway's builder, built on mise) and Claude Managed Agents
  define their own `packages`; Cursor, Codex and Copilot take a script, a Dockerfile or workflow steps; devbox and
  Modal have their own format.
- **mise's files, whole**, as Railpack also reads a project's mise configuration. mise's `[env]` is built for a
  developer's machine: a value in a committed file overrides the one the host sets, `mise.local.toml` applies to every
  stage, and a value can run a command when it resolves. Each breaks a rule the platforms keep for secrets and stages:
  Vercel, Railway, Render, Heroku and Fly keep secret values out of the repository, never copy them from one
  environment to another (Railway's sealed variables and Render's `sync: false` ones stay behind when a preview copies
  its base), and let the platform's value win (Fly's secrets over `fly.toml`'s `[env]`).
- **Railpack as the image builder.** It builds an image from a directory with mise inside, but not the environment on
  the author's machine, nor stages, secrets, storage or hosts; it would replace the Dockerfile an author can read and
  own with a build plan, and need BuildKit and its CLI. Its `railpack.json` is the model for this format.
- pixi, one conda environment for every tool, builds smaller images, but it solves every declaration together, on
  every platform. One package missing on one platform fails the whole environment (jq and duckdb have no Windows
  build on conda-forge), which contexts composed by different people would run into often.
- Nix has no native Windows.
- Devcontainer features and package lists such as Claude Managed Agents' `packages` are Linux only.

OpenAI's Codex base image installs its runtimes with mise.

## 5. Connectors are declared

Today a connector is a code tool in `tools/` or a channel's send tool. Pi's MCP extension is not loaded when serving,
because its server connections live as long as a session and a served session lives one turn
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). Proposed, with the serving protocol (§12):

- **A service that speaks MCP** is declared in `mcp.json` at the agent's root, in pi's format, which Claude Code,
  Cursor and VS Code share (`mcpServers`: a `command` or a `url`, `headers` or `env` that name values as `${VAR}`, and
  a `description` the agent reads). `.pi/mcp.json` is read too, below it, as for every file pi and FastAgent both
  have a place for. Pi brings OAuth sign-in (`mcp login`) and per-server exposure with it.
- **A service without MCP** needs no new kind of file. Each way to reach it already has its declaration:

  | The service offers | Reach it with | Declared in | Its credential |
  |---|---|---|---|
  | A CLI (`gh`, `aws`, `stripe`) | The CLI in the environment, and a skill that teaches it | `context.json` (`environment`), `skills/` | The variable the CLI reads |
  | An API this agent calls | Code tools, one per operation, beside the client they share | `tools/` (`defineTool`, §8.1) | `defineTool({ secrets })` |
  | An API several agents or harnesses reuse | An MCP server of one's own, run locally (stdio) or hosted | `mcp.json` | `${VAR}` in `env` or `headers` |
  | An OpenAPI or Smithy description, or a Lambda function, on AWS | AgentCore Gateway, which turns it into an MCP server and handles the outbound authorization | `mcp.json` (`url`) | The Gateway's own |
  | A REST call or two | A skill with a script (`curl`, Python) | `skills/` | The variable the script reads |

- A context carries the declared ones, the environment a CLI needs and MCP servers, so a team declares a service once
  and its agents use it; a skill or a code tool stays in each agent's definition (§3.6).
- `fastagent info` lists every connector in one place, with the context it comes from: the MCP servers, the code tools
  with the secrets they declare, and what the environment installs.
- An MCP connection lives as long as the process or the conversation, not one turn, which is #678.

## 6. Credentials

A credential is proof of authority over another system. Three questions decide how one is handled:

1. **Who uses it**: the model's provider client, a tool's code, a channel, a connector, git for content, or a
   command the agent runs in its environment. The model itself never needs one.
2. **How it is obtained**: as a value, or as an interactive grant.
3. **On whose authority**: the agent's own, or the member who asked.

### 6.1 Declared by what uses it

A credential that code or configuration uses is declared next to it, the way `defineTool` and `defineChannel` declare
`secrets` today. The commands the agent runs read the process environment; what they read is declared, by name, in
the `variables` of the agent's environment (§4), every one of them required.

| Used by | Declared as | Today |
|---|---|---|
| The model's provider | `model`, then its provider's env key or a `login` grant | Exists |
| A code tool | `defineTool({ secrets })` | Exists |
| A channel | `defineChannel({ secrets })` | Exists |
| Content | Its kind's credential: `github` content reads `GITHUB_TOKEN` after git's own helpers, and may name another variable | Read; `deploy` notes when it is missing; not declared |
| An MCP server | `${VAR}` in its `env` or `headers` in `mcp.json`, or an OAuth sign-in (`mcp login`) | MCP is not served yet |
| A command the agent runs (`gh`, `aws`) | The variables it reads, by name, in `environment.variables` in `context.json` (§4) | Exists |

A declaration does what it does for tools and channels today:

- it makes the value required: a serving path refuses to start without it and names the file that declared it, and
  `deploy` refuses before its first side effect. Content's credential is the exception: git's own helpers come first
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

The normative text, with every type, is [SPEC v1](../SPEC.md) (§7.8); this section keeps the reasoning and does not
repeat the types. Where the two differ, the SPEC wins.

### 7.1 Concepts

| Concept | Is | A user uses it to | Exposed as |
|---|---|---|---|
| **Session** | A conversation: the messages of one session share its history | Continue a conversation; list, read, follow, fork, compact or abort it. An operator also names it and sets its model | Named by the caller, or created by the service (§7.4) |
| **Message** | One message a caller sends, from its acceptance to its outcome | Send one (`invoke`); learn whether it was answered, with what, and what it cost; stop the work on it | The unit a caller holds (`messageId`), with a status, events and a cancel (§7.3) |
| **Entry** | One record in a session's history: a user's message once taken, the agent's messages, a tool result, a settings change, a compaction | Read the history; reconnect from a point; fork from a point | Ids that are the cursor for `follow` and the point for `fork` (§7.5) |

How the agent works, in steps, turns or runs, belongs to the harness and is not exposed. A session works on one thing
at a time: it takes a message and works, across model calls and tool calls, until it answers. *Turn* and *run* are
not protocol words: the ecosystem uses *turn* for both a step (pi) and a whole answer (dsh, ACP), and a run is how a
harness groups its work, which differs between harnesses.

| This protocol | pi | pi-durable | DeepSeek Harness | ACP |
|---|---|---|---|---|
| Session | session | conversation | session | session |
| Message | a prompt, steer or follow-up input | Submission (input) | message (`MessageId`) | a `session/prompt` request |
| Its outcome | the run's end that took it | `done` with its answer, or `unanswered` with a reason | the turn's end | the prompt's `stopReason` |
| The work (not exposed) | an agent run, until `agent_settled` | run | turn | prompt turn |
| Entry | session entry | entry | session event | session update |

Names follow one rule: fields are camelCase; enum values and discriminators are snake_case. A field that refers to
another object names its kind: `sessionId`, `messageId`, `entryId`, `parentEntryId`.

**Why the caller holds its message, not a run.** The first version of this design gave the caller a run, a stretch of
the agent's work that took one message or more, with `run_started` and `run_ended` entries in the log. It held a
message to be no unit of its own, since steered messages share the work. Measuring pi-durable 1.3.0 (§9.1) showed
what that costs and what it buys:

- **What must be durable is per message.** A channel owes each user an answer; a retry needs the key it sent; a
  restart must say which messages were cut off. pi-durable keeps exactly that: each submission is admitted durably and
  settles once, `done` with the entry that answered it or `unanswered` with a reason, in the same atomic commit as the
  entries. Its runs are scheduling state that it does not keep after they end.
- **Run boundaries in the log were the costly part.** They had to come before every entry of the run and after its
  last one, in a log the harness also writes. pi-durable places the next queued input in the same commit that ends a
  run, and ends a run whose last answer came before a steer instead of keeping it open, so its boundaries cannot be
  written into its log in order, only guessed from commit order. For pi they took the run markers, a steering report
  by message id and the rule that a run does not end while it holds a steer (§9.3).
- **A message's outcome is real.** The objection was that steered messages share the work. They do, and they share
  its answer and outcome: a message taken by work is answered by that work's answer. pi-durable settles a steered
  input with the same answer as the input that started the run. A steer that arrives after the answer was written was
  not seen by it, so it is answered on its own, by the next work.
- **What a caller reconnecting needs** is the entries after its cursor and the end of its message. Entries carry the
  first; the second comes from the message's durable record, as a `done` event, so it needs no entry in the log.

So the caller holds its message. The log holds the conversation and nothing else, and every harness keeps the
message records it already keeps (pi-durable's submissions) or that the port keeps for it (§9.3).

### 7.2 Invoke

`invoke` returns a stream: an `accepted` receipt naming the session and the message, then the message's events, ending
with its `done` event; or a single `rejected` (SPEC §3).

- **Accepted.** `duplicate` says the key had been seen, and `message` is that message as it is now. The stream is the
  message's follow, from its `user_message` entry, so a duplicate sees what the first saw and `collect` over it gets
  the same answer. A caller that stops reading detaches: the work goes on, and the caller can come back to the message
  (§7.3).
- **Rejected.** The only event of an invoke that was not accepted: nothing ran and nothing was recorded, so it is safe
  to send again. Over HTTP it is an error status instead of a stream.
- **A busy session.** The caller says what a message that arrives while the session works is, and the service applies
  it, because only the service can do so without a race:

  | `whenBusy` | When the session is working on another message |
  |---|---|
  | `queue` (the default) | Queued. Taken once the work before it ends, in arrival order |
  | `steer` | Queued ahead of the queue, and taken by the work in progress after its current tool round, answered by that work's answer. One the work has not taken when it ends, answered, failed or canceled, is taken by the next work, before the queue |
  | `reject` | Rejected with `busy` |

  An idle session takes a message whatever `whenBusy` says. pi-durable offers the same three choices with the same
  default and the same steering rule; dsh and ACP's inject draft offer `queue` and `steer`. The receipt does not say
  whether a steer will be taken by the work in progress: no harness can know until the work reaches its next step,
  and the rule above makes the answer the same either way, one answer per message.
- **Sessions.** A caller that names the session gets that session, created empty by its first invoke: a channel names
  a chat place, a schedule names `schedule:<name>`. A caller that names none gets a new session per invoke, named in
  the receipt. Forking happens only through `sessions.create` (§7.4). The harness's own ids are mapped by the serving
  layer and never reach a caller.
- **Idempotency.** A key is unique within its session and requires `sessionId`: without one, every invoke creates a
  new session, and a retry could never match. A channel uses the platform's message id, a schedule its occurrence id.
  pi-durable keys its submissions the same way, and dsh stores a client-minted id on the message. The key alone
  identifies the message: a second invoke with it is not compared with the first, as pi-durable does not compare
  its `requestId`'s submissions, and storing a hash to compare would buy a `conflict` no caller has needed. The one
  exception to "the same key returns the same message" is a message that ended `interrupted` (§7.3): an invoke with
  its key accepts the text again as a new message, which the key names from then on, and the receipt says
  `duplicate: false`.
- **Source.** Channels, schedules and wake-ups name themselves in `source`, and the message records it. A remote
  caller cannot: an HTTP request or an AgentCore envelope that carries `source` is rejected with `invalid_request`,
  and the service records `{ kind: "api" }`, so no caller can pass itself off as a channel.
- **Without a stream.** Over HTTP, `Accept: application/json` answers `202` with the `accepted` event, and the caller
  follows or polls the message.

### 7.3 Messages

A message is `queued`, `taken` (its `user_message` entry written) or `done` with one outcome: `completed`,
`max_tokens`, `intercepted`, `interrupted`, `canceled` by `cancel`, `abort` or `delete`, or `failed` with an error
(SPEC §4).

- `answer` is the final agent message of the work that took it; messages taken together report the same answer.
  `usage` is that work's cost, reported once, on the first message the work took: with no work id on a message, that
  is what lets a caller add usage up without counting shared work twice.
- `lastEntryId` is the last entry of the history when the work ended. Without run boundaries in the log, it is what
  says where a message's part of the history ends when it has no answer: a duplicate or a reattaching
  `messages.follow` of a message that failed after a tool call replays its `user_message` and its tool results, not
  only its `done`. It is the tail when the work ended, not the work's own last entry, so every harness can record it
  exactly: nothing has to tell the work's entries from others.
- A steered message is `queued` until it is taken, at the front of the queue; it counts toward the 20 and `abort`
  withdraws it.
- `messages.follow` is the session's events for that message, from a cursor or from its `user_message` entry: a
  caller that lost its invoke stream reattaches without following the whole session.
- `messages.cancel` withdraws a queued message, which ends `canceled` without an entry, or stops the work a taken one
  is part of, which ends every message that work took. Messages queued after it are taken as usual.
- A session holds at most 20 queued messages, the cap a conversation's wake-ups already have, and a process caps its
  messages in flight, queued and taken together (100 in the reference implementation: queued messages cost almost
  nothing, and work in progress bounds the memory of a small host such as an AgentCore microVM). Past either, and for
  `whenBusy: "reject"`, an invoke is rejected with `busy`, whose `details.reason` says which: `running`,
  `queue_full` or `capacity`.
- Acceptance is durable: before the receipt is sent, the message is recorded with its id, key and source, and its end
  is recorded before it is reported (§9.3). So `messages.get` answers `undefined` only for a message that was never
  accepted, or whose session was deleted. A message that was accepted and never ended, and is neither taken by work
  in progress nor queued, is reported `interrupted`: one whose work the process stopped, and one lost from a queue
  that did not survive a restart. Whether queued messages survive a restart, and whether work in progress continues
  after it, depend on the harness (`durableQueue`, `durableWork`, §9.3). The service never redoes work on its own:
  its tools may already have had effects (§3.1, invariant 3). A caller that owes an answer may decide to: an invoke
  with the key of an `interrupted` message accepts it again (§7.2), and the new work's tools may repeat effects the
  interrupted one had. `messages.get({ idempotencyKey })` returns the key's newest message. This keeps a channel
  at-least-once, as today: its turn store invokes again with the message's key, at most three times per message.

### 7.4 Sessions

The session operations are SPEC §5.

- **`create`** names the session, or lets the service name it, and is the only way to fork: the new session starts with
  the source's history, up to `entryId` or all of it. A fork copies the history, not the messages: the new session's
  messages are its own. `context: "recent"` gives the model only the recent part of that history (a chat thread
  starting from its room). A session that already exists is a `conflict`. An invoke into a session that does not
  exist yet creates it empty.
- **`read`** returns the state and one page of history, after or before a cursor; `limit: 0` reads the state alone.
- **`follow`** catches up on the history after a cursor, then continues with live events; without a cursor it starts
  from the beginning. A client that opens a session reads its latest page, then follows from its last entry. Every
  harness keeps an ordered log, so the port only reads it after a cursor and the serving layer builds `follow` once
  for all of them (§9.1).
- **`abort`** stops everything the session is doing: the work in progress, every queued message and a manual
  compaction. It reports the messages it ended, so a stop command can say when nothing was running. A chat's stop
  command calls it.
- **`rewind`** moves the session's active branch to an entry, and the next work continues from there. Nothing is
  deleted: the earlier branch stays in the history.
- **`compact`** belongs to the user plane. `update` (a session's name, model and thinking level) and `delete` belong
  to the control plane, because the operator decides what a team's agent runs on and how its conversations are named
  and kept (§7.7).
- **`list`** returns every session of the deployment: FastAgent does not know users, so a gateway in front of many
  users filters it.
- **`commands`** lists what a composer's `/` completion offers: `{ name, description?, source }` for the definition's
  skills, the commands its `extensions/` register, and the machine's skills and prompt templates. It cannot be built on
  the client: only the assembly knows the set after first-wins collisions, and a remote agent's files are not on the
  client's machine. It is read per call, like the definition.
  - **The harness expands a name, never the client.** A skill is sent as `/skill:<name> [args]` and becomes the
    skill's body with the arguments after it; an extension command and a prompt template are `/<name> [args]`.
    `source` (`skill`, `extension`, `prompt`) says which spelling. A client that read `skills/<name>/SKILL.md` and
    built the prompt itself would re-implement loading and break against a remote agent.
  - **One spelling, not a negotiated one.** Nothing in `commands()` or `capabilities` reports it, so a second harness
    with another spelling cannot be told apart; adding one is a contract change. Hard-coding one harness's spelling is
    recoverable, expanding names yourself is not.
  - **An unknown name is text.** A typo and a sentence that opens with a slash are the same bytes, so checking a name
    against the list is the client's job. A skill whose file cannot be read drops out of the list (with a warning), so
    the list covers both. A file removed after the list was read is expanded at prompt time, finds nothing, and the
    work logs `skill_expansion failed` and sends the line as written.
  - A chat channel's own stop command is not on the list: the channel turns it into `abort` before the agent sees it.

### 7.5 Entries and events

Only `entry` events are durable, and an entry's id is the cursor. `done` is built from a message's durable record, so
any follow of a message that has ended reaches it. The others are live: a client that reconnects sees the settled
records, not the deltas it missed. A session works on one thing at a time, so live events carry no message id: they
belong to the work in progress, or to a compaction while the session is `compacting` (whose model retries also send
`retry_scheduled`), and deltas add up to its current agent message until its `assistant_message` entry
arrives. Entries are ordered as appended, and each names its parent, so forks and branches share what they inherited.

The log holds the conversation only: user messages as they were taken, each naming its message, the agent's
messages, tool results, settings changes and compactions. Which entries a piece of work wrote is not recorded; a
caller that wants a message's result reads its `answer`, and one that wants the whole exchange reads the entries
from its `user_message` on.

### 7.6 Results, errors and capabilities

Codes: `invalid_request`, `unsupported`, `not_found`, `conflict`, `busy`, `missing_model`, `auth_required`,
`model_error`, `nothing_to_compact`, `partial_update`, `unavailable`, `internal`. A harness may add codes under its
own prefix; a client that meets an unknown code acts on `retryable`. SPEC §7.1 gives each its HTTP status and
`retryable`. `rewind` is a capability of its own because pi-durable has no call for it (§9.1).

A `read` page holds at most 500 entries (100 by default) and may stop short of `limit`: the reference implementation
ends a page at 4 MiB of JSON, since a tool result's text can be large even with images left as refs. A follow that
cannot start (an unknown session or cursor) is a single `rejected`, as an invoke is.

### 7.7 Planes and HTTP

The operations are grouped by who uses them:

| Plane | For | Operations | Served |
|---|---|---|---|
| User | People talking to the agent, and clients acting for them (duang, an app's front end) | `invoke`; messages; sessions: create, list, read, follow, attachment, abort, rewind, compact; the agent's info, models and commands | `http.api`, on by default |
| Control | Operators and builders | A session's name, model and thinking level; deleting a session. Agent-wide management joins it when a client needs it | `http.control`, off by default |
| Platform | Chat platforms | Channel webhooks, each verified by its platform's signature | When a channel is defined |
| Base | Hosts | Health checks | Always |

The routes are SPEC §9; the base plane adds `GET /health`, and on AgentCore `POST /invocations` and `GET /ping`.

Every route that acts on one existing session names it in its path. Three do not: `POST /invoke` carries its
session in its body, or none, and the service creates one; `POST /sessions` with a fork reads one session and creates
another; `GET /sessions` spans them all. A router in front of many boxes therefore reads an invoke's body, and fork
and the list are part of scaling out (§10.2, §13).

FastAgent authenticates nobody, on either plane: it is a backend service. Exposing it publicly belongs to an API
gateway in front of it, which can treat the planes differently by path, for example authenticating users on the user
plane and admitting only operators to `/control`. When authentication is needed inside FastAgent, it plugs in as
middleware, per plane. The startup report keeps listing what is served unauthenticated. On AgentCore, both planes
travel as IAM-gated `InvokeAgentRuntime` envelopes, and IAM is the gateway. Channels, schedules and wake-ups call the
protocol in process.

This changed a default in step 4: before it, the only route served by default was `POST /invoke`, and reading
sessions was opt-in. With the user plane on by default, anyone who reaches the port can also list every session,
including a channel's direct messages, read and follow them, and abort or rewind them, as anyone who reached it could
already make the agent work. The user plane is what a client needs, so it stays on; a deployment with a public URL
puts a gateway in front, or turns `http.api` off when only its channels are used, since they call the protocol in
process. What this obliges, and the browser-facing rules that follow, are in
[the security boundary](security-boundary.md).

### 7.8 SPEC changes (v1)

`docs/SPEC.md` is this protocol, [SPEC v1](../SPEC.md); it replaced v0.1 in step 4. The harness port stays out of
the SPEC: it is the implementation's contract, and a harness conforms by passing the SPEC's suite through it. v1 was
first written around runs and changed to messages before it was released (§7.1), so it stays v1. Against v0.1:

| Section | Change |
|---|---|
| §2 | `invoke(request)` returns the receipt and then the message's events, or a single `rejected` |
| §3 | `Scope` goes. The request carries an optional `sessionId`, `whenBusy`, `idempotencyKey` and, in process, `source`; forking is `sessions.create` |
| §5 | Events are durable entries and live events (§7.5). `completed.data` goes: no harness produces it, and a structured result waits for a design |
| §6, the three endings | (a) the message's `done` event; (b) `rejected`; (c) the caller stops reading and detaches, while the work goes on |
| §6, MUST 1 | An invoke stream holds exactly one `rejected`, or ends with its message's `done`, unless the process stops |
| §6, MUST 2 | Every failure is an event: a message whose work failed ends with a `failed` outcome, and a refusal is `rejected` |
| §6, MUST 3 | Reversed: a caller that stops reading detaches; `messages.cancel`, `abort` and `delete` stop work |
| §6, MUST 4 | The terminal set changes once, from `{ completed, failed }` to `{ done, rejected }`, and is frozen again |
| §6, MUST 6 | Weaker: while a session works, its calls must reach the process working on it; portable conformance needs a session router in front (§9.3). `conformance-levels.md` says so with v1 |
| §7 | `collect` returns the message's answer when it ends `completed`, and throws on any other outcome or on `rejected` |
| §8 | The lineage, identity and source rows are replaced by §7.2 and §7.4; the mid-turn steering row by `whenBusy`, `messages.cancel` and `abort` |
| New | The message operations (§7.3), the session operations (§7.4) and the planes (§7.7). The harness port (§9.1) stays out, as above |

### 7.9 Compatibility with ACP

Compatibility is checked in both directions, so the protocol stays expressible in ACP without being bound to it:

- **FastAgent as an ACP agent.** A bridge on stdio, for local editors, and at `/acp`, for remote clients, projects the
  protocol onto ACP v1: `session/new` creates a session the service names, `session/prompt` invokes and answers when
  the message is done, with the outcome mapped to a `stopReason`, `session/cancel` aborts, `session/list` lists, and
  `session/load` and `session/resume` follow the session with and without replaying its history. `session/delete`
  and the model and thought-level options are offered only where the control plane is served. `session/update`
  carries the events. ACP's own compatibility kit
  checks the bridge; its v2 drafts (the prompt receipt, `state_update`, inject, fork, resume with replay, the remote
  transport) are followed as they stabilize.
- **An ACP agent as a harness.** claude-agent-acp, codex-acp, Gemini CLI or dsh's ACP server plug in through the
  harness port (§9.1) with fewer capabilities: no steering under v1, no durable queue, and message records kept by
  the serving layer. ACP has no way to append a record of one's own to an agent's history, so for every ACP agent
  `LoopPort` keeps the whole log, recording every `session/update` it receives, and writes its message records into
  that log: `read` and `follow` then work as for any harness, and the message records and the conversation stay in one
  log with one writer (§9.3). An agent's own replay (`session/load`, which dsh's server lacks) is not the source of `read`;
  whether to use it for anything else is settled in step 5.
- **What ACP cannot express today:** caller-named sessions (the bridge maps them), idempotency keys, and a message's
  status by id after its request returned. FastAgent does not use ACP's client file system and terminals, permission requests or elicitation.

## 8. Interfaces

Every interface ends in one operation, `invoke` (§7).

### 8.1 The directory

The directory is the only source of an agent. What this section says of contexts (`contexts` in `context.json`,
`.contexts/`, `fastagent context`) is the deferred design of §3.6.

```text
my-agent/
  SYSTEM.md · APPEND_SYSTEM.md · AGENTS.md   identity and behavior
  skills/ · prompts/                          know-how
  tools/                                      code tools: every value defineTool makes, in any file below
  extensions/                                 pi extensions
  channels/                                   triggers: messages
  schedules/<name>.md                         triggers: time
  context.json                                the contexts it uses, and its own content and environment (§4)
  mcp.json                                    connectors that speak MCP
  fastagent.config.ts                         what only the author sets: the model, serving, deploy
  context.local.json                          this machine's directories the agent is bound to; never in git
                                              or an image
  content/<name>/                             the clone of each declared repository with no checkout bound
                                              here, or a mount; never in git
  .contexts/<name>/                           deferred (§3.6): the contexts it uses, fetched at their ref; never
                                              in git, built into the image
  .secrets/                                   values and grants, never in git
  .state/                                     the service's state, never in git; where it lives is the deployment's
    sessions/<time>_<id>.jsonl                  each session's record: an append-only log of entries (§3.5)
    schedule/                                   schedules' claims and history, pending wake-ups
    channels/<kind>/                            what a channel owes (turns), redelivery dedup, attachments
```

A declaration that has a standard format, or that the agent, a `fastagent` command or another tool writes, is a file of
its own: the contexts, content and environment (`context.json`, which `fastagent context add`, `fastagent content add`
and `fastagent env add` edit), MCP servers (`mcp.json`, which `pi mcp add -l` writes), schedules (the agent). None of
them edits TypeScript, and each is in a format others already read or plain enough for a model to write. The config
keeps what only the author sets and nothing standard describes: the model, serving and deploy options, and `tools`,
code tools defined in code beside `tools/`. Code stays code (`tools/`, `channels/`, `extensions/`).

`tools/` is anchored on `defineTool`, the way Trigger.dev finds every exported `task()` in its task directories:

- Every module below `tools/` is loaded, at any depth, except tests (`*.test.*`, `*.spec.*`), `.d.ts` files,
  `node_modules` and dot-folders. Every tool a module exports is a tool: what `defineTool` makes, recognized by its
  shape (`execute`, `description`, `parameters`) rather than a mark, so a tool made by an older copy of the package
  than the CLI's still loads; a module that exports none is a helper. A tool re-exported by another module is one
  tool.
- A tool is named by `defineTool({ name })`. Without one, a module directly in `tools/` that exports only that tool
  lends it its file name, as today; a module that exports several, or one below a folder, names each tool, so two
  services' `search.ts` cannot collide by accident. Today the file name wins over a `name`; that reverses, so a tool
  whose `name` differs from its file is renamed, which `fastagent info` shows.
- Folders only organize: a service's tools and the client they share sit together and travel as one folder. Grouping
  is `defineTool({ namespace })`.
- A module that fails to load still refuses the start, and a name two tools share is still reported. A file meant to
  export a tool that does not is no longer refused: the tool is missing from the startup report and `fastagent info`,
  which list every tool with its file.

`context.json` is JSON, like `mcp.json`, `models.json` and `package.json`, with a JSON Schema for editors. It holds the
contexts the agent uses, by name and repository (§3.6), its own content, by name, and its environment (§4). A content
entry is a few fields and one sentence for the agent, the size the ecosystem keeps in a manifest (`.gitmodules`, west's
`west.yml`, `mcp.json`); and JSON reads `ref: 1.10` as the string it is, where YAML reads the number 1.1. A context's
own `context.json` holds its content, its environment and a description, and no contexts.

```json
{
  "$schema": "https://fastagent.sh/schema/context.json",
  "contexts": {
    "acme-github": { "github": "acme/github-context" },
    "billing": { "github": "acme/billing-context", "ref": "main" }
  },
  "content": {
    "app": { "github": "acme/app", "ref": "main", "description": "The product's repository. Open pull requests against main." },
    "handbook": { "github": "acme/handbook", "readonly": true }
  },
  "environment": {
    "packages": { "gh": "2", "jq": "latest" },
    "aptPackages": ["chromium"]
  }
}
```

`context.json` is shared, so it declares only content every instance reaches: a repository. Each is cloned at
`content/<name>/`, the way a manifest's projects land at their paths (DVC's `.dvc` file beside its data, a
submodule's directory, a west project); on a host `content/` is a link into the host's storage, which a release does
not replace. A machine with its own checkout binds it in `context.local.json`, beside, under the entry's name; a
directory only this machine has is bound there too, and stays on it. That file holds this machine's paths, so neither
git nor a deploy's build context includes it, nor `content/`. Content's home stays outside the agent's directory
(agent model §2).

```ts
export default {
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
} satisfies FastagentConfig;
```

### 8.2 The CLI

| Stage | Today | Proposed |
|---|---|---|
| Create | `init`, `add <channel>`, `add skill`, `content add/list/remove`: `content add <dir>` binds that directory in `context.local.json` (a GitHub checkout is also declared as its repository in `context.json`) | Deferred: `context add/list/fetch/remove` for shared contexts (§3.6) |
| Develop | `dev`, `chat`, `invoke`, `tool`, `info`, `models`, `env` | The one-off `invoke` keeps a fresh session per call, so nothing it runs can collide with a session a serving process holds. `env add/remove/list/install/exec` edit and use the environment in `context.json`; each command that runs the agent installs it first (§4) |
| Ship | `deploy <host>`, `login [--deployment <host>]`; the image installs the environment (§4) | Deferred: `deploy` fetches shared contexts and builds them into the image (§3.6) |
| Operate | `start`, `logs`, `destroy`, `schedules list` | Unchanged |

### 8.3 Channels, schedules and wake-ups

The entry points inside FastAgent call the protocol in process, like any other caller:

| Caller | Calls |
|---|---|
| A channel | `invoke({ sessionId: the chat place, whenBusy: "queue", idempotencyKey: the platform's message id })`. A thread's first message creates its session with `sessions.create({ sessionId, fork })` from the chat's session, `context: "recent"`, and treats `conflict` as already done. Its stop command calls `abort` |
| A schedule | `invoke({ sessionId: "schedule:<name>", whenBusy: "reject", idempotencyKey: the occurrence })`: an occurrence on a busy session is skipped |
| A wake-up | `invoke({ sessionId, whenBusy: "queue", idempotencyKey: the wake-up and its instant })`: one that fires into a busy session is taken after the work in progress |

Where a thread forks is found through the platform's reply chain: the message the thread starts from, then each
message it replies to, nearest first. The first message in the chain that names a protocol message decides, and the
thread forks at that message's answer. One without an answer, still taken or done without one, forks it at its own
`user_message` entry: the thread has the question, and an answer still being written stays in the chat. A queued
message is not in the history yet, so it forks the thread at the chat's present. Two kinds of chat message name one:

- **A message the channel posted for it**, such as an answer or one of its chunks. The channel records each one with
  its message id, in its own state and bounded per place. This finds an answer in a direct message, which quotes
  nothing.
- **A user's message the channel invoked with**, found by its idempotency key (`messages.get({ idempotencyKey })`).
  This replaces today's search for `msg <id>` in the chat's messages, which also matches a later message that quoted
  the same one.

When nothing in the chain names one, the thread forks at the chat's present. That covers a thread under a message
the agent was not asked about, and under a message the agent posted itself through a send tool, such as a schedule's
digest. Such a post is not followed back to the session that produced it: forking from there would hand that
session's other content, such as a direct conversation or what a schedule posted to other chats, to the thread's
readers. The post still reaches the thread: it is quoted in the thread's first prompt, and the chat's discussion
arrives through the place's history read from the platform ([place history](place-history.md)).

Each passes its `source` with the invoke (§7.2). Channels keep their turn store, because it is what they owe the chat.
Whether `idempotencyKey` replaces their redelivery dedup, and whether they keep their own queue, is decided when they
move (§12).

### 8.4 Clients

A client such as duang uses the user plane: the session list, `read` and `follow`, `invoke` with `queue` or `steer`,
`messages.cancel`, `abort`, `rewind` and `compact`. Naming a session and changing its model or thinking level need the
control plane. The remote client (`connectAgent`) presents the same interface as an agent opened in process
(`createAgentService`); it is the one remote client, for both planes. Clients live outside this repository.

## 9. Architecture

### 9.1 Two contracts: the protocol and the harness port

```text
Callers ──► the serving protocol (§7)     invoke; messages; sessions
              │  the serving layer: ids and mapping, busy rules, limits, follow, planes. Written once
              ▼
            the harness port               submit; cancel and abort; read the log and the messages; sessions; capabilities
              │
              ▼
            pi-coding-agent and pi-durable (step 4); DeepSeek Harness or an ACP agent later
```

Two ways to place the queue of a busy session:

| | A: in the serving layer | B: behind the port |
|---|---|---|
| The port offers | Run one piece of work, steer it, stop it, read the log | Submit with a mode, cancel a message, abort a session, read the log and the messages, settings, fork |
| A harness with a durable queue (pi-durable, dsh) | Its queue goes unused, and queued messages are lost on a restart | Its queue is used, and queued messages survive a restart |
| A harness that is only a loop (pi, an ACP agent) | Works as it is | A shared `LoopPort` adds the queue, message ids and message records |
| The semantics | Written once | Defined once by the protocol, and held by one conformance suite every port implementation runs |

B wins: durable harnesses are the reason to plug in pi-durable and dsh at all, and A would leave their durability
unused.

So the port has two layers. `HarnessPort` is the one the serving layer calls, and a durable harness implements it
directly: pi-durable does. `LoopHarness` is what a harness that is only a loop implements: start work on a message,
steer it and stop it, and, if it keeps a log that can take records of its own, read and append that log. `LoopPort`
turns a `LoopHarness` into a `HarnessPort`, owning what such a harness lacks: admission, the queue, idempotency,
message records and closing interrupted messages. Its records go into the one log it writes: the harness's own when
it has one that takes them (pi's), otherwise a log `LoopPort` keeps itself, recording every event of the work, as for
every ACP agent (§7.9). Either way the records and the conversation share one log with one writer (§9.3). It is
written once, so the semantics of a busy session are the same for pi-coding-agent and for an ACP agent later.

| Port operation | Means |
|---|---|
| `submit(session, message, { whenBusy, idempotencyKey, source })` | Returns the message. Looking up the key, recording the accepted message and queueing it are one step, serialized per session, so two deliveries of one message cannot both be accepted: a durable harness does it natively (pi-durable keys submissions by request id), and `LoopPort` under its per-session lock, with each accepted message recorded in the session's log (§9.3). A durable harness queues natively; `LoopPort` queues for one that is only a loop |
| `cancelMessage(session, messageId)`, `abort(session)` | Withdraw a queued message or stop the work a taken one is part of; stop everything the session is doing |
| `message(session, id or key)`, `read(session, { after })`, live events | The serving layer builds `messages.get`, `read`, `follow` and `messages.follow` on them; a message's `done` comes from its record |
| `create`, `open`, `fork`, `delete`, settings | Session lifecycle; the serving layer maps caller-named ids to the harness's own |
| Capabilities | `steer`, `fork`, `rewind`, `delete`, `durableQueue`, `durableWork`. A port that offers `steer` lets the work in progress take a steer at its next step, and has the next work take one it did not, ahead of the queue (§7.2) |

|  | Withdraw a queued message | Stop the work in progress, keep the queue | Abort the session |
|---|---|---|---|
| DeepSeek Harness | `inbox.remove(id)` | `cancel(user, { keepInbox: true })` | `cancel()` |
| pi-durable | `submission.abort()` | `harness.abortTask()` on `pi.live.run.taskId`; the queue then waits, so the port places it (below) | `conversation.abort()` |
| pi, an ACP agent (`LoopPort`) | Remove it from `LoopPort`'s queue | The `AbortSignal` given to the work | Both |

Steering stays a harness capability, because only the loop knows where its steps end: from outside, the serving
layer could only stop a step, killing a tool mid-call, or wait for the work to end, which is a queued message.

**pi-durable, measured.** Spikes with faux models checked these port operations against it. On 1.1.0: steer, reject,
withdrawal, cursor reads and live events. On 1.3.0: a run with a tool, follow-ups and steers mid-tool, a steer that
arrives after the final answer, a failed run and an aborted one with inputs queued behind them, a conversation abort,
input entries of the host's own kind, and a `kill -9` mid-tool on SQLite storage followed by a reopen. Fork, settings,
`rewind` and `delete` were read from its API and its specification (`packages/durable/docs/spec.md`), not run.

| The port needs | pi-durable 1.3.0 |
|---|---|
| Admission with a mode and a key | `submit({ whenBusy, requestId })`, admitted durably: `followUp` (this protocol's `queue`), `steer`, or `reject`, which throws `ConversationBusy`. The same `requestId` returns the same submission |
| A message's outcome | Each submission settles once, in the commit that writes the entries it settles with: `done` with its `entry` and its `answer`, or `unanswered` with a `reason` (`aborted`, `model_error`, `no_model`, `reset`, …). Its runs are scheduling state (`pi.live.run`), not kept after they end |
| Steering | A steer queued during a tool round is placed after it and settles with the run's answer. One still queued when the run writes its answer starts the next run, with the first queued follow-up if there is one (its specification, §6), and gets an answer of its own (measured). That is this protocol's rule (§7.2), so `steer` maps without adaptation |
| Which entry a message became | The submission's `entry`. An input may carry `entry: { kind, data }` (1.2.0), placed as an entry of that kind, so the port's `user_message` carries its message id, key and source without a lookup, written in the same commit that places it |
| Message ids | The message id is the Agent's, not the caller's key: the key is optional and the caller's, the message id always present and never reused. The port submits with request id `k:<key>` when the caller sent a key, otherwise `m:<minted>`, and the message id is that request id. pi-durable's own atomic dedup by request id is then the protocol's, a minted id and a key can never share a request id, and every message id is addressable in a URL (a key of `.` is not). A key names one message only: pi-durable never ends a message `interrupted` (below), so this harness never accepts a key's text a second time |
| Surviving a restart | Measured on SQLite: after a `kill -9` mid-tool and a reopen, the run continues (`resume()`), the tool is not rerun, and the queued input survives and is answered. A tool cut off mid-call is rerun only if it declares `replay: "safe"`; otherwise the model gets an "interrupted" error result and carries on. `durableWork` and `durableQueue` both hold |
| Reading after a cursor | `entries({ minEntryId, order: "ascending" }, limit, cursor)`; entry ids ascend |
| Live events | `watchEvents()`: a snapshot, then events derived from each commit (`run_start`, `message_*`, `tool_execution_*`, `submission`, …). Nothing is replayed, so `follow` reads entries first, as for every harness |
| Withdrawing a queued message | `submission.abort()`; one already placed answers `already_placed` |
| Work that did not answer, and the queue behind it | After a run that fails (`model_error`, `no_model`) or whose task is aborted, the queued inputs stay in `pi.inbox` until the next input or queued write runs a boundary (measured for both), and nothing else appends to the conversation until then. So after such a run the port submits one write of its own kind with `edits: []`: its data is the run's `lastEntryId`, the conversation's tail at that moment, which is exact because nothing was appended since the run ended; and since it is not display-only, it runs the boundary that places the waiting inputs. It is the message records' end in pi-durable's own store, one commit, never published. A process that stopped between the run's end and that write finds the run settled without it on reopen, and writes it then, before answering anything on the session: the tail is still the run's. For an answered run `lastEntryId` is its `answer`, and the next run starts in the same commit, so no write is needed. pi-durable's unreleased `afterFailedRun: "continue"` covers failures but not aborts, so the write stays |
| `fork`, settings | `conversation.fork(entryId)` creates a new conversation with the history up to that entry; `configure()` sets the model and thinking level |
| `rewind`, `delete` | Neither exists: no call moves a conversation's active branch, and none deletes a conversation. Both are `false` in its capabilities; emulating them (a fork the session id is remapped to, a deleted mapping that leaves the data) would be the silent downgrade SPEC MUST 5 forbids |
| Aborting the session | `conversation.abort()`: the running run and every queued input end `unanswered` with `aborted` (measured) |
| Models and credentials | `models` is pi-ai's `Models`, which FastAgent's `ModelRuntime` implements, so `models.json` and the grants carry over unchanged |
| Code tools | Its `defineTool` takes a TypeBox schema, which is JSON Schema, so a FastAgent tool (Zod) needs an adapter for `execute` only |

Since 1.2.0 it has codemode (`@earendil-works/pi-durable/codemode`), whose scripts call tools as nested calls that
survive a restart, `tool_search` over deferred tools (`/tool-search`), and images in its `read` tool. It still lacks
what pi-coding-agent gives an agent today: skills and prompt templates (its prompt sections can render `SYSTEM.md`,
`AGENTS.md` and the skill list, and FastAgent can expand `/skill:` itself), pi extensions (`extensions/`), MCP, and
the `chat` TUI. Its records are its own storage, not pi's session files, and one process owns a storage with no lock
across processes, so the serving process's lease still applies. Its SQLite storage on Node uses `node:sqlite`, which
Bun lacks; its portable SQLite core takes any asynchronous database facade, so Bun would need an adapter over
`bun:sqlite`. It is marked experimental, with an API that changes without notice, so its version is pinned exactly;
its next release also migrates SQLite storage to a schema that 1.3.0 cannot open.

So in step 4 pi-durable is a second harness behind the same port, chosen per agent with `harness: "pi-durable"` in
`fastagent.config.ts`, and pi-coding-agent stays the default: an agent that uses `extensions/`, MCP or `chat` keeps
working, and the port is shaped by a durable harness from its first implementation instead of being retrofitted to
one later. It implements `HarnessPort` directly, keeps its storage in one SQLite database under `.state/`, and is
loaded only when an agent chooses it, so the default path neither imports it nor needs `node:sqlite`. An agent that
chooses it and also declares what it cannot run (`extensions/`, `mcp.json`), or runs on Bun, is refused at start,
and the error names the cause; nothing it declares is dropped silently.

**DeepSeek Harness, read.** dsh was read from its source (0.2.1-alpha.2) rather than run. That version is on npm
under the `alpha` tag, and `@deepseek-ai/dsh-base@0.2.1-alpha.2` resolves (350 packages); `latest` still points at
0.0.1-rc.1, which does not install (it depends on a package that is not published). What its code and documentation
show:

- Its `Agent` has the operations the port needs: `followup()` (this protocol's `queue`), `steer()` and `inject()`; a
  durable inbox of messages with ids (`inbox.remove()`); and `cancel(cause, { keepInbox: true })`, which stops the
  running turn and keeps the queue. Turn boundaries are `turn/start` and `turn/end` events in its session log.
- Embedding it in process means composing its cordis plugin runtime (`dsh-base`, some eighty plugins). Its
  out-of-process SDK carries only prompt and wait, with no cancel and no steer, too little for the port.
- It ships an ACP v1 server (`dsh --profile acp`): sessions are created, listed, resumed and closed, prompts run one
  at a time per session, and `session/cancel` stops the running work. It has no `session/load`, fork or deletion, so
  it cannot replay a session's history to a client.

So DeepSeek Harness is reached first as an ACP agent (step 5), with what ACP v1 carries. Without `session/load`, the
port's `read` has no source in dsh: `LoopPort` records the whole log, every `session/update` it receives, not
only its message records (§7.9). A native port for it waits for the cost of composing its plugin runtime to be worth what
ACP leaves out, which a run against the npm `alpha` release would measure.

### 9.2 Layers

```text
Entry points    CLI · SDK · HTTP/SSE · channels · schedules · wake
                  ↓ every one calls the serving protocol
Serving layer   ids · busy rules and limits · follow · planes · triggers (the scheduler) · credentials
                  ↓ the harness port
Harness         pi today; others later
                  ↓ storage: the state root (a filesystem today)
Works with      Content (content/<name>/) · Connectors (tools, MCP) · Environment (context.json): its contexts
```

### 9.3 Messages and durability

What a caller reads after the fact comes from one durable record per message: written when it is accepted, with its
id, key and source, before the receipt is sent, and ended once, with its outcome, the entry it became, the history's
tail when its work ended (`lastEntryId`), its answer and, once per piece of work, its usage, before that end is
reported. A harness keeps it natively (pi-durable's submissions) or `LoopPort`
keeps it for one that is only a loop. A message's status is derived from that record and the queue. A message that
was accepted, never ended and is neither taken by work in progress nor queued is `interrupted`; its end is recorded
when the session is first opened after the work stopped, before anything on it is answered, so a caller reattaching
with `messages.follow` after a restart reaches its `done` without the session working again. Only live events and,
for a harness that is only a loop, what `LoopPort` holds while a session is busy are in memory: the order of its
queue, its work in progress, the session's one log writer (pi's `SessionManager`, which caches the whole log) and the
index of its keys and messages. The last two are caches of the durable log, and a queued message lost with the first
two is still known, as `interrupted`.

The records live in the same store as the conversation, written together. pi-durable commits a submission's
settlement atomically with the entries it settles with. `LoopPort` gets the same property from a harness log that has
one writer, into which it writes three records, each naming its message: `message_accepted` when it is accepted,
`message_taken` with its entry when the loop reports writing it, and `message_ended` with its outcome, its entry
again (so an end is whole when the `message_taken` was refused), its `lastEntryId` (the log's tail as it is written)
and, on the first message the work took, its usage. All three
are plane markers (`isPlaneMarker`): never published, never navigable, never seen by the model, never copied by a
fork. Nothing else marks the log: which entries a piece of work wrote is not recorded (§7.5), so the published log is
the conversation alone. A record of accepted messages in a file of its own was considered and not chosen: two files
cannot be written atomically, so every crash between them would need its own recovery rule, for a gain that arrives
only with scaling out, whose storage is redesigned anyway (§10.2, §13).

The rules this gives `LoopPort` over pi-coding-agent, each checked against pi with a faux model:

- **One writer.** pi's `SessionManager` keeps the whole log and its leaf in memory and appends to the file. A second
  manager writing the same file does not corrupt it, but the entry it writes is a side branch the active path never
  reaches. So every operation on a session, a read included, acquires it through `LoopPort`'s per-session lock, which
  holds the session's one `SessionManager` from the first acquisition until the session is idle, its queue empty and
  no operation holds it. Every write to the log goes through that manager: the message records, a withdrawn message's
  end, `update`, `rewind` (pi's `branch` and its leaf anchor), `compact`, and each piece of work's fresh
  `AgentSession`, which is bound to it. The first acquisition in a process ends the session's interrupted messages
  before anything else, so two operations arriving together after a restart cannot both end one. An idle session
  holds nothing in process.
- **Writes during work.** Appended through the work's own manager, a record or a settings change keeps the log one
  chain, never reaches the model's context, and survives a reopen unchanged. Work in progress takes its model from its
  agent's state, so `update` during it applies from the next work, as the SPEC says, instead of answering `busy`. One
  window is not covered: a message accepted but not yet bound to pi (its extensions still loading) binds on the new
  settings. Binding it on the settings it was accepted with would not help, since pi records the model it binds, which
  would then override the update for every later message too.
- **Which entry a message became.** pi's entries carry no message id. The loop reports, for each message, the entry
  it wrote for it as it writes it, and `LoopPort` records that at once as `message_taken`, through the same manager;
  a published `user_message` names its message through the index built from those records. So work the process loses
  still leaves its messages' entries named, and an `interrupted` message replays what it wrote. The one gap is a stop
  between pi appending the entry and `LoopPort` appending its `message_taken`, two writes in a row on one manager:
  that entry stays unnamed and its message ends `interrupted` without an `entryId`, as SPEC §6 allows.
- **Where a message's history ends.** `message_ended` is written through the same manager right after the work
  settles, and for an `interrupted` message at the first acquisition after a restart, before anything else writes. In
  both cases nothing has been appended since the work stopped, so the log's tail is its `lastEntryId`.
- **Idempotency.** Opening a session scans its whole log, not only the active path (a rewind leaves earlier messages'
  keys on an abandoned branch), into an index of keys to messages held while the session is busy.
- **Steering.** Only the loop can say what became of a message it was handed, so a loop reports it for each message,
  by the id `LoopPort` handed it under and as it happens: written as an entry, or consumed without one. By id, because
  a report by position shifts every later message when one steer fails; as it happens, because a taken message's
  `messages.get` should name its entry while the work goes on. pi keeps a run going for a message steered before
  `agent_settled`, even after a failed model request; an extension's `input` handler can consume one (`steer()`
  answers `handled`, and no entry is written), which ends it `intercepted`; and since `steer()` awaits those handlers
  before it queues, a message can reach pi's queue after its run settled, where nothing runs it. The pi harness
  reports those three from what pi tells it. A message the loop said nothing for when the work ends was not taken, and
  `LoopPort` has the next work take it, ahead of the queue, as the SPEC's steering rule says (§7.2), whether the work
  answered, failed or was canceled. Work the process lost ends its messages `interrupted`, naming the entries their
  `message_taken` recorded: which entry was whose is the loop's to say, so it is recorded as the loop says it. Counting the work's user entries cannot tell these apart, checked against pi: a consumed
  message has no entry and would be taken twice.
- **Withdrawing a steer.** `messages.cancel` of a steer the loop holds and has not taken asks the loop to take it
  back, and it is `canceled` without an entry only when the loop can promise it never will: pi's harness drops one
  still in its `input` handlers, and takes one out of pi's steering queue by queueing the others again without it,
  synchronously, so pi cannot select it in between. One pi has already selected for its next step is the work's: the
  cancel stops that work, and the steer ends `canceled` with it, never carried to the next work.
- **Where a live event sits.** Every live event the port reports carries the newest entry published before it. A
  subscriber reads the log after it subscribes, so its live queue overlaps that read; only an event that follows the
  newest entry it was given is new. That keeps a message's stream from replaying another message's answer, or its own
  entry twice, when the message is taken between its admission and the read.

pi and `writeFileAtomic` both write without `fsync`, so either choice survives a process crash and may lose its newest
write on power loss; pi drops a torn last line when it loads a log.

| What happens | A taken message | A queued message |
|---|---|---|
| The caller stops reading | The work continues | Stays queued, and is taken in its turn |
| `messages.cancel` | The work stops: `canceled` by `cancel` | Withdrawn: `canceled` by `cancel` |
| `abort` | The work stops: `canceled` by `abort` | Withdrawn: `canceled` by `abort` |
| `delete` | The work stops: `canceled` by `delete` | Withdrawn: `canceled` by `delete` |
| The process stops: a restart or a deploy | The work continues with `durableWork`; otherwise `interrupted`, and what it recorded stays | Stays queued with `durableQueue`; otherwise `interrupted` without being taken |

The service never redoes work on its own: its tools may already have had effects (§3.1, invariant 3). A caller that
owes an answer invokes again with the message's key, which is accepted again only when the key's message was
`interrupted` (§7.3); the channels do, from their turn stores, so they stay at-least-once.

Process affinity exists only while a message is taken or queued (SPEC MUST 8), and routing across instances belongs to
a session router above FastAgent. FastAgent's deployments meet it by topology: one process per agent on a resident
host, and on AgentCore the microVM of the runtime session the call names. Scaling out keeps it by giving each
conversation its own runtime session, which a router finds from the path or the invoke's body (§7.7). It is weaker
than v0.1's rule, which forbade requiring a session's invocations to land in one process: a queued message in
`LoopPort`'s memory, or a steer, is state only the process working on the session holds. Portable conformance needs
that router in front (§7.8).

### 9.4 Where state lives

| Where | Holds | In git, and on a deploy |
|---|---|---|
| The definition | Identity, behavior, skills, tools, triggers, the config | In git; built into the image |
| `.state/` | The service's state: session records, schedule claims, wake-ups, channel state | Not in git; where the deployment puts it (§10.2) |
| `context.local.json` | This machine's directories the agent is bound to: its checkouts, and directories only it has | Not in git; never in an image |
| `content/<name>/` | The clone of each declared repository, or a mount | Not in git; on a host, a link into the host's storage |
| `.contexts/<name>/` | Deferred (§3.6): the shared contexts the agent uses, fetched at their `ref` | Not in git; fetched by each deploy and built into the image |
| `.secrets/` | Values and grants | Not in git; values reach the host through its secret store |

### 9.5 Principal

Deferred. Channels already write the sender into the prompt, which is what the agent needs today, and every message
records its `source`: the channel, schedule, wake-up or API call that sent it (§7.3). A structured principal, who
the person was, comes with permissions, when they are designed, and is then asserted this way:

- a channel asserts the platform account, because the platform's signature has already authenticated the message;
- over HTTP, FastAgent authenticates nobody, so it accepts one only from a trusted gateway configured for it.

### 9.6 Agents calling agents

An agent reaches another through `connectAgent`. For the caller that is a connector; for the callee it is a request
trigger. No further concept is needed.

## 10. Deployment

### 10.1 What a deploy builds

An image holds the base runtime, the environment (§4), the definition, the contexts it uses as the deploy fetched them
(§3.6), and a release manifest; the agent's dependencies are installed on the host's storage. It holds no credential,
no state and no content: values reach the box through the host's secret store, grants are made on the box
(`login --deployment`), and content is cloned there at start, which preflight checks.

### 10.2 Two kinds of host

| | Resident (Docker, Fly, Railway) | AgentCore |
|---|---|---|
| Process | One per agent, holding the storage lease | One microVM per runtime session. Today every entry point uses one fixed runtime session, so one microVM. It scales to zero after 180 idle seconds by default |
| Storage | A volume that outlives deploys | SessionStorage, one per runtime session: it survives scaling to zero; AWS resets it on every deploy and after 14 idle days |
| Clock | The local scheduler | EventBridge |

AgentCore is where most agents run: an idle agent costs nothing, and the platform is built for agents. A run that
outlives its caller counts as background work, so `/ping` answers `HealthyBusy` and AgentCore keeps the microVM until
the run settles, up to the runtime's maximum lifetime of 8 hours.

A box is disposable by design. The program, its contexts and its environment come from the image; content is cloned
and connectors connect from the agent's declarations; a chat place's history is read from the platform
([place history](place-history.md)). So a deploy may wipe the box.

What remains is the service's **state**: sessions, the agent's working memory of each conversation; wake-ups;
schedule claims; channel records. State is declared apart from the content, because the service writes it and the
agent does not, it changes on every turn, and each piece must have one writer. Where it lives is the deployment's
choice: a volume on a resident host, and on AgentCore today the session storage, which a deploy wipes. That stays
until scaling out, whose design moves state to storage reached through an API (AgentCore Memory for conversations,
DynamoDB or S3 for the rest): it is shared by every microVM, outlives a deploy, needs no VPC, and costs nothing while
idle. A file system shared over a VPC (EFS, S3 Files) is not used: it would add a standing NAT bill and still need
the state split by writer.

Scaling out is the serving goal on AgentCore: a runtime session per conversation instead of one for all, so
conversations run on separate microVMs, and each scales to zero on its own. It needs the ingress to route each message
to its conversation's runtime session, found from the route's path or the invoke's body (§7.7),
and what spans conversations (redelivery dedup, the session list, schedules) to live outside any one of them (§13).

### 10.3 Operations

`logs` shows what the service printed. What an agent is doing is each session's state and messages (`read`,
`messages.get`), and what it cost is the sum of the messages' `usage`, which each piece of work reports once, on the
first message it took.

## 11. What changes in FastAgent

| Area | Today | Proposed |
|---|---|---|
| Environment | `environment` in `context.json` (`packages`, `aptPackages`, `variables`), installed by the agent's own mise, here and in the image, at the newest release each version allows (step 3) | Deferred: joined with shared contexts' (§3.6, §4) |
| Declarations | What the agent works with, in the TypeScript config | A declaration with a standard format, or one the agent or a tool writes, is a file of its own; the config keeps what only the author sets (§8.1) |
| Content and contexts | Repositories in `context.json`, cloned at `content/<name>/`, and this machine's directories in `context.local.json` (step 3); no shared contexts | Deferred: a context is a GitHub repository whose `context.json` declares content, environment and, with MCP, connectors, built into the image by each deploy (§3.6, §8.1) |
| State | `.state/` on the host's storage | Declared apart from the content; on AgentCore, API storage when scaling out (§10.2) |
| Code tools | Every tool exported from any module below `tools/`, helpers beside them (step 3, §8.1) | Unchanged |
| Connectors | `tools/`, channel send tools; MCP off when serving | MCP servers in `mcp.json` (#678); a service without MCP through a CLI, code tools or an MCP server of one's own; all listed by `fastagent info` (§5) |
| Credentials | Declared by tools and channels; one value file and the model's grants | Declared by everything that uses one (§6) |
| The contract | [SPEC v1](../SPEC.md), the serving protocol (§7): sessions, messages whose outcome outlives their callers, entries and events, idempotency keys (step 4) | Unchanged |
| Sessions | Named by the caller or by the service; created by an invoke or by `sessions.create`, the only way to fork (§7.4, step 4) | Unchanged |
| A busy session | `whenBusy`: `queue` (the default), `steer`, `reject` (§7.2, step 4) | Unchanged |
| Stopping and steering | `messages.cancel` and the session's `abort`; steering through `invoke` (§7.3, §7.4, step 4) | Unchanged |
| HTTP | The user plane (`http.api`), on by default: invoking, listing, reading, following, aborting and rewinding sessions; the control plane (`/control`, `http.control`) off by default (§7.7, step 4) | Unchanged |
| A channel's turn after a restart | Its turn store replays it, at most three times | The same in effect: the service never redoes work, and the turn store invokes again with the message's key, which is accepted again only when the key's message was `interrupted` (§7.3) |
| The harness boundary | Two contracts: the protocol above, the harness port below, with `LoopPort` holding the queue for pi (§9.1, step 4) | A durable harness behind the same port (pi-durable, step 4) |
| AgentCore | One fixed runtime session for every entry point | A runtime session per conversation (§10.2) |
| The agent's own changes on a host | Lost at the next deploy | Designed later (#605) |

### 11.1 What changes in the agent model

The [agent model](agent-model.md) describes what is implemented. It took this design's vocabulary in step 3 (§12):
the data an agent works on is its content, declared in `context.json` (repositories, cloned at `content/<name>/`) and
bound on each machine in `context.local.json`, and *context* is the whole. What still differs:

| Agent model (implemented) | This design |
|---|---|
| No shared contexts | Shared contexts, deferred (§3.6) |

## 12. Order of work

| Step | Work |
|---|---|
| 0 | Finish this design |
| 1 | Rename engine to harness in the code and the SPEC: a refactor, no change in behavior. Done |
| 2 | Upgrade to pi 1.1.0. Done |
| 3 | Declarations as files: `context.json`, with content at `content/<name>/`; `tools/` anchored on `defineTool`; the environment in `context.json`, installed by mise. Done |
| 4 | The serving protocol (§7) on the harness port (§9.1), with `LoopPort` for pi-coding-agent, pi-durable as a second harness an agent opts into, and one conformance suite both pass; the SPEC rewritten; channels, schedules, wake-ups and duang move to it; MCP servers in `mcp.json`, their connections held by the serving process rather than one turn (#678). Done: the protocol and `LoopPort` for pi-coding-agent with its conformance suite, the SPEC and its change from runs to messages (§7.1), and channels, schedules and wake-ups on it. Not yet: pi-durable, duang, MCP |
| 5 | ACP compatibility in both directions (§7.9); DeepSeek Harness's ACP server is the first ACP agent used as a harness |
| 6 | Scaling out on AgentCore: a runtime session per conversation, and state in API storage (§10.2) |
| Later | The agent's update loop (#605); evaluation; DeepSeek Harness as a native harness, if a run against its npm `alpha` release shows ACP leaves out too much; more content kinds |
| Deferred | Shared contexts (§3.6), when a concrete cross-agent need warrants them |

## 13. Open questions

Each is settled when the step that needs it is built (§12).

1. How `context.json` names a content entry's credential (its shape for content is settled: entries by name, with
   `github`, `ref`, `readonly` and `description`, and no machine's path); where an MCP server's OAuth tokens live for
   a deployed agent.
2. Settled in SPEC v1 §7: the error codes with their HTTP status and `retryable`, a process cap of 100 messages
   in flight, and `read` pages of at most 500 entries (100 by default, 4 MiB).
3. Scaling out on AgentCore: routing each message to its conversation's runtime session, an invoke by its body; a
   fork, which reads one session and creates another; a lease that holds across processes; how state is split by
   writer (each conversation's own, and what spans conversations: redelivery dedup, the session list, schedules);
   which API storage holds each part. Pending wake-ups are part of it: a deploy must
   not wipe them.
4. Settled in §9.1: pi-durable is chosen with `harness: "pi-durable"`, implements `HarnessPort` directly over SQLite
   under `.state/`, places its waiting queue with a write of its own after work that did not answer, and offers no
   `rewind` or `delete`. Which of skills and prompt templates it gains through FastAgent is settled when it is built;
   extensions, MCP and `chat` stay pi-coding-agent's.
5. Settled with pi-durable: a harness whose work continues after a restart (`durableWork`) keeps its own message
   records, so the port adds nothing; a harness that is only a loop does not continue its work (§9.3).
6. Content kinds, and context sources, beyond GitHub repositories and this machine's directories: another git host,
   npm for a context, an S3 bucket synced to files.
7. Acting as the member who asked (§6.3), with permissions.

## 14. Decisions made in review

The product and the model:

- A unit above agents (a team, members, a shared deployment) is outside FastAgent. Sharing declarations across agents
  through contexts is deferred (§3.6).
- `Agent = model + harness + context`: the model from a model provider, the harness pi (the loop that runs an agent,
  as the ecosystem uses the word), and the context everything it works with from outside. FastAgent defines the agent
  and composes the three in its definition, its own directory, which the agent model called the harness until this
  review, and serves the result.
- The context has three kinds: content (data the agent reads and writes as files, writable or not, synced to where it
  runs), connectors (the other systems it reaches, through MCP, APIs and their credentials) and environment (what it
  runs in). The data kind is called content, so that *context* means only the whole. The test in §3.2 separates
  content from connectors.
- Deferred, and the design to start from if sharing is needed: a context is the unit of sharing, a GitHub repository
  whose `context.json` declares content, environment and, with MCP, connectors, and carries no prompt and no code the
  harness loads, which are each agent's definition. An agent is
  shared as its definition, and what it works with a context at a time. An agent names each context's repository and
  `ref`: a branch or a tag follows the context, a full commit pins it, and there is no other lock. The commands that
  develop the agent fetch each context at start, `context fetch` and each deploy fetch it and fail when they cannot,
  and production (`start`, a deployed box, an embedder) never fetches: a deploy builds the contexts into the image.
  The declarations are joined, a name declared twice refuses the start, and contexts do not nest (§3.6).
- The environment is declared in FastAgent's own format, under `environment` in `context.json`: `packages` by mise's
  names, `aptPackages` for the image, and `variables`, the names of the variables its commands read, whose values come
  from the environment as a tool's secrets do. mise, the agent's own (an optional npm dependency per platform), installs
  it, with the packages as arguments: nothing is locked, each place installs the newest release a version allows when it
  first needs a package and keeps it, and the image installs every package when it is built. The author never writes
  mise's files, so no part of a familiar format is silently unsupported. A package is installed from a release, a
  conda-forge build, a runtime, or an npm or PyPI package, checked against an allowlist by the backend mise resolves;
  backends that build from source or run a plugin's code (`vfox`, `asdf`) are refused by name, runtimes are prebuilt
  only, and the native code an npm or PyPI package compiles is caught only by the image build. A PyPI package's `python`
  and `uv` are declared with it, and a missing one is named. The config has no `environment`. A system package outside
  the distribution needs the author's own `Dockerfile`. A skill script declares its Python libraries inline (PEP 723)
  and runs with `uv run` (§4).
- Credentials are declared by the code or configuration that uses them and stored by how they are obtained (§6). The
  shell keeps inheriting the process environment; isolation waits for a sandboxed environment (§6.4).
- A declaration that has a standard format, or that the agent or a tool writes, is a file of its own (contexts and
  content, MCP servers, the environment, schedules); the config keeps what only the author sets and nothing standard
  describes: the model, serving and deploy options, and `tools` (§8.1).
- `context.json` (JSON, with a JSON Schema) lists the contexts an agent uses, its own content and its environment
  (§4), each content entry a repository with a description for the agent, cloned at `content/<name>/` (§8.1);
  `context.local.json` binds this machine's checkouts and its own directories, never committed. Content:
  implemented, without a published JSON Schema yet.
- A service that speaks MCP is declared in `mcp.json` at the root, in pi's format (`.pi/mcp.json` is read too). A
  service without MCP is reached through a CLI and a skill, code tools, or an MCP server of one's own: there is no
  connector file type, and `fastagent info` lists every connector (§5).
- `tools/` is anchored on `defineTool`: every tool exported from any module below `tools/` (tests and `.d.ts` aside)
  is mounted, recognized by its shape so a tool from an older copy of the package still loads, and a module that
  exports none is a helper. A tool is named by `defineTool({ name })`; only a module directly in `tools/` that
  exports one tool may fall back to its file name. Folders only organize; grouping is `namespace` (§8.1).
  Implemented.
- The deployed definition stays writable. The agent's update loop is designed later, in #605 (§2); the core now is
  serving.
- No new waiting states for human input: steering, queued messages, cancelling and aborting cover it.

The serving protocol:

- FastAgent defines its own protocol, synthesized from pi-durable and DeepSeek Harness; ACP is a compatibility target
  checked in both directions, not the contract (§7, §7.9). `docs/SPEC.md` is this protocol (§7.8).
- The concepts a user sees are the session, the message and the entry; how the agent works, in steps, turns or runs,
  stays inside the harness. The message is the unit a caller holds, from its acceptance to its outcome. The first
  version made the run that unit, with its boundaries as entries in the log; it changed to the message before SPEC v1
  was released, after measuring pi-durable 1.3.0, which keeps exactly a per-message record and no runs, and whose
  boundaries could not be written into its log in order (§7.1).
- `invoke` keeps its name and takes one request: an optional `sessionId`, the prompt, `whenBusy` and an
  `idempotencyKey`. Its stream starts with an `accepted` receipt naming the session and the message, or is a single
  `rejected`, and ends with the message's `done` event, built from its durable record (§7.2).
- A session is named by the caller or created by the service. `sessions.create` is the only way to fork, and a session
  that exists is a `conflict`; an invoke into an unknown session creates it empty (§7.2, §7.4).
- A busy session: each invoke says what its message is (`whenBusy`: `queue` by default, `steer`, `reject`). A session
  holds at most 20 queued messages, and a process caps its messages in flight at 100 (§7.2, §7.3).
- An idempotency key is unique within its session and requires `sessionId`; the same key returns the same message,
  without comparing its text, except a message that ended `interrupted`, whose key accepts it again. The service never
  redoes work on its own; a caller that owes
  an answer decides to, so channels stay at-least-once (§7.2, §7.3).
- A steered message is taken by the work in progress at its next step and answered by that work's answer; one that
  arrives after the work has answered is taken next, ahead of the queue, and answered on its own. That is pi-durable's
  rule, and it gives every message one answer without the receipt waiting for the harness (§7.2).
- A message's `source` is set in process by channels, schedules and wake-ups; a remote caller cannot set it and is
  recorded as `api` (§7.2).
- A message's work outlives its caller: a caller that stops reading detaches. Messages are read, followed and
  canceled by id; the session's `abort` stops the work in progress, every queued message and a manual compaction
  (§7.3, §7.4).
- A session's history is read with `read` (state and a page, after or before a cursor) and followed with `follow`
  from a cursor; the serving layer builds both on the harness's ordered log, the same way for every harness (§7.4).
- `update` changes a session's name, model and thinking level, on the control plane, and creates nothing; moving the
  active branch is `rewind` (§7.4).
- Each message has one durable record, accepted and ended once, kept beside the conversation and committed with it;
  the log holds the conversation alone. An `interrupted` message's end is recorded once, when the session is first
  opened after its work stopped (§7.3, §9.3).
- A thread forks at the answer of the protocol message named by the nearest chat message of its reply chain: a
  message the channel posted for it, which it records, or a user's message, by its idempotency key. When nothing names
  one,
  including a post the agent made through a send tool, it forks at the chat's present; a post is never followed back
  to another session, whose other content would reach the thread's readers. A message without an answer forks the
  thread at its `user_message`, and a queued one at the present; a fork copies history, not messages (§7.4, §8.3).
- The operations are grouped by who uses them: the user plane (on by default) and the control plane (`/control`, off
  by default), which holds a session's name, model and thinking level, and its deletion (§7.7).
- Reading, following, aborting and rewinding sessions move from the opt-in `/control/*` into the user plane, on by
  default and unauthenticated like `POST /invoke` today; a deployment with a public URL puts a gateway in front or
  turns `http.api` off (§7.7).
- FastAgent authenticates nobody: exposing it belongs to an API gateway in front, and authentication inside FastAgent
  would plug in as middleware (§7.7).
- Naming: fields are camelCase; enum values and discriminators are snake_case; a field that refers to another object
  names its kind (§7.1).

The architecture and deployment:

- The protocol is written once above a harness port, so another harness can be added; the queue of a busy session
  lives behind the port, so a durable harness's queue is used, and a shared `LoopPort` serves harnesses that are only
  a loop, writing its message records into the one log it writes (the harness's own, pi's, or one it keeps for an ACP
  agent) through that log's one writer, which every operation on a session acquires (§9.1, §9.3).
- Steering is a harness capability; stopping work is a signal the port receives (§9.1).
- pi-durable is a second harness in step 4, behind the same port, which an agent opts into; pi-coding-agent stays the
  default, so `extensions/`, MCP and `chat` keep working. An agent that chooses pi-durable and declares `extensions/`
  or `mcp.json`, or runs on Bun, is refused at start. It implements `HarnessPort` directly, with `durableWork` and
  `durableQueue`, and no `rewind` or `delete`, which it lacks: emulating them would be a silent downgrade. Spikes on
  1.1.0 and 1.3.0 measured it against the port's admission, queue, steering, stop, read and restart operations
  (§9.1).
- DeepSeek Harness is reached through its ACP server first (step 5), with `LoopPort` recording its whole log; a
  native harness for it waits until a run against its npm `alpha` release shows that composing its plugin runtime is
  worth what ACP leaves out (§9.1).
- After work that failed or was canceled, queued messages are taken as usual. pi-durable leaves its queue waiting after
  a run that fails or is aborted, so its port places the queue with a write of its own to keep this rule (§9.1).
- `principal` is deferred until permissions are designed; a message records its `source` (§9.5).
- AgentCore is the main host, because an idle agent costs nothing there. A box is disposable by design: the program
  comes from the image and what lasts lives outside the box, so a deploy wiping the box is expected. Scaling out, a
  runtime session per conversation, is the serving goal (§10.2).
- State is declared apart from the content, and where it lives is the deployment's choice. On AgentCore it stays in
  the session storage until scaling out moves it to API storage; no EFS stopgap (§10.2).
- Evaluation comes later.
- The order: finish this design; rename engine to harness, in a refactor of its own; upgrade to pi 1.1.0; then
  declarations as files; then the serving protocol, with MCP, whose connections must outlive one turn (#678). The
  update loop and evaluation come later (§12).
- Removed or deferred after a first-principles review, because nothing needs them yet: a ledger of invocations; a
  structured `result`, with which `completed.data`, which no harness produces, goes too; the environment's secrets
  and content's needs; the host-identity credential, and commands to add or remove connectors.
- No field is reserved for a use nobody has designed.
