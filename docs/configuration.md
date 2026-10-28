---
title: Configuration
description: "Configure a FastAgent agent: fastagent.config.ts, models and custom providers, content, the system prompt, the environment, auth and secrets, ports, state paths, tools, extensions, channels, and schedules."
status: current
---

# Configuration

- Agent behavior lives in its prompt files (`SYSTEM.md`, `AGENTS.md`), `skills/`, `prompts/` and its code under
  `src/`, all in the agent directory.
- What it works on and knows, its content, and the commands it runs, its environment, are declared in `context.json`.
- The model, providers and serving choices live in `fastagent.config.ts`, CLI flags, and environment variables.
- Secrets live in `<agent dir>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Config file

An agent is identified by one filename, `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
});
```

`defineAgent` returns what it is given, typed. A scaffolded agent writes `export default { … } satisfies AgentConfig`
with a type-only import instead, so it opens before `npm install`. Every key is optional; an unknown key, nested ones
included, refuses the start.

| Key | Default | Meaning |
|---|---|---|
| `name` | `package.json`'s name | The agent's name, as `info()` reports it. |
| `description` | none | One line about the agent, as `info()` reports it. |
| `model` | none | Default model spec, `provider/modelId` ([model selection](#model-selection)). |
| `thinkingLevel` | the harness's | Reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `providers` | `[]` | Model providers beyond pi-ai's built-ins: a self-hosted endpoint, a gateway ([custom models](#custom-models)). A provider with a built-in's id replaces it. |
| `extensions` | `[]` | Third-party pi-durable extensions, installed after `src/extensions/` ([extensions](#extensions)). |
| `http.port` | `8787` | Default port for `dev` / `start`. |
| `deploy.agentcore.idleTimeoutSeconds` | `180` | `deploy agentcore` only: how long an idle session keeps its microVM (60–1209600 s). Memory bills for the idle tail; a session past it cold-starts. Changing it changes the template, so a kept `agentcore.template.yaml` needs `--force`. |

A provider or extension that reads a secret is wrapped in [`needs`](#secrets-in-code), like any module.

## Model selection

Model specs are `provider/modelId`. List them with `fastagent models [search]`.

```txt
CLI --model > FASTAGENT_MODEL > fastagent.config.ts model
```

With none set, a serving command (`dev` / `start` / `invoke`) in a terminal shows the model catalog (providers with
credentials first; picking one that needs auth runs `login` inline), uses the pick for this run, and prints the line
to put in the config. Non-interactive runs fail with `missing model`.

The default is optional for an app embedding the agent (`openAgent`): without one the agent still opens, a session
created with its own model runs on it, and a message to a session with no model is refused `missing_model` until the
session is given one (`sessions.update`).

```bash
fastagent dev --model openai-codex/gpt-5.5
FASTAGENT_MODEL=openai-codex/gpt-5.5 fastagent start
```

`deploy` evaluates the same chain in production: `FASTAGENT_MODEL` from `.secrets/production/.env`, else
`config.model`. Your shell is not read, and `deploy` has no `--model` flag. The production value is recorded in the
release manifest (`fastagent.release.json`); a variable already set on the platform wins over it. `deploy` prints the
effective model and its source.

## Custom models

pi-ai's built-in providers are always available. A self-hosted model (vLLM, SGLang, Ollama, LM Studio) or a gateway
is a provider in code, made with pi-ai's `createProvider` and listed in `providers`:

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { defineAgent, needs } from "@fastagent-sh/fastagent";

const baseUrl = "http://vllm.internal:8000/v1";

export default defineAgent({
  model: "mygw/deepseek-v3",
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
  ships too. `needs` makes the value required (the start refuses without it) and carries it to a deployment like any
  declared secret.
- A provider that resolves its own auth counts as authenticated: `info`, the startup report and `deploy`'s pre-flight
  report it so, and `login` is not needed for it.
- `fastagent models` lists its models beside the built-ins, and `fastagent info --model mygw/deepseek-v3` says whether
  a spec resolves.

## Content

An agent's directory is its own: its definition, its working directory, and its local instance's `.state/` and
`.secrets/`. What it works on and knows, its content, is declared beside the config, never inferred from where the
directory sits, in two files:

- **`context.json`** is part of the definition: committed and shared with everyone who has the agent, so it declares
  only what every instance reaches, a GitHub repository.
- **`context.local.json`** is this machine's: the directories of it the agent is bound to. `init` ignores it in git
  and `deploy` keeps it out of the image, so it never reaches another machine.

```json
{
  "content": {
    "app": { "github": "acme/app", "description": "The product. Open pull requests against main." },
    "docs": { "github": "acme/docs", "ref": "main", "readonly": true }
  }
}
```

```json
{
  "content": {
    "app": { "path": "/Users/me/code/app" },
    "notes": { "path": "~/Documents/notes", "readonly": true, "description": "My notes. Cite them." }
  }
}
```

Each entry is named by its key: one segment of letters, digits, `-` and `_`, unique ignoring case across both files.

| Key | In | Meaning |
|---|---|---|
| `github` | `context.json` | A repository, `owner/repo`. Required: an entry every instance reaches is a repository |
| `ref` | `context.json` | The branch, tag or full commit to clone. Defaults to the repository's default branch |
| `path` | `context.local.json` | A directory of this machine: absolute, `~/`, or relative to the agent directory |
| `readonly` | both | The agent knows it and does not write it. An instruction to the agent, not a permission |
| `description` | both | One sentence for the agent: what it is, and how to treat it. The prompt gives it beside the entry |

Where the agent reaches each one on this machine:

- **A repository** is a clone fastagent makes at `content/<name>` in the agent directory: shallow, at `ref`, the
  first time the agent starts (`dev`, `start`, `invoke`). At each later start it is brought up to date in
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
- **A repository this machine has a checkout of** is that checkout, when `context.local.json` binds it under the
  entry's name with only `path` (`fastagent content add <checkout>` writes both files). It is used as it is: never
  fetched, never switched to `ref`, and startup and `info` say when it is not at `ref`. A binding to anything but the
  root of a checkout of that repository is refused; one to a directory that is gone is said, and the clone is used.
- **A directory only this machine has** is where its binding says. One that is gone is left out with a warning, and
  the agent is not told of it.

git clones with its own configuration on this machine: a private repository needs the credentials your own
`git clone` uses (a credential helper, or `url.<base>.insteadOf` to reach GitHub over SSH). When git has none of its
own, it uses `GITHUB_TOKEN` from the environment, read each time git asks (the clone's config names a helper that
reads it, never the token itself), and so does the agent's own `git push` in the clone. git never prompts: a
missing credential fails the start instead of waiting.

`fastagent init <dir> --content <source>` and `fastagent content add/remove` edit both files
([CLI](cli.md#fastagent-content)); they can be edited by hand too. The entries' order means nothing. A bound
directory may not contain the agent directory, nor sit inside it: an agent lives beside the projects it works on,
never in one.

What each entry gives the agent:

- **A place in the prompt**: its name, its location, whether the agent works on it or only knows it, and its
  `description`. The agent runs a command in it with `cd <location> && …`.
What a project holds stays in the project. Its `AGENTS.md` and its skills are files the agent reads when it works
there, like any other file; none of them is added to the agent's prompt, whose instructions and skills come from the
agent directory alone. To have the agent read the project's `AGENTS.md` before it changes anything, say so in the
entry's `description`.

The locations are resolved when a process starts; editing either file restarts `dev`. A deployed host links its
`content/` to its storage, so each repository is a clone there, made and kept up to date the same way, and outlives
each release ([deploy](deploy.md#before-you-deploy)). A directory only this machine binds stays here: the deployed
agent works without it, and `deploy` says so by name. To give a host what the agent only reads there, copy it into
the agent directory, which every release ships; to have the agent work on it from a host, move it to a repository
and add it as `github:owner/repo`.

## The system prompt

`SYSTEM.md` is the agent's whole system prompt, as written: who it is, what it is responsible for, and when it must
ask. Nothing is added to it or replaces it. It is read for every message, so an edit takes effect on the next one.

FastAgent adds its own sections after it:

| Section | From |
|---|---|
| Project context | The agent directory's `AGENTS.md`: how this agent is built and changed. A content entry's `AGENTS.md` is a file of that project, which the agent reads there |
| Skills | `skills/`: each skill's name, description and location ([Agent Skills](https://agentskills.io/specification)) |
| Content | Where the agent is and what it works on and knows ([content](#content)) |
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
  and `.secrets/production/.env` for a deployment, the one file `deploy` reads and carries (a variable exported where
  you run `deploy` does not reach the deployment). A process you start yourself also reads the variables it is started
  with. Every declared variable is required: `dev`, `start`, `invoke` and an app's `openAgent` refuse to
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
`start`, `invoke` and an app's [`openAgent`](embedding.md) install the declared packages that have no install matching them here yet, and put them first on the agent's `PATH`; one already
installed is kept, so a start needs no network. `fastagent env install` installs the newest release of each again.
A change to `context.json` restarts `dev`. A package is installed into mise's data directory on this machine
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
| Production `.env` | `<agent dir>/.secrets/production/.env`, loaded by `start`, `deploy` and `add <channel> --env production`. `deploy` carries it whole, never falling back to dev. |

For one provider, the agent uses the first of:

1. its own `auth.json`;
2. what the provider resolves itself: its env var, or a provider in code's own `auth`;
3. the global `~/.fastagent/.secrets/auth.json`.

The global file comes last because a deployment never has it: a global login that outranked a key in `.secrets/.env`
would run one credential locally and another deployed. A refresh is written back to the file the credential was read
from. Setting `FASTAGENT_AUTH_PATH` or `FASTAGENT_SECRETS_DIR` names the one file to use, so the global file is not
read at all.

Do not commit `.env` or credentials. `fastagent info` and `fastagent dev` print the resolved auth source.

### Secrets in code

Code that reads a secret declares it, in the module that reads it:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "@fastagent-sh/fastagent";

export default needs(
  ["WEATHER_API_KEY", { name: "WEATHER_UNITS", description: "metric or imperial", optional: true }],
  ({ WEATHER_API_KEY, WEATHER_UNITS }) =>
    defineTool({
      name: "weather",
      description: "Current weather for a city.",
      parameters: Type.Object({ city: Type.String() }),
      execute: async ({ city }) => ({ output: [{ type: "text", text: await lookup(city, WEATHER_API_KEY, WEATHER_UNITS) }] }),
    }),
);
```

