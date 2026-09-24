---
title: Configuration
description: "Configure a FastAgent agent: model selection, auth, ports, sessions, tools, channels, state paths, and deploy options in fastagent.config.ts."
status: current
---

# Configuration

- Agent behavior lives in `persona.md` (identity), `skills/`, `tools/`, and `AGENTS.md` project context.
- Deployment choices live in `fastagent.config.ts`, CLI flags, and environment variables.
- Secrets live in `<agent dir>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Config file

An agent is identified by one filename, `fastagent.config.ts`. (Your own `tools/`, `channels/`, and `routines/`
accept `.ts`, `.js`, or `.mjs`.)

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
| `http.invoke` | `true` | Serve `POST /invoke`. It is unauthenticated and runs a turn with the agent's full tools; set `false` when the port is public and the channels' signature checks should be the only way in. With it off, a channel may serve `POST /invoke` itself, and `POST /run` is withheld too unless `http.run` is set. `--no-invoke` does the same for one run. |
| `http.run` | follows `http.invoke` | Serve `POST /run` and `GET /routines` (see [API reference](api-reference.md#post-run)). Set `true` to keep them when `http.invoke` is `false` — for an external clock driving your routines. `--no-invoke` withholds them for one run. Inert on AgentCore. No effect when `routines/` declares nothing. |
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

```bash
fastagent dev --model openai-codex/gpt-5.5
FASTAGENT_MODEL=openai-codex/gpt-5.5 fastagent start
```

`deploy` evaluates the same chain in the deployed environment: `FASTAGENT_MODEL` from `.secrets/.env`, else
`config.model`. Your shell is not read, and `deploy` has no `--model` flag. The value from `.secrets/.env` is
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

A variable referenced here travels to the host once it is in `.secrets/.env`, like every other variable there. The
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

The schema is pi's; the full reference is pi's `docs/models.md` (`@earendil-works/pi-coding-agent`). Two FastAgent
differences:

- pi's machine-global `~/.pi/agent/models.json` is not read.
- A malformed `models.json` fails startup.

`fastagent models` lists the built-in catalog only; `fastagent info` shows what an agent resolved.

## What the machine lends the agent

**Skills** and **prompt templates** load from the definition's `skills/` and from this machine, through pi's
[Agent Skills](https://agentskills.io/specification) discovery (`~/.pi/agent/skills/`, `~/.agents/skills/`, project
`.pi/skills/` and `.agents/skills/`). A name in the definition wins a collision; `fastagent add skill <name>`
vendors one into `skills/`.

Skills and prompts from installed pi **packages** load too. A listed package that is not installed is skipped with
a warning; fastagent never installs one. The machine is read once, at startup.

A deployed image has only what its build put in it. The machine's extensions and system prompt are never used.

**Prompt templates on a served agent can be fired by anyone talking to it.** A template is invoked by a bare
`/<name>` in the prompt text, and on a channel or `POST /invoke` that text comes from other people. A template whose
name matches a platform command (`prompts/start.md` against Telegram's `/start`) rewrites that message. Keep the
machine's `prompts/` for `chat`, or put a template that belongs to the agent in its definition.

## Engine settings: `~/.pi/agent/settings.json`

Compaction, retries, prompt-cache warming and transport timeouts are pi settings. `dev`, `start` and `chat` read
the machine's `~/.pi/agent/settings.json` and the project's `<workspace>/.pi/settings.json` (deep-merged, project
wins) once at startup. The project file is inside the workspace, so it ships with a deploy.

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

pi records the system prompt as the transcript's first message; an edit to `persona.md` or `AGENTS.md` is appended
as a patch. On models that accept mid-conversation system messages this keeps the provider's cached prefix; on
others the edit still costs a cache miss. The session control plane reports that entry with an empty payload.

## Auth and secrets

| Source | Use case |
|---|---|
| `fastagent login` | Writes credentials to `<agent dir>/.secrets/auth.json` (override: `FASTAGENT_AUTH_PATH`). `-g`, or running outside any agent, writes `~/.fastagent/.secrets/auth.json`. An agent reads the global file for any provider its own lacks, and writes a refresh back to the file it read from. |
| Provider env vars | Servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Agent `.env` | `<agent dir>/.secrets/.env`, loaded by CLI commands and carried whole by `deploy`. Excluded from git by the `.secrets/.gitignore` that `init` scaffolds. |

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

## Machinery: `.state/` and `.secrets/`

- `<agent dir>/.state/` — mutable machine state: sessions, channel state (`channels/<kind>/`), schedule state.
  Single-process; point it at a volume in a container.
- `<agent dir>/.secrets/` — the agent's `.env` and `auth.json`. The scaffolded `.secrets/.gitignore` keeps them
  out of git, and `deploy` keeps them out of the image. A deployed box receives the values through the host's
  secret store; its seeded (possibly rotated) `auth.json` lives on the volume.

Generated deployments keep the workspace at `<persistent-root>/base/`, with `.state/` and `.secrets/` beside it.
The root is `/data` on Docker, Fly and Railway and `/mnt/data` on AgentCore (reset by every deploy — see
[Deploy](deploy.md#aws-bedrock-agentcore)).

For a manually configured service:

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

```txt
state root: FASTAGENT_STATE_DIR    > <agent dir>/.state
secrets:    FASTAGENT_SECRETS_DIR  > <agent dir>/.secrets
sessions:   <state root>/sessions
auth:       FASTAGENT_AUTH_PATH    > <secrets>/auth.json
```

A leading `~` is expanded. `auth.json` is written `0600` on every write; `.env` and directories keep the
permissions you gave them. `FASTAGENT_SECRETS_DIR` set inside `.env` moves `auth.json` but not the `.env` itself.
`.env.example` always stays at `<agent dir>/.secrets/.env.example`.

## Code inputs must be real files

Each of `tools/`, `channels/`, and `routines/` must be inside the agent directory, and each entry must be a real
file. A symlink is skipped with a warning (`info`, `dev`, `start`), never followed. To share code between agents,
publish a package or copy the file.

## Tools

Two ways to add tools:

1. Files under `tools/` (the filename is the tool name: `tools/lookup-order.ts` → `lookup-order`).
2. `config.tools`, for programmatic injection.

Every directory agent mounts pi's coding tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. They are
capabilities, not a security policy; to isolate an agent, sandbox its whole process.

`config.tools` and `tools/` are appended after the coding tools. On a name collision the earlier tool wins and the
collision is reported. `search_tools` mounts when a deferred tool exists, and every serve mounts `wake`/`unwake`.
`fastagent info --json` shows the mounted surface.

Reusable packages export ordinary `FastagentTool[]`:

```ts
import type { FastagentConfig } from "@fastagent-sh/fastagent";
import { integrationTools } from "@acme/fastagent-tools";

