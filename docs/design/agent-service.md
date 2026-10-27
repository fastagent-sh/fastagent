---
title: Agent service
description: "FastAgent for teams that build, run and use a set of agents together as cloud services: who it is for, the product loop, what an agent works with (content, connectors and environment), the declared environment, connectors, and credentials."
type: design-doc
status: partly implemented
---

# Agent service

**Status: partly implemented.** The environment (§4) and credentials (§6) are; connectors (§5) are proposed, with MCP
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). How an agent is served, the API it is served through,
and where it runs are [architecture.md](architecture.md)'s and the [Agent API](../SPEC.md)'s.

Three things are hard in serving an agent, and this design spends itself on them:

1. **Work that outlives its caller.** Work arrives from many entry points, has side effects, and keeps running when
   its caller goes away; the caller comes back to it by its message's id. Surviving a restart as well needs a harness
   that checkpoints its work: pi-durable ([architecture.md](architecture.md) §2).
2. **Disposable boxes.** A deploy wipes a box, and scaling out adds boxes and removes them. So the program comes from
   the image, what has to last lives outside the box, and each conversation reaches the box that holds it
   ([architecture.md](architecture.md) §4.3).
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
  is context packages' ([architecture.md](architecture.md) §4.2);
- the model and the agent loop, which a harness provides: pi-durable ([architecture.md](architecture.md) §2);
- a hosting platform of its own: agents deploy to existing hosts ([architecture.md](architecture.md) §4.3);
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
  harness        the loop that runs it: pi-durable
  context        everything it works with from outside, in three kinds:
    content        data it reads and writes as files, synced to where it runs: repositories, directories
    connectors     the other systems it reaches: MCP servers, APIs and their credentials (mcp.json)
    environment    what it runs in: the commands and runtimes it needs, on every platform (context.json)
  definition     its own directory: who it is and how it works, and which model and contexts it uses
  remembers in   sessions: conversations
  started by     triggers: requests, messages, events, time, itself