`needs` hands the code exactly the values it declared, typed. A required one without a value refuses the start
(`dev`, `start`, an app's `openAgent`), naming the file that declared it; `deploy` refuses before its first
side effect. Every declaration is written into `.fastagent/secrets.json`, which `info`, `deploy` and runbooks read.
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

A serve answers only its channels' routes, each of which verifies that a request comes from its platform, and
`GET /health`. There is no HTTP API to protect ([security boundary](design/security-boundary.md)). Channels that dial
out (WebSocket) are reachable by whoever can message the bot, whatever the bind.

## Machinery: `.state/`, `.secrets/` and `content/`

- `<agent dir>/.state/` — the instance's state: its storage (`agent.sqlite`: sessions, messages, entries), channel
  state (`channels/<name>/`, one per channel file) and schedule state (`schedule/`). One process holds it at a time; point it at a volume in
  a container.
- `<agent dir>/.secrets/` — the agent's `.env`, `auth.json`, and login `device.json` (stable OAuth device ID). The scaffolded `.secrets/.gitignore` keeps them
  out of git, and `deploy` keeps them out of the image. A deployed box receives the values through the host's
  secret store; its `auth.json` is its own login (`fastagent login --deployment`) and lives on the volume.
- `<agent dir>/content/` — where this machine keeps the agent's content: links to its directories, and the clones of
  `github` entries ([Content](#content)). They are data the agent works on, so they are not inside `.state/`; like
  it, they are never part of the definition, and `content/.gitignore` and `deploy` keep them out. It has no
  override: a place that wants it elsewhere links `content/` there.

Generated deployments keep the deployed definition at `<persistent-root>/definition/`, replaced by every release,
with `.state/`, `.secrets/` and `content/` beside it; each release links its own `content/` to that one.
The root is `/data` on Docker, Fly and Railway and `/mnt/data` on AgentCore (reset by every deploy — see
[Deploy](deploy.md#aws-bedrock-agentcore)).

For a manually configured service:

```bash
ln -sfn /data/content content   # in the agent directory, before every start: a redeploy replaces the directory
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

```txt
state root: FASTAGENT_STATE_DIR    > <agent dir>/.state (production: .state/production)
secrets:    FASTAGENT_SECRETS_DIR  > <agent dir>/.secrets (production: .secrets/production)
content:    <agent dir>/content/<name> (a clone), or the directory context.local.json binds
storage:    <state root>/agent.sqlite
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
imports lives outside these directories (`lib/`, say). Each command that opens the agent generates
`.fastagent/registry.ts`, plain imports of every module, from these files: there is nothing to register by hand. A
module that does not load, or is not what its directory holds, refuses the start, naming the file; so do two modules
of one name.

## Tools

Every agent has pi-durable's coding tools: `read`, `write`, `edit` and `bash`. They are capabilities, not a security
policy; to isolate an agent, sandbox its whole process. Its own tools are the modules of `src/tools/`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export default defineTool({
  name: "reverse",
  description: "Reverse a text.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [...text].reverse().join("") }] }),
});
```

`parameters` is a TypeBox schema: the harness validates a call's arguments against it before `execute`. A tool of the
definition's own with a coding tool's name replaces it. Every serve also gives the agent `wake` and `unwake`
([self-scheduling](api-reference.md#self-scheduling)). MCP servers are not supported yet
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). `fastagent info` lists each tool with its file.

A tool that needs to know which session it runs in asks `await sessionIdOf(api, context)` (from
`@fastagent-sh/fastagent`): the id the Agent hands out, the one a channel's map records.

## Extensions

An extension is pi-durable's named bundle of tools, prompt sections and hooks. The agent's own are the modules of
`src/extensions/`, default-exporting `defineExtension({ name, … })`; a third-party one is listed in
`defineAgent({ extensions: [...] })`, after the agent's own. Its name may not be one FastAgent installs (the coding
tools', the definition's, `wake`'s). An extension's code is the definition's code: a change takes effect at the next
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

- **`cron`** has 5 fields; **`tz`** is an IANA timezone, default UTC. **`prompt`** is a text, or a function of the
  instant it fires for (`({ at }) => …`), which may read secrets through `needs`.
- **Checked when the definition is built**: no two instants of a schedule may be under 10 minutes apart, which also
  refuses the six-field per-second form; at most 20 schedules.
- **A cron AgentCore can run, on every host.** AgentCore's clock is EventBridge, which cannot express a few cron
  forms: both day fields restricted at once (`0 9 15 * WED`, "the 15th or any Wednesday"), `L` and `#` day forms,
  and nicknames such as `@daily`. Such a schedule is refused everywhere, so one that runs locally also runs there.
  One difference remains: on the day a DST change skips a local hour, a time inside it (02:30 in most of the US) is
  skipped on AgentCore and run an hour later elsewhere.
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
FASTAGENT_LOG_LEVEL=debug fastagent start
```

It is read per log line, so set it in `.secrets/.env` for dev or `.secrets/production/.env` for deployment.
A real environment variable wins over the file.

## Not config

The instance's storage is not configured: a serve, and an app's `openAgent`, keep the agent's sessions in
`<state root>/agent.sqlite`.
