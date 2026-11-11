---
title: Configuration
description: "Configure a FastAgent agent: fastagent.config.ts, models and custom providers, content, the system prompt, the environment, auth and secrets, ports, state paths, tools, extensions, channels, and schedules."
status: current
---

# Configuration

- Agent behavior lives in its prompt files (`SYSTEM.md`, `AGENTS.md`), `skills/`, `prompts/` and its code under
  `src/`, all in the agent directory.
- What it works on, its content, and the commands it runs, its environment, are declared in `context.json`.
- The model, providers and serving choices live in `fastagent.config.ts` (constants and defaults), an instance's
  `fastagent.json`, CLI flags, and environment variables.
- Secrets live in `<agent dir>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Two configuration files

An agent's program has one configuration file, `fastagent.config.ts`; an instance of it may have another, `fastagent.json`. They answer different questions:

| | `fastagent.config.ts` | `fastagent.json` |
|---|---|---|
| Belongs to | The program: the agent's author | An instance: whoever runs this agent |
| Written by | The author, published with the agent | The person or machine running one instance |
| Holds | Constants (`providers`), the `settings` schema, and `defaults`: what an instance starts with | Overrides of `defaults` (`starters`, `model`, `thinkingLevel`, `http`, `channels`), values for `settings`, and what only an instance has: `name`, `description`, `content`, `instructions`, `skills`, `prompts` |
| Format | TypeScript: it can import, and `defineAgent` types it | JSON, with a `$schema` that checks its shape; no code |
| Read by | Every command: `dev` as source, `build` into `dist/` | `--config` (or `FASTAGENT_CONFIG`) names the file for every command, or `FASTAGENT_CONFIG_JSON` holds its JSON (what a deploy sets on a host; both variables together are refused, and `--config` beats the JSON); without it `dev` reads the one at the project root, and `start` and `deploy` read none. An app: the `config` it passes `openAgent` |
| In git | Committed | The development one is ignored by the scaffold's `.gitignore` (it is one person's); a deployment's is delivered by `deploy --config` |

Take one agent that runs for two customers: the author writes `settings: obj({ repo: str() })` in `fastagent.config.ts` once, and
each customer's instance writes `{ "settings": { "repo": "acme/api" } }` in its own `fastagent.json`. Same program, two
instances. Precedence is in [Model selection](#model-selection) and [Instance configuration](#instance-configuration).

## Config file

An agent is identified by one filename, `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  defaults: {
    model: "openai/gpt-5.5",
    http: { port: 8787 },
  },
});
```

`defineAgent` returns what it is given, typed. A scaffolded agent writes `export default { … } satisfies AgentConfig`
with a type-only import instead, so it opens before `npm install`. Every key is optional; an unknown key, nested ones
included, refuses the start. The constants say what the program is and an instance cannot change them; `defaults` is
what an instance starts with, which its own configuration may override ([instance configuration](#instance-configuration)).

| Key | Default | Meaning |
|---|---|---|
| `providers` | `[]` | Model providers beyond pi-ai's built-ins: a self-hosted endpoint, a gateway ([custom models](#custom-models)). A provider with a built-in's id replaces it. |
| `settings` | none | The values each instance may choose, as an object schema built with `@earendil-works/pi-schema` (`obj({ repo: str() })`). No secrets: those are `needs`. |
| `defaults.starters` | none | Example first messages for a client to offer, as `info().starters` reports them: at most 6 non-blank strings of at most 200 characters each. A client puts one in the composer as a draft; choosing one sends nothing. |
| `defaults.model` | none | Default model spec, `provider/modelId` ([model selection](#model-selection)). |
| `defaults.thinkingLevel` | the harness's | Reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `defaults.settings` | none | Values of `settings`, for the keys an instance need not give. |
| `defaults.http.port` | `8787` | Default port for `dev` / `start`. |
| `defaults.http.publicUrl` | none | The public base URL the platforms reach the instance at, any mount prefix included: an absolute `https://` URL without a trailing slash. Set, a serve points Telegram, Feishu and Lark there itself once it is ready, on every start; unset, it points none. `deploy fly` and `deploy railway` deliver their host's URL when the configuration names none. Never inferred from the environment. |
| `defaults.http.api` | `true` | Whether a serve answers the [Agent API](#the-agent-api-over-http) under `/v1` with a key: `dev`, `start` and every deployment, which `deploy` gives a key. `false` keeps them to their channels and schedules, whatever key their environment holds, a host's from an earlier deploy included. Not served on AgentCore either way. |
| `defaults.channels.<name>.ingress` | `dev`: `connection`; otherwise `webhook` | How a channel that offers both ways (`byIngress`) receives: `webhook` (inbound HTTP, what a host that scales to zero is woken by) or `connection` (a connection the process opens and keeps, such as Feishu's long connection, for one that stays up without a public URL). `<name>` is the channel file's name. |
| `defaults.channels.<name>.app` | none | `slack` and `lark` only: `{ id, team?, url? }`, the app this instance is bound to and the channel URL a person saved on its page and the platform verified. A serve reports that channel `registered` when `url` is the one it needs; `deploy --run --config` at a terminal writes it once the box confirms it, and `fastagent channels setup <name> --record-url` writes it afterwards. |
| `defaults.deploy.agentcore.idleTimeoutSeconds` | `180` | `deploy agentcore` only: how long an idle session keeps its microVM (60–1209600 s). Memory bills for the idle tail; a session past it cold-starts. Changing it changes the template, so a kept `agentcore.template.yaml` needs `--force`. Only the program sets it as a default; one deploy sets it with `--idle-timeout <seconds>`. An instance's `fastagent.json` has no `deploy`: the box never reads it. |

The program's name and description are its `package.json`'s (the directory's name when there is none), not keys here:
`info().agent.name` and `info().agent.description` report them, and always the program's. An instance's own
`description` in `fastagent.json` is `info().description`: it is the instance's introduction, with no fallback to the
program's, so a client shows whichever it means. Its `name` is the instance's own (`info().name`), which defaults to
the program's name made one path segment. `starters` are not identity but behavior, as `model` is: the program's
`defaults.starters`, over which the instance's own replace them, as `info().starters` reports.

A provider or extension that reads a secret is wrapped in [`needs`](#secrets-in-code), like any module.

Code reads the resolved settings through [`needs`](#secrets-in-code): its `build` takes them as a second argument,
checked against the schema and typed by what you annotate it with (`SettingsOf<typeof config>` from
`@fastagent-sh/fastagent`). A module with no secrets writes `needs([], (_, settings) => ...)`. It works for every
module `needs` wraps (tools, extensions, channels, schedules, providers), and is built once when the instance opens.
A command that only reads the shape of the definition (`models`, `login`) builds with the program's default settings.

### Instance configuration

An instance sets its own values over the defaults in a `fastagent.json`: `starters`, `model`, `thinkingLevel`, `http`,
`channels` and `settings` (the program's `settings`, partly: the defaults give the rest). Objects merge key by key and arrays
replace. `fastagent dev` reads the `fastagent.json` at the project root when there is one; `fastagent start` and
`fastagent deploy` read only the one `--config` names, and otherwise run on the defaults; an app gives `openAgent` a `config` object, or the absolute path of such a file. An
unknown key, a value of the wrong type and a required setting no one gave each refuse the open, naming the file and the
path (`fastagent.json: /http/port expected <= 65535`). Its `content` adds to the program's ([Content](#content)), and so do its `mcpServers`: MCP servers in the entry shape of
the program's `context.json` `mcpServers`, with a name both declare refusing the open ([MCP servers](mcp.md)).

`instructions`, `skills` and `prompts` add the instance's own text to the program's:

```json
{
  "instructions": ["./notes/house-rules.md"],
  "skills": ["./extra-skills"],
  "prompts": ["./extra-prompts"]
}
```

`instructions` names files that follow the program's `AGENTS.md` in the prompt; `skills` and `prompts` name directories
(`<dir>/<name>/SKILL.md`, `<dir>/<name>.md`). Paths are relative to the `fastagent.json` that names them (an object
`config` needs absolute ones), and only what is named is read: a skill elsewhere in the workspace is not a capability.
The files in them are read for every message, so an edit lands on the next one; a path added to the list takes a
restart. An instance only adds: a skill or prompt template named like the program's (or another of the instance's)
refuses the open, naming both files, and so does a path that is not a file or directory, or is the program's own
`AGENTS.md`, `skills/` or `prompts/`. In a development project the program is the project, so the instance's text lives
elsewhere (`./dev/skills`), and the build does not package it. A declared path that goes missing while the agent runs is
reported, not read as empty.

A program whose `settings` has a required key with no default starts and deploys only with a configuration that gives
it: `start --config <file>`, `deploy --config <file>`.

`fastagent build` writes the JSON Schema of this file, with the program's `settings` in it, as `fastagent.schema.json`
beside the package. Point an editor at it with `"$schema": "./node_modules/<package>/fastagent.schema.json"`.
`fastagent info --json` reports the resolved values, each with its source: the program's defaults, the instance's file,
a variable, or `--model` / `FASTAGENT_MODEL`.

### Environment variables and flags over the configuration

Every one of these values stays in the configuration. A variable or a flag is a layer over it, so a value that differs
per deployment is set where the deployment's environment is. The order is: the program's defaults, the instance's file,
the variable, the flag. `dev`, `start`, `invoke`, `schedules run` and `info` lay them over what they run or report;
an empty variable is unset, and a value the configuration would refuse refuses the start, naming the variable
(`FASTAGENT_THINKING_LEVEL: /thinkingLevel expected one of …`). `fastagent info --json` gives each value's source.

| Sets | Variable | Flag | Value |
|---|---|---|---|
| `model` | `FASTAGENT_MODEL` | `--model` | `provider/modelId` ([model selection](#model-selection)) |
| `thinkingLevel` | `FASTAGENT_THINKING_LEVEL` | `--thinking` | `off` … `max` |
| `http.port` | `PORT` (`start` only; `dev` ignores it) | `--port` | a port |
| `http.api` | `FASTAGENT_HTTP_API` | | `true` or `false` |
| `http.publicUrl` | `FASTAGENT_HTTP_PUBLIC_URL` | | an absolute `https://` URL |
| `channels.<name>.ingress` | `FASTAGENT_INGRESS` | `--ingress` | `channel=webhook\|connection`, comma-separated (`slack=webhook,feishu=connection`) |

A flag is entered into its variable at the command's start, as `--name` and `--root` are, so a flag beats the variable
and the source `info` reports names the variable.

`openAgent` reads none of them: an app passes its own `config`. `deploy` reads none of them either: it decides with the
program's defaults and the configuration `--config` delivers, so a deployment's non-secret values are written in that
file (which can be committed, one per environment), not set as variables. A variable the platform holds on the box
still outranks the delivered configuration.

## Model selection

Model specs are `provider/modelId`. List them with `fastagent models [search]`.

```txt
CLI --model > FASTAGENT_MODEL > the instance's fastagent.json model > fastagent.config.ts defaults.model
```

With none set, a serving command (`dev` / `start` / `invoke`) in a terminal shows the model catalog (providers with
credentials first; picking one that needs auth runs `login` inline), uses the pick for this run, and prints the line
to put in the config. Non-interactive runs fail with `missing model`.

The default is optional for an app embedding the agent (`openAgent`): without one the agent still opens, a session
created with its own model runs on it, and a message to a session with no model is refused `missing_model` until the
session is given one (`sessions.update`).

```bash
fastagent dev --model openai/gpt-5.5
fastagent build && FASTAGENT_MODEL=openai/gpt-5.5 fastagent start
```

`deploy` has no flag and reads no `FASTAGENT_MODEL`: a deployment's model is its configuration's `model` (the file
`--config` names), else the program's `defaults.model`, delivered in `FASTAGENT_CONFIG_JSON`. A `FASTAGENT_MODEL` in your
shell or in a file belongs to the machine it is on. A `FASTAGENT_MODEL` variable set on the platform still wins on the
box. `deploy` prints the effective model and its source.

### Model lists

The built-in providers are pi-ai's, and so are their models, as of the pi-ai release FastAgent ships with. A model a
provider releases after that is offered anyway: pi publishes every built-in provider's catalog at
[pi.dev](https://pi.dev/models), the newest one each pi-ai version can read, and when it is newer than pi-ai's own
data, each provider lists its models too. A [provider in code](#custom-models) that fetches its own list
(`fetchModels`) is asked for it, with its credential.

Every command that opens the agent (`dev`, `start`, `invoke`, `info`, `models`, a deployed start) refreshes the lists
before it reads them, asking the network for each at most every 4 hours once one is kept, a failed ask included; with
none kept, every open asks (`fastagent models --refresh` asks now). What it fetched is kept in `<state root>/models/`,
so a start without the network has the lists it last had. A refresh that fails is a warning, and each list stays the
one last kept; a default model only a fetched list has is then refused when no list kept has it, as on a deployed box's
first start without pi.dev (`deploy` warns of such a model).
`FASTAGENT_OFFLINE=1` (the CLI), or `offline: true` to `openAgent`, skips the network: each list is the one last kept, or pi-ai's own.

## Custom models

pi-ai's built-in providers are always available. A self-hosted model (vLLM, SGLang, Ollama, LM Studio) or a gateway
is a provider in code, made with pi-ai's `createProvider` and listed in `providers`:

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { defineAgent, needs } from "@fastagent-sh/fastagent";

const baseUrl = "http://vllm.internal:8000/v1";

export default defineAgent({
  defaults: { model: "mygw/deepseek-v3" },
  providers: [
    needs(["MYGW_API_KEY"], ({ MYGW_API_KEY }) =>
      createProvider({
        id: "mygw",
        name: "My gateway",
        baseUrl,
        auth: { apiKey: { name: "My gateway", resolve: async () => ({ auth: { apiKey: MYGW_API_KEY } }) } },
        models: [
          {
            id: "deepseek-v3", name: "DeepSeek V3", api: "openai-completions", provider: "mygw", baseUrl,
            reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536, maxTokens: 8192,
          },
        ],
        api: openAICompletionsApi(),
      }),
    ),
  ],
});
```

- The provider id joins the model id into a spec (`mygw/deepseek-v3`). `@earendil-works/pi-ai` is a dependency of
  the agent's `package.json` (`init` adds it).
- A key belongs in the environment, read through `needs`: the config ships in the image, so a key written into it
  ships too. `needs` makes the value required (the start refuses without it), and `deploy` checks that the target holds it, like
  any declared secret.
- A provider that resolves its own auth counts as authenticated: `info`, the startup report and `deploy`'s pre-flight
  report it so, and `login` is not needed for it.
- `fastagent models` lists its models beside the built-ins, and `fastagent info --model mygw/deepseek-v3` says whether
  a spec resolves.

## Content

An agent's directory is its own: its definition and its `.secrets/`; its local instances' working directories and state
are under its `.fastagent/`. What it works on, its content, is declared by name in two places, never inferred from where the directory
sits:

- **`context.json`** is part of the definition: committed and shared with everyone who has the agent, so it declares
  only what every instance reaches, a GitHub repository.
- **The instance's `fastagent.json`** adds to it: repositories and directories of this instance. It is the instance's,
  not the definition's, and is kept out of a deploy, so a directory of this machine never reaches another one.

```json
{
  "content": {
    "app": { "github": "acme/app", "description": "The product. Open pull requests against main." },
    "docs": { "github": "acme/docs", "ref": "main", "description": "The product docs. Cite them." }
  }
}
```

```json
{
  "content": {
    "app": { "path": "/Users/me/code/app" },
    "notes": { "path": "~/Documents/notes", "description": "My notes. Cite them." }
  }
}
```

Each entry is named by its key: one segment of letters, digits, `-` and `_`, unique ignoring case across both. An
instance only adds: a name `context.json` declares is not one `fastagent.json` may take, and the open refuses it,
naming both.

| Key | In | Meaning |
|---|---|---|
| `github` | both | A repository, `owner/repo`. Required in `context.json`: an entry every instance reaches is a repository |
| `ref` | both, with `github` | The branch, tag or full commit to clone. Defaults to the repository's default branch |
| `path` | `fastagent.json` | A directory of this machine: absolute, `~/`, or relative to the `fastagent.json` that names it |
| `description` | both | One sentence for the agent: what it is, and how to treat it. The prompt gives it beside the entry |

Where the agent reaches each one on this machine:

- **A repository** is a clone fastagent makes at `content/<name>` in the instance's working directory: shallow, at
  `ref`, the first time the agent starts (`dev`, `start`, `invoke`). At each later start it is brought up to date in
  place, by git's own rules: a `git fetch`, then a fast-forward of the branch it is on (or a checkout of the tag or
  commit it is pinned to). git refuses whatever would overwrite the agent's work: a changed file the update touches,
  an untracked file it would replace, commits the remote does not have. Then, and when the fetch fails, when the
  clone is on another branch than declared, or when it holds commits no branch or tag does, it is kept as it is and
  startup warns with the reason. Nothing is deleted: the agent's branches, stashes and the changes an update does
  not touch stay.

  `info` and `content list` report it without cloning. A first clone that fails stops the start,
  with git's reason. A clone of another repository under the entry's name (it was renamed or redeclared) stops
  the start and is named, never removed: move it away yourself. `content/` carries its own `.gitignore` (`*`) and
  holds only clones: a link there is refused.
- **A directory** is where `fastagent.json` says, used as it is: the agent edits it in place. One that is gone
  refuses the open, naming the entry, so the agent never runs without data it was meant to work on; `content remove`
  mends it. To work in your own checkout of a repository, add its directory under a name of its own.

git clones with its own configuration on this machine: a private repository needs the credentials your own
`git clone` uses (a credential helper, or `url.<base>.insteadOf` to reach GitHub over SSH). When git has none of its
own, it uses `GITHUB_TOKEN` from the environment, read each time git asks (the clone's config names a helper that
reads it, never the token itself), and so does the agent's own `git push` in the clone. git never prompts: a
missing credential fails the start instead of waiting.

`fastagent init <dir> --content <source>` and `fastagent content add/remove` edit both files
([CLI](cli.md#fastagent-content)); they can be edited by hand too. The entries' order means nothing. A directory may
contain the agent directory or sit inside it; keeping the agent beside the projects it works on keeps a project's files out of the definition's releases.

What each entry gives the agent:

- **A place in the prompt**: its name, its location, and its `description`. The agent runs a command in it with `cd <location> && …`.
What a project holds stays in the project. Its `AGENTS.md` and its skills are files the agent reads when it works
there, like any other file; none of them is added to the agent's prompt, whose instructions and skills come from the
agent directory alone. To have the agent read the project's `AGENTS.md` before it changes anything, say so in the
entry's `description`.

Content declarations are resolved once when an instance opens; there is no hot reload. Adding or removing entries,
changing a path, or changing a description takes effect after a restart (or redeployment with the changed definition).
Editing either file restarts `dev`; an embedding host closes and reopens the agent. Changes to files inside an
already-bound directory need no restart: the agent sees them when its tools next read the files.

A deployed host links its
`content/` to its storage, so each repository is a clone there, made and kept up to date the same way, and outlives
each release ([deploy](deploy.md#before-you-deploy)). The project's own `fastagent.json` is the development
instance's and stays here; a deployment's repositories come from `context.json` and the configuration `deploy --config`
delivers. A directory of this machine never reaches a host: `deploy` refuses one in the delivered configuration. To give
a host what the agent only reads there, copy it into the agent directory, which every release ships; to have the agent
work on it from a host, declare it as a repository.

## The system prompt

`SYSTEM.md` is the agent's whole system prompt, as written: who it is, what it is responsible for, and when it must
ask. Nothing is added to it or replaces it. It is read for every message, so an edit takes effect on the next one.

FastAgent adds its own sections after it:

| Section | From |
|---|---|
| Project context | The agent directory's `AGENTS.md`: how this agent is built and changed. A content entry's `AGENTS.md` is a file of that project, which the agent reads there |
| Skills | `skills/`: each skill's name, description and location ([Agent Skills](https://agentskills.io/specification)) |
| Content | Where the agent is and what it works on ([content](#content)) |
| Changing itself | On a deployed host: how long its storage lasts, and what takes effect when |

All of it comes from the agent directory. Nothing is read from the machine: no `~/.pi/agent` skill, prompt template
or system prompt, since a prompt from someone's machine would make the agent theirs. `fastagent add skill <source>`
vendors a skill into `skills/` (a git source, a local path, or a name from the machine's skill directories).

**Prompt templates can be fired by anyone talking to the agent.** A template (`prompts/<name>.md`) is invoked by a bare
`/<name>` in the message text, and on a channel that text comes from other people. A template whose name matches a
platform command (`prompts/start.md` against Telegram's `/start`) rewrites that message.

## Environment

An agent that declares no environment runs the commands of the machine it is on: `bash` finds whatever that `PATH`
holds, and a deployed image has Node and git. The `environment` of `context.json` declares the commands the agent
needs, installed on every machine that runs it and in its image:

```json
{
  "content": {},
  "environment": {
    "packages": { "gh": "2", "jq": "latest", "npm:@mermaid-js/mermaid-cli": "11" },
    "aptPackages": ["chromium", "fonts-noto-cjk"],
    "variables": {
      "GITHUB_TOKEN": { "description": "gh's token, with repo scope" },
      "PUPPETEER_EXECUTABLE_PATH": { "description": "the Chromium mermaid-cli draws with" }
    }
  }
}
```

- **`packages`** are CLIs and runtimes, each with a version: `"latest"`, a prefix (`"2"`) or an exact version. A
  package is a name from [mise](https://mise.jdx.dev)'s registry (`gh`, `ripgrep`, `python`), or one written with
  `aqua:` or `github:` (a project's release), `gitlab:`, `conda:` (a conda-forge build), `npm:` or `pypi:`.
- **`aptPackages`** are Debian packages the image installs, for what has no cross-platform build, like a browser or
  fonts. A start on Debian or Ubuntu names the ones this machine lacks, with the `apt-get` command that installs them;
  FastAgent never runs apt itself, and elsewhere it says nothing.
- **`variables`** are the environment variables the agent's commands read, declared by name with what each is for, as code
  declares the secrets it reads with `needs`. Their values come from the environment, never from `context.json`: `.secrets/.env` here,
  and, for a deployment, the file `--env-file` names (or the environment, with `--from-env`), from which `deploy` and
  `fastagent secrets push` set them on the deployment's target (only declared names are set; a variable the definition does
  not declare never reaches it). Every declared variable is required: `dev`, `start`, `invoke` and an app's `openAgent` refuse to
  start without its value and name `context.json`, `deploy` refuses before it changes anything and lists each
  with its description, and `info` and `fastagent env list` say which have a value here. A value you would share across
  stages, like an enterprise host, goes in each stage's value file; `.secrets/.env.example` is the committed template.
  Names the deployment sets itself (`PORT`, `FASTAGENT_MODEL`, the state and storage paths) cannot be declared.

Change it with [`fastagent env`](cli.md#fastagent-env): `fastagent env add gh@2` installs the package here, then
declares it. The first change adds mise to the agent's `package.json`, as one optional dependency per platform at the
newest version; the package manager installs only this machine's, and the lockfile pins it. mise publishes no package
for Windows, so an agent that declares packages does not run there.

**Nothing is locked.** A package is a release the agent uses, as a CLI you install on your own machine is: each place
installs the newest release its declared version allows when it first needs the package, and keeps it. `dev`,
`start`, `invoke` and an app's [`openAgent`](embedding.md) install the declared packages that have no install matching them here yet, and put them first on the `PATH` of the agent's commands (never on the process's, which may run other agents); one already
installed is kept, so a start needs no network. `fastagent env install` installs the newest release of each again.
A change to `context.json` restarts `dev`.

**What a command runs with.** A process the agent starts (the shell tool, a stdio MCP server, a skill's script) gets
`PATH`, `HOME`, `USER`, `SHELL`, the locale, `TZ`, `TMPDIR` and the proxy variables from the environment `dev`, `start` and
`invoke` run in, the declared packages' commands ahead on the `PATH`, the declared secrets (`needs`, and `variables`
above), an MCP server's own `env` for that server, and `GIT_CEILING_DIRECTORIES` at the working directory's parent, so
git run in the workspace does not find the repository around it. Nothing else of the shell's reaches it: an undeclared
key (`AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`) is not in the agent's commands, and a command that needs one declares
it. Cloning content and installing packages are FastAgent's own and run in the full environment. An embedding app that declares packages gives `env` a `PATH` (`baseEnv(process.env)` does), since the packages' commands go ahead of it. A package is installed into mise's data directory on this machine
(`~/.local/share/mise`), which other mise projects share.

The image installs every declared package when it is built, at the newest release then, in a layer cached while the
packages do not change; a deployed agent runs on those and installs nothing at start. So the image may run a
newer release than your machine, and a rollback installs the releases of the day it is built again, not those of the
image it replaces.

What a package may install from is checked by the backend it resolves to, since a registry name is a backend under
another name (`ripgrep` downloads ripgrep's GitHub release, `tokei` builds with cargo). `fastagent env add`,
`fastagent env list` and `deploy` ask mise and refuse a package that builds from source (`go`, `cargo`, `spm`),
compiles native extensions (`gem`), runs a plugin's code at install and on every start (`vfox`, `asdf`), or installs
from a backend FastAgent has not classified; the refusal names the backend and the way around it, the project's
release with `github:` or your own `Dockerfile`. FastAgent asks mise for prebuilt runtimes (python, ruby, node,
erlang): a runtime with no build for a platform fails there rather than compiling.

A PyPI package (`pypi:markitdown`, or a registry name such as `ansible`) runs on `python` and installs with `uv`. mise
takes both from the machine when they are not declared, so such a package installs on your machine and fails in the
image: declare them together, `fastagent env add python uv pypi:markitdown`. `fastagent env` names what is missing, and
`deploy --run` stops on it. An `npm:` package runs on the image's Node; Bun's image runs npm packages through its own
`node`. A runtime the agent works with itself (`go`, `rust`) is a package like any other; for `rust` the image adds
curl.

The agent's mise is given the packages as arguments and reads no configuration file: never `~/.config/mise`, a parent
directory's configuration, a `mise.toml` you keep beside `context.json` for your own work, `.tool-versions` or
`mise.local.toml`. That isolation is FastAgent's runs alone: a mise the agent runs (the machine's, in a content
repository with its own `mise.toml`) works as it does in your shell. `fastagent info` lists what is declared.

Harness settings (compaction, retries) are pi-durable's defaults. An embedder that needs others passes `settings`
to `openAgent`.

## Auth and secrets

| Source | Use case |
|---|---|
| `fastagent login` | Writes credentials to `<agent dir>/.secrets/auth.json` (override: `FASTAGENT_AUTH_PATH`). `-g`, or running outside any agent, writes `~/.fastagent/.secrets/auth.json`. |
| Provider env vars | Servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Dev `.env` | `<agent dir>/.secrets/.env`, loaded by local commands and `add <channel>`. Excluded from git by `.secrets/.gitignore`. |
| Production `.env` | `<agent dir>/.secrets/production/.env`, loaded by `start` and `add <channel> --env production`, never by `deploy`: a deployment has no default file (`--env-file`, or the environment it runs in); neither falls back to dev. |

For one provider, the agent uses the first of:

1. its own `auth.json`;
2. what the provider resolves itself: its env var, or a provider in code's own `auth`;
3. the global `~/.fastagent/.secrets/auth.json`.

That is the CLI's order. An app's `openAgent` reads the store `credentials` gives, else `auth.json` in the instance's state
directory, and the provider's variable from its `secrets` input, and nothing else ([Embedding](embedding.md#4-auth)).

The global file comes last because a deployment never has it: a global login that outranked a key in `.secrets/.env`
would run one credential locally and another deployed. A refresh is written back to the file the credential was read
from. Setting `FASTAGENT_AUTH_PATH` or `FASTAGENT_SECRETS_DIR` names the one file to use, so the global file is not
read at all.

Do not commit `.env` or credentials. `fastagent info` and `fastagent dev` print the resolved auth source.

`--env-file <file>` (on `dev`, `start`, `invoke`, `info` and `schedules run`) reads the agent's values from that file
instead of the default one for the command, and refuses a file that is not there. The values a command's instance
reads by name are those of its process environment after the file is loaded; an app that embeds an agent passes them
as `openAgent`'s `secrets` and nothing is read from `process.env` for it.

### Secrets in code

Code that reads a secret declares it, in the module that reads it:

```ts
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "@fastagent-sh/fastagent";

export default needs(
  ["WEATHER_API_KEY", { name: "WEATHER_UNITS", description: "metric or imperial", optional: true }],
  ({ WEATHER_API_KEY, WEATHER_UNITS }) =>
    defineTool({
      name: "weather",
      description: "Current weather for a city.",
      parameters: obj({ city: str() }),
      execute: async ({ city }) => ({ output: [{ type: "text", text: await lookup(city, WEATHER_API_KEY, WEATHER_UNITS) }] }),
    }),
);
```

`needs` hands the code exactly the values it declared, typed. A required one without a value refuses the start
(`dev`, `start`, an app's `openAgent`), naming the file that declared it; `deploy` refuses before its first
side effect. `info` lists every declaration (`--json`: `secrets`), and `deploy`'s runbooks are made from the same list.
The same works around a tool, an extension, a channel, a schedule or a provider.

## Ports

```txt
dev:   --port > fastagent.config.ts http.port > 8787
start: --port > PORT > fastagent.config.ts http.port > 8787
```

## Bind address

```txt
dev:   --bind > 127.0.0.1
start: --bind > all interfaces
```

`--bind` takes an IP literal or `localhost` (read as `127.0.0.1`). `--bind 0.0.0.0` opens a `dev` serve to the
LAN. `--tunnel` dials `localhost`, so it refuses a bind `localhost` does not reach (`--bind 192.168.1.5`,
`--bind 127.0.0.2`).

A serve answers its channels' routes, each of which verifies that a request comes from its platform, and
`GET /health`. Channels that dial out (WebSocket) are reachable by whoever can message the bot, whatever the bind.

## The Agent API over HTTP

With `FASTAGENT_API_KEY` set (in `.secrets/.env` for `dev`, on the target for a deployment), a serve also
answers the [Agent API](SPEC.md#9-http) under `/v1`, to a request that presents one of its keys as
`Authorization: Bearer <key>`; without it, `/v1` is not served, and the startup report says which. Several keys,
separated by commas, let a key be replaced without a gap: add the new one, move the Callers, remove the old. The key is
a credential for the whole instance ([security boundary](design/security-boundary.md)): keep it on a server, never in a
browser.

```bash
FASTAGENT_API_KEY=$(openssl rand -hex 32)
```

A program calls it with `connectAgent(url, { apiKey })` from `@fastagent-sh/fastagent/client`, and
`fastagent invoke --url <url> "hello"` checks it from a terminal. `deploy --run` at a terminal makes a key and sets it on the target when there is none (shown once, kept nowhere here),
unless `fastagent.config.ts` says `http: { api: false }`, which also keeps a serve from answering the API with a key its
environment still holds.

## Machinery: `.fastagent/`, `.secrets/` and `content/`

- `<agent dir>/.fastagent/<dev|start>/` — a local instance's root, which is its working directory (`dev` uses
  `.fastagent/dev/`, and `start`, `invoke` of a deployment's build and the other commands that run what `start` runs use
  `.fastagent/start/`, kept apart so a trial of the production build never reads or writes the development sessions and
  clones). `.fastagent/dev/` can be deleted at any time to start the development agent over; `.fastagent/start/` holds
  the sessions of a local `start`, so give a `start` you want to keep a place of its own with `--root`. `.fastagent/` is
  ignored by git and left out of every image.
- `<instance root>/.state/` — the instance's state: its storage (`agent.sqlite`: sessions, messages, entries), channel
  state (`channels/<name>/`, one per channel file) and schedule state (`schedule/`). One process holds it at a time; point it at a volume in
  a container.
- `<agent dir>/.secrets/` — the agent's `.env`, `auth.json`, and login `device.json` (stable OAuth device ID). The scaffolded `.secrets/.gitignore` keeps them
  out of git, and `deploy` keeps them out of the image. A deployed box receives the values through the host's
  secret store; its `auth.json` is its own login (`fastagent login --deployment`) and lives on the volume.
- `<working directory>/content/` — where this instance keeps the clones of
  `github` entries ([Content](#content)). They are data the agent works on, so they are not inside `.state/`; like
  it, they are never part of the definition, and `content/.gitignore` and `deploy` keep them out. It has no
  override: a place that wants it elsewhere links `content/` there.

### Where an instance lives

An instance's name is one path segment: `--name <name>` (`FASTAGENT_NAME`, `openAgent`'s `name`), over the `name` of its
`fastagent.json`, over the program's name made one (`@acme/reviewer` is `acme-reviewer`). The program's `defaults` do not
carry it. `info` and the report `dev` and `start` print say it, and `info().name` is it; a
name that is not a segment refuses.

An instance has a working directory, where the agent runs and `content/` clones land, and a state root. By default both
are in the project's `.fastagent/dev/` for `dev` and `.fastagent/start/` for `start`, as above. `--root <dir>` (`FASTAGENT_ROOT`) makes `<dir>` the working directory with the state
in `<dir>/.state`; `--state <dir>` (`FASTAGENT_STATE_DIR`) and `--workdir <dir>` (`FASTAGENT_WORKDIR`) place either apart
from it, a flag over its variable, and a variable over the default. The commands that open an instance or read its state
take them: `dev`, `start`, `invoke`, `info` and `schedules`. A relative path resolves once, against the directory the
command started in (in a generated image, its `WORKDIR`, `/app`), and a root or workdir that does not exist is created; one that cannot be (a file, a read-only parent) refuses. `--config <file>` (`FASTAGENT_CONFIG`) names
the [instance configuration](#instance-configuration) for `dev`, `start`, `invoke`, `info` and `schedules run`; `dev`
and the others read the `fastagent.json` at the project root without it, and `start` reads none.

What stays in the project for now: `.secrets/` (the `.env`, `auth.json`, MCP grants), whatever the root. They move into
the instance with the deploy layout in a later release.

Generated deployments run the definition where the image has it and make the persistent root the instance's root: the
agent's working directory, with `.state/`, `.secrets/` and `content/` in it, kept across releases. The root is `/data`
on Docker, Fly and Railway and `/mnt/data` on AgentCore (reset by every deploy — see
[Deploy](deploy.md#aws-bedrock-agentcore)).

For a manually configured service:

```bash
fastagent build   # `start` opens dist/
FASTAGENT_ROOT=/data FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

```txt
state root: FASTAGENT_STATE_DIR    > <root>/.state > <agent dir>/.fastagent/dev/.state (start: .fastagent/start/.state)
secrets:    FASTAGENT_SECRETS_DIR  > <agent dir>/.secrets (production: .secrets/production)
content:    <working directory>/content/<name> (a clone), or the directory fastagent.json names
workdir:    FASTAGENT_WORKDIR      > <root> > <agent dir>/.fastagent/dev (start: .fastagent/start)
storage:    <state root>/agent.sqlite
models:     <state root>/models/
auth:       FASTAGENT_AUTH_PATH    > <secrets>/auth.json
```

A leading `~` is expanded. `auth.json` is written `0600` on every write; `.env` and directories keep the
permissions you gave them. `FASTAGENT_SECRETS_DIR` set inside `.env` moves `auth.json` but not the `.env` itself.
`.env.example` always stays at `<agent dir>/.secrets/.env.example`.

## Code: `src/`

The definition's code is four directories, each module default-exporting one thing:

| Directory | Each module default-exports |
|---|---|
| `src/tools/` | A tool: pi-durable's `defineTool` ([tools](#tools)) |
| `src/extensions/` | An extension: pi-durable's `defineExtension` ([extensions](#extensions)) |
| `src/channels/` | A channel ([channels](#channels)) |
| `src/schedules/` | A schedule: `defineSchedule` ([schedules](#schedules)) |

Any of them may be `needs([...], (values) => …)` around what it exports. A module is a `.ts`, `.mts`, `.js` or `.mjs`
file directly in its directory; tests (`*.test.*`, `*.spec.*`) and `.d.ts` files are not modules, and a helper a module
imports lives outside these directories (`lib/`, say). Each command that opens the agent imports every module of
these directories: there is nothing to register by hand. A
module that does not load, or is not what its directory holds, refuses the start, naming the file; so do two modules
of one name.

## Tools

Every agent has pi-durable's coding tools: `read`, `write`, `edit` and `bash`. They are capabilities, not a security
policy; to isolate an agent, sandbox its whole process. Its own tools are the modules of `src/tools/`:

```ts
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";

export default defineTool({
  name: "reverse",
  description: "Reverse a text.",
  parameters: obj({ text: str() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [...text].reverse().join("") }] }),
});
```

`parameters` is a TypeBox schema: the harness validates a call's arguments against it before `execute`. A tool of the
definition's own with a coding tool's name replaces it. Every serve also gives the agent `wake` and `unwake`
([self-scheduling](api-reference.md#self-scheduling)). [MCP servers](mcp.md) are declared under `mcpServers` in `context.json` (the program's) and `fastagent.json` (an
instance's), not in a tool. `fastagent info` lists authored tools and declared MCP servers; MCP tool discovery occurs when the agent opens.

A tool that needs to know which session it runs in asks `await sessionIdOf(api, context)` (from
`@fastagent-sh/fastagent`): the id the Agent hands out, the one a channel's map records.

## Extensions

An extension is pi-durable's named bundle of tools, prompt sections and hooks. The agent's own are the modules of
`src/extensions/`, default-exporting `defineExtension({ name, … })`. A third-party one is a module there too, one line
that re-exports it (`export { default } from "some-extension-package"`, or `export default createX({ … })` for a
factory), installed as an ordinary dependency of the agent's `package.json`; `fastagent.config.ts` has no `extensions`
key. Its name may not be one FastAgent installs (the coding tools', the definition's, `wake`'s). An extension's code is the definition's code: a change takes effect at the next
start.

### More than one agent

Each agent is a directory of its own, with its own config, prompt, skills, code, `.state/` and `.secrets/`. Several
agents can work on one project: each declares it as content.

```bash
fastagent init ~/agents/reviewer --content ~/code/app
fastagent init ~/agents/releaser --content ~/code/app
fastagent dev ~/agents/reviewer
```

## Channels

A module of `src/channels/` enables a channel, named by its file; move it out, or rename it to `<name>.ts.disabled`,
to disable it. Channels are not configured in `fastagent.config.ts`. See [Channels](channels.md).

## Schedules

A schedule is a prompt the agent runs on a cron: a module of `src/schedules/`, named by its file.

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  tz: "America/New_York",
  prompt: "Generate today's digest and send it with slack_send to channel C0123456789.",
});
```

- **`cron`** has 5 fields, and `?` means `*` (so `0 9 ? * MON` fires on Mondays); **`tz`** is an IANA timezone,
  default UTC. **`prompt`** is a text, or a function of the
  instant it fires for (`({ at }) => …`), which may read secrets through `needs`.
- **Checked when the definition is built**: no two instants of a schedule may be under 10 minutes apart, which also
  refuses the six-field per-second form; at most 20 schedules.
- **A cron AgentCore can run, on every host.** AgentCore's clock is EventBridge, which cannot express a few cron
  forms: both day fields restricted at once (`0 9 15 * WED`, "the 15th or any Wednesday"), `L` and `#` day forms,
  and nicknames such as `@daily`. Such a schedule is refused everywhere, so one that runs locally also runs there.
  Two differences remain, at a DST change. A time inside the local hour the spring change skips (02:30 in most of the
  US) is skipped on AgentCore and run elsewhere at the first valid time after the gap (03:00). A schedule with several
  times (`*/15`) runs both passes of the hour the autumn change repeats elsewhere; on AgentCore it runs once, going by
  EventBridge's documentation ("runs only once" when the clock goes back), which has not been tried on a live schedule.
  A single time in that hour runs once on both.
- **One session per schedule.** Every fire continues the schedule's own session, created the first time it fires, so
  the agent sees what its earlier runs did, and nothing of users' chats.
- **It delivers nothing.** The agent's tools send output; name the target (a chat or channel id) in the prompt.
  What the agent said is in the schedule's session.
- **Each instant fires at most once**: a claim under `<stateRoot>/schedule/claims/<name>/` is taken before the message
  is sent. After downtime one overdue run is caught up, not one per missed instant; a schedule that has never fired
  starts at its next instant. A run still going when the next instant arrives makes that one `skipped`.
- **Where the clock is.** `dev` and `start` run it while they serve. On AgentCore the container mirrors each schedule
  into a recurring EventBridge schedule, which fires it on EventBridge's own clock and wakes the container, once an
  envelope has reached it through the forwarder after a deploy (`deploy --run` probes it). A schedule keeps one Fly or
  Railway machine running.
- **It is code**: a change takes effect at the next start or release. To fire one now, as its clock would,
  `fastagent schedules run <name>`.

`fastagent schedules list` shows each schedule's next instant, how its last run ended and its session, and the
agent's own pending wake-ups. A wake-up is work the agent schedules for itself with the `wake` tool, on every serve
([API reference](api-reference.md#self-scheduling)).

## Logging

`FASTAGENT_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) overrides the default: `debug` for `dev`, `info` for
`start`. Per-turn traces log at `debug`, so `start` keeps end-user content out of logs unless you opt in.

```bash
fastagent build && FASTAGENT_LOG_LEVEL=debug fastagent start
```

It is read per log line, so set it in `.secrets/.env` for dev or `.secrets/production/.env` for deployment.
A real environment variable wins over the file.

## Not config

The instance's storage is not configured: a serve, and an app's `openAgent`, keep the agent's sessions in
`<state root>/agent.sqlite` (an app's `stateDir` is its state root).