```

The formula is the [agent model](agent-model.md)'s. Each of the three is supplied by someone else: the model by a
model provider, the harness by pi-durable, and the context, which is the agent's content, connectors and environment, by the
repositories, clouds and MCP servers it works with. FastAgent defines the agent and composes the three, in its
definition, and serves the result. Declaring the context apart from the definition is what lets a box be wiped and
rebuilt from the declarations, and what lets a team share it across its agents, a context package at a time
([architecture.md](architecture.md) §4.2).

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
   caller's back, and its authority is scoped per agent. Merging connectors into content would govern a
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
| Skill | Know-how stored in the definition, executed in the environment, possibly calling connectors |
| Tool | How an action is presented to the model. `read`, `write` and `bash` act on the environment and content. A code tool is part of the definition, and the system it reaches is a connector; an MCP tool is a connector's |

### 3.4 The agent's own directory

An agent's own directory is its definition: who it is and how it works. It stays writable on a host as on a laptop; how
what the agent changes there is kept is designed later (§2).

### 3.5 Sessions and triggers

A **session** is a conversation's continuity: the messages of one session share its history. The Agent names it, and
it may start as a fork of another session ([Agent API](../SPEC.md) §5). A session is the agent's working memory of a
conversation: what should outlast it belongs in content, and a chat place's own history is the platform's
([place-history.md](place-history.md)).

A session's history is a list of entries in the instance's storage: the messages (the asks, the answers with their
usage, the tool calls and results), compactions, and FastAgent's own entries, which the model never sees. A fork shares
the entries it inherited. The live events (`message_delta`, `tool_*`) are not stored: a Caller that reconnects resumes
after its last entry (`resume`, [Agent API](../SPEC.md) §5.1). What the service prints is its own log, kept by the
host.

A **trigger** is where an invoke comes from: a request (HTTP, another agent), a message (a channel), an event (a
webhook), time (a schedule), or the agent itself (`wake`, a subagent). A channel is a trigger and a connector of one
system: messages arrive through it, and the agent's send tool posts through it.

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
  the agent (`dev`, `start`, `invoke`, an embedder's `openServing`) installs what is missing and puts the packages
  first on the `PATH` their commands inherit. A change to `context.json` restarts `dev`.
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
- A skill script's Python libraries are not part of the environment: the script declares them inline (PEP 723) and
  runs with `uv run`, so a skill carries its own dependencies wherever it goes.
- `deploy.apt` is gone, and the config has no `environment`.
- **`variables` declares the environment variables the agent's commands read, by name; values come from the
  environment.** A declaration is a name and a sentence saying what it is for
  (`"GITHUB_TOKEN": { "description": "gh's token, with repo scope" }`), as `needs([...])` declares the secrets a module's
  code reads: convention over configuration. The sentence sits in an object, because a string beside a variable's name is
  read as its value in every format an author knows (`.env`, Heroku's `app.json`, Compose), and a string is refused with
  where its value goes. The value comes from the stage's value file (`.secrets/.env` for dev, `.secrets/production/.env`
  for production, which `deploy` reads and carries) or, for a process started by hand, the variables it is started with,
  the same way a tool's secret does; a stage is one of the two environments the [channel
  environments](channel-environments.md) define. Nothing in `context.json` holds a value, so no value can be committed
  with it, and nothing needs rules for which of two values wins.
  - Every declared variable is required, as a module's secret is: a serving path refuses to start without its value and
    names `context.json`, `deploy` refuses before its first side effect and lists it with its sentence, and `info` and
    `fastagent env list` say which are set. `env exec` runs one command, and is not gated by the agent's declarations.
  - A name the deployment sets itself (`PORT`, `FASTAGENT_MODEL`, the state and storage paths) is refused: the value
    file's copy never travels, so its declaration could never be satisfied.
  - A shared default that is not a secret (an enterprise host) goes in each stage's value file too; `.env.example` is
    the committed template for them. Defaults written in `context.json` were considered and left out: they make a
    committed file the place a secret can land, and need an order for which value wins.
- How an agent changes its own environment, on a laptop or on a host, is designed with how an agent is developed
  ([#605](https://github.com/fastagent-sh/fastagent/issues/605), later): for an author and for the agent itself, it is
  the same work on the same files.

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

Today a connector is a code tool in `src/tools/` or a channel's send tool. MCP is not served yet
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). Proposed:

- **A service that speaks MCP** is declared in `mcp.json` at the agent's root, in pi's format, which Claude Code,
  Cursor and VS Code share (`mcpServers`: a `command` or a `url`, `headers` or `env` that name values as `${VAR}`, and
  a `description` the agent reads). `.pi/mcp.json` is read too, below it, as for every file pi and FastAgent both
  have a place for. Pi brings OAuth sign-in (`mcp login`) and per-server exposure with it.
- **A service without MCP** needs no new kind of file. Each way to reach it already has its declaration:

  | The service offers | Reach it with | Declared in | Its credential |
  |---|---|---|---|
  | A CLI (`gh`, `aws`, `stripe`) | The CLI in the environment, and a skill that teaches it | `context.json` (`environment`), `skills/` | The variable the CLI reads |
  | An API this agent calls | Code tools, one per operation, beside the client they share | `src/tools/` (pi-durable's `defineTool`) | `needs([...])` around the tool |
  | An API several agents or harnesses reuse | An MCP server of one's own, run locally (stdio) or hosted | `mcp.json` | `${VAR}` in `env` or `headers` |
  | An OpenAPI or Smithy description, or a Lambda function, on AWS | AgentCore Gateway, which turns it into an MCP server and handles the outbound authorization | `mcp.json` (`url`) | The Gateway's own |
  | A REST call or two | A skill with a script (`curl`, Python) | `skills/` | The variable the script reads |

- A context package carries the declared ones, the environment a CLI needs and MCP servers, so a team declares a
  service once and its agents use it ([architecture.md](architecture.md) §4.2).
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

A credential that code or configuration uses is declared next to it: `needs([...])` around the module whose code reads
it. The commands the agent runs read the process environment; what they read is declared, by name, in
the `variables` of the agent's environment (§4), every one of them required.

| Used by | Declared as | Today |
|---|---|---|
| The model's provider | `model`, then its provider's env key or a `login` grant | Exists |
| A code tool, an extension, a provider | `needs([...])` around it | Exists |
| A channel | `needs([...])` around its module | Exists |
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
| A grant to an MCP server | OAuth to an MCP server | Decided with MCP (#678) | — | Open: a container's home is not on the storage a deploy keeps | — |

- Values keep env-var names because every SDK and CLI reads them (`GITHUB_TOKEN`, `OPENAI_API_KEY`). Two
  declarations of one name share one value; two parts that need different values declare different names
  (`ACME_GITHUB_TOKEN`).
- Grants exist today for model providers, including the machine-wide store `login -g` writes. Where an MCP server's
  grant lives for a deployed agent is decided with MCP (#678).

### 6.3 On whose authority

Every credential today carries the agent's own authority: a bot, a service account, a team token. Acting as the member
who asked (their calendar, their mailbox) needs a consent flow started from a channel and grants stored per
principal. It needs a structured principal and permissions, which an instance, one trust domain, does not have
([Agent API](../SPEC.md) §8).

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