export default {
  tools: integrationTools(),
} satisfies FastagentConfig;
```

Package tools receive the same `ToolContext` as `defineTool` tools. Their `secrets` declarations count like your
own: `dev`/`start` refuse to boot, and `deploy --run` refuses to start, while one has no value in `.secrets/.env`.

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
| `notify`, status, widgets, shortcuts, renderers | no effect | shown |
| `ctx.newSession` / `fork` / `navigateTree` / `switchSession` / `reload` | throw | run |
| `ctx.shutdown()` | logs a warning; the process keeps serving | exits |
| `pi.registerProvider()` | refused: declare providers in `models.json` | runs |

When serving, every session gets its own extension instances: the factory runs and `session_start` fires when a
turn (or a control-plane write) opens the session, and `session_shutdown` fires when it ends. State kept in
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
Extension code changes need a restart; `dev` restarts on its own.

### When the repo already owns `tools/` or `channels/`

No conflict: the agent lives in `./fastagent/`, and FastAgent scans only the agent's own directories. An enabled
file under `tools/`, `channels/` or `routines/` that cannot load fails the run.

### More than one agent

Several agent directories can share one workspace:

```bash
fastagent init . --agent-dir reviewer
fastagent init . --agent-dir releaser
FASTAGENT_AGENT=reviewer fastagent dev .
FASTAGENT_AGENT=releaser fastagent deploy fly .
```

Each has its own config, persona, skills, tools, channels, routines, `.state/`, and `.secrets/`. With one agent,
selection is automatic; with several, the one named `fastagent` answers unless `FASTAGENT_AGENT` (shell or
`.envrc`) names another.

The workspace is always the agent directory's parent: `fastagent dev .` and `fastagent dev reviewer` both work on
the project. For separate workspaces, run `fastagent init reviewer` and `fastagent init releaser` (creating
`reviewer/fastagent/` and `releaser/fastagent/`). `init` refuses a placement that would hide another definition.

## Channels

A file under `channels/` (`.ts` / `.js` / `.mjs`) enables a channel; rename it to `<name>.ts.disabled` to disable
it. Channels are not configured in `fastagent.config.ts`. See [Channels](channels.md).

## Logging

`FASTAGENT_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) overrides the default: `debug` for `dev`, `info` for
`start`. Per-turn traces log at `debug`, so `start` keeps end-user content out of logs unless you opt in.

```bash
FASTAGENT_LOG_LEVEL=debug fastagent start
```

It is read per log line, so setting it in `.secrets/.env` works locally and, since `deploy` carries that file,
on the deployed box too. A real environment variable wins over the file.

## Not config

Custom session stores, execution environments, distributed leases, base prompt overrides, and code-based model
providers (`providers`) are library injection points. See [Embedding](embedding.md).
