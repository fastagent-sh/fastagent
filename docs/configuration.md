---
title: Configuration
description: "Configure a FastAgent agent: model selection, auth, ports, sessions, tools, channels, state paths, and deploy options in fastagent.config.ts."
status: current
---

# Configuration

- Agent behavior lives in its prompt files (`SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`), `skills/`, `prompts/`,
  `tools/`, and what its content provides: each entry's `AGENTS.md` and skills.
- What it works on and knows, its content, is declared in `context.json`.
- Deployment choices live in `fastagent.config.ts`, CLI flags, and environment variables.
- Secrets live in `<agent dir>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Config file

An agent is identified by one filename, `fastagent.config.ts`. (Your own `tools/` and `channels/` accept `.ts`,
`.js`, or `.mjs`.)

```ts
import type { FastagentConfig } from "@fastagent-sh/fastagent";

export default {
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
} satisfies FastagentConfig;
```

The import is type-only: your editor completes and checks every key. `defineConfig({ … })` is exported too and
behaves identically; keep the plain `export default {` shape, which the first-run model picker rewrites.

Every key is optional. Unknown keys fail at startup.

| Key | Default | Meaning |
|---|---|---|
| `model` | none | Default model spec, `provider/modelId`. With none set, the first-run picker asks and writes the choice here. |
| `thinkingLevel` | `"medium"` | Reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. Levels a model does not support are clamped. |
| `tools` | `[]` | Extra programmatic tools appended after the coding tools. Prefer `tools/` files. |
| `http.port` | `8787` | Default port for `dev` / `start`. |
| `http.cors` | `*` | Which origins a **browser** may call this serve from. The default answers every origin, on every bind: any page your users visit can call this port and read the reply, including a loopback `dev` serve. Setting it replaces the default: `["https://app.example.com"]` allows only that origin. An empty list is refused. `*` cannot be combined with cookie credentials. Channel routes are never browser-callable. |
| `http.invoke` | `true` | Serve `POST /invoke`. It is unauthenticated and runs a turn with the agent's full tools; set `false` when the port is public and the channels' signature checks should be the only way in. With it off, a channel may serve `POST /invoke` itself. `--no-invoke` does the same for one run. |
| `sessionControl` | `false` | Serve the session control plane at `/control/*` (state, entries, live events, steer/abort/compact, session properties, the session list) for remote clients. A chat channel's stop command does not need it. **Unauthenticated**: bind loopback (`--bind 127.0.0.1`), firewall the port, or put a gateway in front. |
| `deploy.agentcore.idleTimeoutSeconds` | `180` | `deploy agentcore` only: how long an idle session keeps its microVM (60–1209600 s). Memory bills for the idle tail; a session past it cold-starts. Changing it changes the template, so a kept `agentcore.template.yaml` needs `--force`. |
| `deploy.apt` | `[]` | Extra apt packages baked into the generated image (Debian default repos). For a custom apt repo or base image, write your own `Dockerfile`; `deploy` keeps it and warns that `deploy.apt` is not applied. A generated `Dockerfile` that drifts from the config is kept and flagged stale; `--force` regenerates it. |

The generated `.dockerignore` keeps `.git`. Add an exclusion if the agent does not need history. See
[what deploy bakes](deploy.md#what-deploy-bakes).

## Model selection

Model specs are `provider/modelId`. List them with `fastagent models [search]`.

```txt
CLI --model > FASTAGENT_MODEL > fastagent.config.ts model
```

With none set, a serving command (`dev` / `start` / `invoke`) in a terminal shows the model catalog (providers with
credentials first; picking one that needs auth runs `login` inline) and writes the choice to the config.
Non-interactive runs fail with `missing model`.

The default is optional for an app embedding the agent (`createPiAgentFromDir`, `createAgentService`): without one
the agent still opens and lists its conversations, each existing conversation runs on the model it recorded, and a
conversation with no model of its own is refused with `missing_model` until it is given one
(`docs/api-reference.md`, `createPiAgentFromDir`).

```bash
fastagent dev --model openai-codex/gpt-5.5
FASTAGENT_MODEL=openai-codex/gpt-5.5 fastagent start
```

`deploy` evaluates the same chain in production: `FASTAGENT_MODEL` from `.secrets/production/.env`, else
`config.model`. Your shell is not read, and `deploy` has no `--model` flag. The production value is
recorded in the release manifest (`fastagent.release.json`); a variable already set on the platform wins over it.
`deploy` prints the effective model and its source.

## Custom model endpoints

Declare a self-hosted model (vLLM, SGLang, Ollama, LM Studio) or your own gateway in `models.json` next to
`fastagent.config.ts`. The file's existence is the switch.

```json
{
  "providers": {
    "mygw": {
      "baseUrl": "http://vllm.internal:8000/v1",
      "api": "openai-completions",
      "apiKey": "$MYGW_API_KEY",
      "models": [{ "id": "deepseek-v3", "contextWindow": 65536 }]
    }
  }
}
```

The provider id joins the model id into a spec (`model: "mygw/deepseek-v3"`). Custom endpoints are additive:
built-in providers stay available.

### Keys

`apiKey` and `headers` values resolve at request time: `"$NAME"` reads an environment variable, `"!cmd"` uses a
command's stdout, anything else is a literal.

Use a reference for a real key: the file ships inside the image. `deploy` warns about every literal `apiKey`
(it cannot tell a placeholder such as `"ollama"` from a credential). `headers` values are not inspected.

A variable referenced here travels to the host once it is in `.secrets/production/.env`, like every other production value. The
variable backing the selected model is required: `deploy --run` refuses to start without a value for it.

### Routing a built-in provider through a proxy

Give an existing provider a new `baseUrl` and nothing else. Its models, pricing and compatibility flags are kept,
and existing OAuth / API-key auth keeps working:

```json
{
  "providers": {
    "deepseek": { "baseUrl": "https://llm-proxy.internal/v1" }
  }
}
```

### Compatibility flags

`compat` (per provider, or per model) carries switches for OpenAI-compatible servers, e.g.
`supportsDeveloperRole: false` or `thinkingFormat`.

| Setting | Use |
|---|---|
| `vllmPriority` | OpenAI Completions: sends vLLM's request priority. Lower numbers run earlier; requires the server's `--scheduling-policy priority`. |
| `supportsMaxOutputTokens: false` | OpenAI Responses: omits `max_output_tokens` for gateways that reject it. |
| `supportsMidConvoEffort: true` | Anthropic Messages: enables per-turn effort and signed-thinking binding controls. Enable only for a verified Claude model and faithful transport. |

### Image limits

A model's `inputLimits.images.resize` (`maxWidth`, `maxHeight`, `maxBytes`, `jpegQuality`) sets how images are
resized before they reach it: a turn's prompt images, `read` results, and tool-result images. A message steered or
queued into a running turn uses pi's defaults (2000 by 2000 pixels, 4.5 MiB encoded) instead.

```json
{
  "providers": {
    "mygw": {
      "models": [{ "id": "vision-large", "inputLimits": { "images": { "resize": { "maxWidth": 4096, "maxHeight": 4096 } } } }]
    }
  }
}
```

The schema is pi's; the full reference is pi's `docs/models.md` (`@earendil-works/pi-coding-agent`). Two FastAgent
differences:

- pi's own `~/.pi/agent/models.json` is not read. The machine's endpoints live in `~/.fastagent/models.json`
  instead (below).
- A malformed `models.json` fails startup.
- **Edits take effect while the agent runs.** Every reader (a turn, the model list, `update({ model })`) checks the
  model files first, this agent's and the machine's, and reads them again when one changed. An edit that cannot be
  used (it does not load, or it drops the agent's default model) keeps the models read before and is logged once,
  until it is fixed: the agent can write its own
  `models.json`, and a broken one must not leave it unable to run a turn. The `chat` session already open keeps its
  models; the next one reads the edit.

### Endpoints for this machine: `~/.fastagent/models.json`

An endpoint set up for the machine rather than for one agent (a local Ollama or LM Studio server, a company
gateway) goes in `~/.fastagent/models.json`, in the same schema. `FASTAGENT_MODELS_PATH` moves it. Every agent on
the machine inherits its providers, next to the global credentials file `~/.fastagent/.secrets/auth.json`, where a
provider's key can be stored instead of written into the file.

- The agent's own `models.json` wins a provider id: an agent that pins an endpoint keeps it.
- A malformed file fails startup, naming the file.
- It is plain JSON (no comments), and while it exists so must the agent's own `models.json` be: fastagent merges
  the two itself, into a snapshot under `~/.fastagent/.cache/models/`. An edit to either file makes a new snapshot,
  read from the next turn on. Snapshots are never pruned; delete the directory while no fastagent process runs.
- It does not ship, and neither does a key written into it. `fastagent info` lists the providers the agent
  inherits from it and marks a model whose endpoint comes from it. `deploy` refuses a model whose provider exists
  only there (with `--run`; a warning otherwise), and warns when it only overrides one of pi's built-in providers,
  which the deployed agent then runs without that entry.

`fastagent models` lists what the agent here can name (outside an agent, or with `-g`, the machine);
`fastagent info` shows what an agent resolved.

### Models newer than pi: `models-store.json`

pi bundles a model catalog with each release. A model released later is known once a **model catalog** lists it:
`fastagent models --refresh` fetches the catalog from pi.dev, for the providers the agent's credentials authenticate,
into `models-store.json` next to its `models.json`. Nothing refreshes it on its own.

- The agent's `models-store.json` is part of the definition: commit it, and it ships with a deploy, so the deployed
  agent knows the same models without a network call.
- `fastagent models --refresh -g` writes the machine's, `~/.fastagent/models-store.json`, with the global
  credentials file and the environment. Every agent here reads it under its own (the agent's wins a model id), and
  it does not ship: `deploy` refuses a model only it knows (with `--run`; a warning otherwise). Refresh in the agent
  to record it there. An embedding client runs the same refresh with its own credentials through
  `refreshMachineModelCatalog` ([API reference](api-reference.md)).
- An entry no newer than the installed pi's bundled catalog is ignored, so after a pi upgrade the bundled metadata
  takes over again.
- A refresh takes effect in a running agent from its next turn, whichever process ran it, without a restart.

## Content

An agent's directory is its own: its definition, its working directory, and its local instance's `.state/` and
`.secrets/`. What it works on and knows, its content, is declared in `context.json` beside the config, never
inferred from where the directory sits:

```json
{
  "content": {
    "notes": {},
    "handbook": { "readonly": true, "description": "The team's style rules. Follow them." },
    "app": { "github": "acme/app", "description": "The product. Open pull requests against main." },
    "docs": { "github": "acme/docs", "ref": "main", "readonly": true }
  }
}
```

Each entry is named by its key: one segment of letters, digits, `-` and `_`, unique ignoring case.

| Key | Meaning |
|---|---|
| `github` | A repository, `owner/repo`. Without it, the entry is a directory each machine links (below) |
| `ref` | With `github`: the branch, tag or full commit to clone. Defaults to the repository's default branch |
| `readonly` | The agent knows it and does not write it. An instruction to the agent, not a permission |
| `description` | One sentence for the agent: what it is, and how to treat it. The prompt gives it beside the entry |

No path of any machine is declared. On every instance the agent reaches an entry at `content/<name>` in its own
directory, and what is there is that machine's:

- **A link to a directory of this machine.** `fastagent content add <dir>` declares the entry and links
  `content/<name>` to the directory. For a `github` entry the directory is the root of a checkout of that
  repository, used as it is: never fetched, never switched to `ref`. When it is not at `ref`, startup and `info` say
  so. A link to nothing, to a file, or to a checkout of another repository is refused at start, naming it.

  A teammate, or another machine of yours, links its own for an entry the agent already declares (`content add`
  would declare a second one). Move away a clone fastagent made there first, or `ln` creates the link inside it:

  ```bash
  mkdir -p content && printf '*\n' > content/.gitignore   # when content/ does not exist yet
  ln -s ~/code/app content/app
  ```
- **A clone**, for a `github` entry with nothing linked: shallow, at `ref`, made in `content/<name>` the first time
  the agent starts (`dev`, `start`, `chat`, `invoke`). At each later start it is brought up to date in place, by
  git's own rules: a `git fetch`, then a fast-forward of the branch it is on (or a checkout of the tag or commit it
  is pinned to). git refuses whatever would overwrite the agent's work: a changed file the update touches, an
  untracked file it would replace, commits the remote does not have. Then, and when the fetch fails, when the clone
  is on another branch than declared, or when it holds commits no branch or tag does, it is kept as it is and
  startup warns with the reason. Nothing is deleted: the agent's branches, stashes and the changes an update does
  not touch stay.

  `info`, `content list` and `fastagent tool` report it without cloning. A first clone that fails stops the start,
  with git's reason. A clone of another repository under the entry's name (it was renamed or redeclared) stops
  the start and is named, never removed: move it away yourself.
- **Nothing**, for an entry without `github` on a machine that links no directory (a host, a teammate's laptop):
  the agent works without it, is not told of it, and the start says so by name.

`content/` carries its own `.gitignore` (`*`), so what a machine keeps there never enters the agent's repository,
and `deploy` keeps it out of the image.

git clones with its own configuration on this machine: a private repository needs the credentials your own
`git clone` uses (a credential helper, or `url.<base>.insteadOf` to reach GitHub over SSH). When git has none of its
own, it uses `GITHUB_TOKEN` from the environment, read each time git asks (the clone's config names a helper that
reads it, never the token itself), and so does the agent's own `git push` in the clone. git never prompts: a
missing credential fails the start instead of waiting.

`fastagent init <dir> --content <source>` and `fastagent content add/remove` edit `context.json` and the links
([CLI](cli.md#fastagent-content)); it can be edited by hand too. The entries' order means nothing. A linked directory
may not contain the agent directory, nor sit inside it: an agent lives beside the projects it works on, never in
one.

What each entry gives the agent, re-read every turn:

- **Its `AGENTS.md`**, at the entry's root, as project context, after the agent directory's own `AGENTS.md`
  (how the agent is built and changed, loaded first).
- **Its skills**, from its `.pi/skills/` then `.agents/skills/`, named `<content>/<skill>`: the `deploy` skill of the
  entry `app` is `app/deploy`, so it never collides with the agent's own or another entry's.
- **A place in the prompt**: its name, its location, whether the agent works on it or only knows it, and its
  `description`. The agent runs a command in it with `cd <location> && …`.
- **Its location for tools**: an authored tool reads `ctx.content` ([API reference](api-reference.md#tool-authoring)).

The locations are resolved when a process starts; editing `context.json` restarts `dev`. A deployed host links its
`content/` to its storage, so a `github` entry is a clone there, made and kept up to date the same way, and outlives
each release ([deploy](deploy.md#before-you-deploy)). An entry without `github` is a directory of this machine,
which a host does not have: the deployed agent works without it, and `deploy` and the host's startup say so by name.
To give a host what the agent only reads there, copy it into the agent directory outside `content/`, which every
release ships; to have the agent work on it from a host, move it to a repository and declare it as `github`.

## The system prompt

pi builds the agent's system prompt: its default (who the agent is, its tools, its rules, where pi's documentation
is), the project context from the agent directory's `AGENTS.md` and then each content entry's, the skills, and the
working directory. Two more files in the agent directory change it, both re-read every turn like the `AGENTS.md` files:

| File | Effect |
|---|---|
| `SYSTEM.md` | Replaces pi's default: identity, tool list, rules and documentation pointers. Write it when the agent should be someone other than pi's coding assistant. The model still receives every tool's schema |
| `APPEND_SYSTEM.md` | Added after the prompt, whichever it is. Standing instructions, goals, an approval policy. `init` scaffolds it |

pi's default says the agent is "an expert coding assistant", so an identity ("You are…") written into
`APPEND_SYSTEM.md` gives the model two; put it in `SYSTEM.md` instead. A `persona.md` is refused: its text belongs
in one of the two. A blank `SYSTEM.md` or `APPEND_SYSTEM.md` is reported and not used, since pi treats an empty
prompt as none. `deploy` loads the definition too, so any of these refusals stops it before an image is built.

FastAgent adds its own sections after these, whichever wrote the prompt: where the agent is and what it works on and
knows ([content](#content)), a note about tools that are registered but not loaded yet, and on a deployed host how
long its storage lasts and how the agent changes itself.

The machine's `~/.pi/agent/SYSTEM.md` and `APPEND_SYSTEM.md` are never read: a system prompt from someone's machine
would make the agent theirs.

An embedder that replaces the coding tools (`createPiAgentFromDefinition(dir, { tools })` without `read`, `bash`,
`edit` and `write`) must give the agent a prompt that matches, through `base` or a `SYSTEM.md`: pi's default claims
those tools, so the assembly is refused without one, and so is any turn after `SYSTEM.md` is deleted.

## Where the definition's files are read

Each resource has a FastAgent spelling at the agent directory's root, and pi's spelling in `.pi/` is read too,
below it. A name found twice in the definition takes the first and is reported, never silently:

| Resource | Read in this order |
|---|---|
| System prompt | `SYSTEM.md`, `.pi/SYSTEM.md`; `APPEND_SYSTEM.md`, `.pi/APPEND_SYSTEM.md` |
| Skills | `skills/`, `.pi/skills/`, `.agents/skills/`, then the machine's (below) |
| Prompt templates | `prompts/`, `.pi/prompts/`, then the machine's (below) |
| Extensions | `extensions/` only; a `.pi/extensions/` is reported as not loaded |

A skill's name may not contain `/`, which names the content entry a skill comes from: it is refused in the definition
and left out, with a warning, from the machine's and a content entry's.

## What the machine lends the agent

**Skills** and **prompt templates** also load from this machine, through pi's
[Agent Skills](https://agentskills.io/specification) discovery (`~/.pi/agent/skills/`, `~/.agents/skills/`, and
`.agents/skills/` in the directories above the agent's, up to its repository's root). pi's project scope is the agent
directory, so its `.pi/skills/`, `.agents/skills/` and `.pi/prompts/` are the definition's, not the machine's. A name
in the definition wins over the machine's silently: `fastagent add skill <name>` vendors one into `skills/` for
exactly that.

Skills and prompts from installed pi **packages** load too. A listed package that is not installed is skipped with
a warning; fastagent never installs one. The machine is read once, at startup.

A deployed image has only what its build put in it. The machine's extensions and system prompt are never used.

**Prompt templates on a served agent can be fired by anyone talking to it.** A template is invoked by a bare
`/<name>` in the prompt text, and on a channel or `POST /invoke` that text comes from other people. A template whose
name matches a platform command (`prompts/start.md` against Telegram's `/start`) rewrites that message. Keep the
machine's `prompts/` for `chat`, or put a template that belongs to the agent in its definition's `prompts/`.

## Harness settings: `~/.pi/agent/settings.json`

Compaction, retries, prompt-cache warming and transport timeouts are pi settings. `dev`, `start` and `chat` read
the machine's `~/.pi/agent/settings.json` and the agent directory's `.pi/settings.json` (deep-merged, the agent's
wins) once at startup. The agent's file is part of its definition, so it ships with a deploy. Nothing of pi's
project scope is read from content.

| Setting | Default | Effect |
|---|---|---|
| `cacheWarming` | `"streaming"` | During a long tool call, pi re-sends the last request with a one-token budget to keep the provider's prompt cache alive, billed as a cache read, only when the expected saving exceeds $0.05. `"off"` never does; `"idle"` also warms between turns. |
| `compaction` | pi's defaults | `reserveTokens` / `keepRecentTokens`, and per-model overrides in `compaction.modelOverrides`. |
| `retry` | pi's defaults | Provider and agent retry budgets. `retry.maxAgentDelayMs` (60s) caps how long a turn waits in backoff. |

```json
{
  "cacheWarming": "off",
  "compaction": { "modelOverrides": { "anthropic/claude-fable-5": { "keepRecentTokens": 40000 } } }
}
```

### The prompt lives in the session record

pi records the system prompt as the transcript's first message; an edit to `SYSTEM.md`, `APPEND_SYSTEM.md` or an
`AGENTS.md` (the agent's own or a content entry's) is appended
as a patch. On models that accept mid-conversation system messages this keeps the provider's cached prefix; on
others the edit still costs a cache miss. The session control plane reports that entry with an empty payload.

## Auth and secrets

| Source | Use case |
|---|---|
| `fastagent login` | Writes credentials to `<agent dir>/.secrets/auth.json` (override: `FASTAGENT_AUTH_PATH`). `-g`, or running outside any agent, writes `~/.fastagent/.secrets/auth.json`. |
| Provider env vars | Servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Dev `.env` | `<agent dir>/.secrets/.env`, loaded by local commands and `add <channel>`. Excluded from git by `.secrets/.gitignore`. |
| Production `.env` | `<agent dir>/.secrets/production/.env`, loaded by `start`, `deploy` and `add <channel> --env production`. `deploy` carries it whole, never falling back to dev. |

For one provider, the agent uses the first of:

1. its own `auth.json`;
2. an `apiKey` in `models.json`;
3. the provider's env var;
4. the global `~/.fastagent/.secrets/auth.json`.

The first three are pi's order. The global file comes last because a deployment never has it: a global login that
outranked a key in `.secrets/.env` would run one credential locally and another deployed. A refresh is written back
to the file the credential was read from. Setting `FASTAGENT_AUTH_PATH` or `FASTAGENT_SECRETS_DIR` names the one
file to use, so the global file is not read at all.

Do not commit `.env` or credentials. `fastagent info` and `fastagent dev` print the resolved auth source.

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

**Nothing FastAgent serves is authenticated** — `POST /invoke` and `/control/*` alike. Whoever can reach the port
can use everything the agent mounts, and a bind address only limits who can reach it by network. Authenticate in a
channel's own handler, in your app's middleware when you [embed](embedding.md), or in a gateway in front.
Channels that dial out (WebSocket) are reachable by whoever can message the bot, whatever the bind.

Browsers get the `http.cors` policy (default `*`). Unauthenticated routes refuse a body that is not
`application/json`, which stops cross-origin writes that skip the preflight.

## Machinery: `.state/`, `.secrets/` and `content/`

- `<agent dir>/.state/` — mutable machine state: sessions, channel state (`channels/<kind>/`), schedule state.
  Single-process; point it at a volume in a container.
- `<agent dir>/.secrets/` — the agent's `.env`, `auth.json`, and login `settings.json` (stable OAuth device ID). The scaffolded `.secrets/.gitignore` keeps them
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
content:    <agent dir>/content/<name>
sessions:   <state root>/sessions
auth:       FASTAGENT_AUTH_PATH    > <secrets>/auth.json
endpoints:  FASTAGENT_MODELS_PATH  > ~/.fastagent/models.json (under the agent's own models.json)
```

A leading `~` is expanded. `auth.json` is written `0600` on every write; `.env` and directories keep the
permissions you gave them. `FASTAGENT_SECRETS_DIR` set inside `.env` moves `auth.json` but not the `.env` itself.
`.env.example` always stays at `<agent dir>/.secrets/.env.example`.

## Code inputs must be real files

Each of `tools/`, `channels/`, and `schedules/` must be inside the agent directory, and each entry must be a real
file. A symlink is skipped with a warning (`info`, `dev`, `start`), never followed. To share code between agents,
publish a package or copy the file.

## Tools

Two ways to add tools:

1. Modules below `tools/`, at any depth. Every tool a module exports is mounted (what `defineTool` makes, or a pi
   `AgentTool`), and a module that exports none is a helper, so a service's tools and the client they share can sit
   in one folder. Tests (`*.test.*`, `*.spec.*`), `.d.ts` files, `node_modules` and dot-folders are not loaded. A tool
   is named by `defineTool({ name })`. One without a name takes its file's name (`tools/lookup-order.ts` →
   `lookup-order`) only when its module sits directly in `tools/` and exports no other tool; any other unnamed tool
   refuses the start. Group related tools with `defineTool({ namespace })`.
2. `config.tools`, for programmatic injection.

Every directory agent mounts pi's coding tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. They are
capabilities, not a security policy; to isolate an agent, sandbox its whole process.

`config.tools` and `tools/` are appended after the coding tools. On a name collision the earlier tool wins and the
collision is reported. Pi's codemode and tool-search extensions load by default; their settings control activation,
and `"extensions": ["-builtin:codemode"]` in Pi's settings turns one off. Pi's MCP extension is not loaded, so
`mcp.json` has no effect on an agent. Every serve mounts `wake`/`unwake`.
The startup report and `fastagent info` list each authored tool with where it comes from (its file, or
`config.tools`). `fastagent info --json` shows the mounted surface: `tools` are the authored tools the model gets up
front, `toolSources` where each comes from, and
`indirectTools` the rest, each with how it is reached (`tool_search`, `codemode`, `hidden`, `inactive` until an
authored loader activates it, or `unreachable` when pi's settings disable the built-in extension it needs).

Reusable packages export ordinary `FastagentTool[]`:

```ts
import type { FastagentConfig } from "@fastagent-sh/fastagent";
import { integrationTools } from "@acme/fastagent-tools";

export default {
  tools: integrationTools(),
} satisfies FastagentConfig;
```

Package tools receive the same `ToolContext` as `defineTool` tools. Their `secrets` declarations count like your
own: `dev`/`start` refuse to boot, and `deploy --run` refuses to start, while one has no value in the selected
environment. Dev uses `.secrets/.env`; production uses `.secrets/production/.env`.

## Extensions

Extension modules under `extensions/` run in `fastagent chat` and when serving (`dev`, `start`, channels, a
container).

Discovered shapes: `extensions/notify.ts` and `extensions/audit/index.ts`. A subdirectory whose `package.json`
declares a `pi` field is not supported and is warned about. A symlinked entry is refused. The machine's `~/.pi`
extensions are never loaded. An npm package an extension imports goes in the agent's `package.json`, like a tool's.
An extension that fails to load is warned about once and left out; the rest of the agent runs.

| | serving | `chat` |
|---|---|---|
| tools it registers | offered to the model | offered to the model |
| event and lifecycle handlers | run | run |
| `/name` commands it registers | run when a prompt is `/name [args]` | run |
| `ctx.hasUI` | `false` | `true` |
| `select` / `confirm` / `input` / `custom` | resolve as cancelled (`undefined`, `false`) | shown to you |
| `notify` | logged | shown |
| status, widgets, shortcuts, renderers | no effect | shown |
| `ctx.newSession` / `fork` / `navigateTree` / `switchSession` / `reload` | throw | run |
| `ctx.shutdown()` | logs a warning; the process keeps serving | exits |
| `pi.registerProvider()` / `registerVirtualModel()` | session-local | session-local |

When serving, every session gets its own extension instances: the factory runs and `session_start` fires when a
turn (or a control-plane write) opens the session, and `session_shutdown` fires when it ends. An unbound factory
also runs when the model catalog is built, before resolving the configured model; virtual models declared there
can be startup selections. State kept in
memory does not survive to the next turn; rebuild it from the session in `session_start`. Stop timers and close
handles in `session_shutdown`: a stale `pi` or `ctx` throws when used after it, and an exception nobody catches
ends the process.

A served command settles the invoke:

- if it starts a model turn (`pi.sendUserMessage`, or `pi.sendMessage` with `triggerTurn`), the invoke streams
  that turn;
- if it does its work without one, the invoke completes with no text, so write anything the caller should see
  into the session or start a turn;
- if it throws, or a turn it starts cannot begin (no credentials, for example), the invoke fails with that error.

Anyone who can send the agent a message can run its commands, and a command runs without the model deciding to.

**Extensions are live.** When any file under `extensions/` changed (an edited extension, a module it imports from
there, an added one), whatever loads the extensions next loads the code as it is now: the next session, the `/` menu,
the model catalog (so a model an extension declares is in session control's `models()` and can be set) and `chat`. No
restart, in `dev` or `start`. So an agent can give itself a tool or a command by writing an extension. Code it
imports from outside `extensions/` is reloaded only when something under `extensions/` changes too. What an
extension starts when it LOADS (a timer, a socket opened at import) keeps running across a reload; start such
things in `session_start` and stop them in `session_shutdown`.

### More than one agent

Each agent is a directory of its own, with its own config, prompt, skills, tools, channels, schedules, `.state/` and
`.secrets/`. Several agents can work on one project: each declares it as content.

```bash
fastagent init ~/agents/reviewer --content ~/code/app
fastagent init ~/agents/releaser --content ~/code/app
fastagent dev ~/agents/reviewer
```

## Channels

A file under `channels/` (`.ts` / `.js` / `.mjs`) enables a channel; rename it to `<name>.ts.disabled` to disable
it. Channels are not configured in `fastagent.config.ts`. See [Channels](channels.md).

## Schedules

A schedule is a prompt the agent runs on a cron: `schedules/<name>.md`, with the cron and its timezone in the
frontmatter and the prompt as the body. The file name is the schedule's name.

```md
---
cron: "0 9 * * 1-5"
tz: America/New_York
---

Generate today's digest and send it with slack-send to channel C0123456789.
```

- **The frontmatter** holds `cron` (5 fields, required) and `tz` (an IANA timezone, default UTC), one `key: value`
  line each, quoted or not: a cron starting with `*` may be written bare. Any other key or line refuses the file.
  Only `*.md` files are schedules; rename one to `<name>.md.disabled` to turn it off.
- **The same guard as a recurring wake-up**, since the agent can write these files too: no two instants of a
  schedule may be under 10 minutes apart, which also refuses the six-field per-second form and a year field. This is
  judged on the expression alone, so `0,5 9 * * *` is refused at any hour. At most 20 schedules are armed, the first
  20 by name, counting an old definition kept for a file that broke.
- **A cron AgentCore can run, on every host.** AgentCore's clock is EventBridge, which cannot express a few cron
  forms: both day fields restricted at once (`0 9 15 * WED`, "the 15th or any Wednesday"), `L` and `#` day forms,
  and nicknames such as `@daily`. Such a file is refused everywhere, so a schedule that runs locally also runs
  there. One difference remains: on the day a DST change skips a local hour, a time inside it (02:30 in most of
  the US) is skipped on AgentCore and run an hour later elsewhere. A file refused for any reason is logged and not
  armed; it never stops a serve, and `deploy --run` refuses to ship one.
- **One conversation per schedule.** Every fire continues `schedule:<name>`, so the agent sees what its earlier runs
  did, and nothing of users' chats.
- **It delivers nothing.** The agent's tools send output; name the target (a chat or channel id) in the prompt.
  What a run said is in its session under `<stateRoot>/sessions/`.
- **Each instant fires at most once**, even with several schedulers over one state root: a claim under
  `<stateRoot>/schedule/claims/<name>/` is taken before the turn. After downtime one overdue run is caught up, not
  one per missed instant; a schedule that has never fired starts at its next instant. A run still going when the
  next instant arrives makes that one `skipped`.
- **Where the clock is.** `dev` and `start` run it while they serve. On AgentCore the container mirrors each
  schedule into a recurring EventBridge schedule, which fires it on EventBridge's own clock and wakes the container,
  once an envelope has reached it through the forwarder after a deploy (`deploy --run` probes it). A schedule keeps one Fly or Railway machine running; to scale to zero, a clock of your own replaces it
  ([Deploy](deploy.md#scale-to-zero)).
- **Nothing runs a schedule by name.** Work started on demand is `POST /invoke` (or `fastagent invoke`) with its
  prompt. A prompt kept as a template in `prompts/<name>.md` is reused by sending `/<name>`, and a schedule's body
  can be that same `/<name>`.
- **Edits take effect within 30 seconds, without a restart**: the clock re-reads `schedules/`, arming an added or
  changed schedule from its next instant and disarming a removed one. A file that stops being valid keeps its last
  definition and is logged; at start, it is logged and not armed. It never stops the serve, since the agent writes
  schedules too and one it got wrong must not take the agent down at its next start; `fastagent info` reports it, and
  `deploy --run` refuses to ship one. A release replaces an agent-written schedule like any file in the definition.

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

Custom session stores, execution environments, distributed leases, base prompt overrides, and code-based model
providers (`providers`) are library injection points. See [Embedding](embedding.md).
