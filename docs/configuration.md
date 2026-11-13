---
title: Configuration
description: "Configure a FastAgent agent: fastagent.config.ts and fastagent.json, models and custom providers, content, the prompt, the environment, secrets, ports, paths, tools, extensions, channels and schedules."
status: current
---

# Configuration

| What | Where |
|---|---|
| Behavior | `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, code in `src/` |
| Model, providers, shared content/MCP, defaults | `fastagent.config.ts` (the program) |
| One instance's values | `fastagent.json`, flags, environment variables |
| Secrets | `.secrets/.env`, `.secrets/auth.json` (`fastagent login`), provider variables |

## `fastagent.config.ts` and `fastagent.json`

`fastagent.config.ts` belongs to the agent's author and is committed. `fastagent.json` belongs to whoever runs one
instance. One agent serving two customers is one config and two `fastagent.json` files.

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  defaults: { model: "openai/gpt-5.5", http: { port: 8787 } },
});
```

Every key is optional. An unknown key refuses the start.

| Key | Default | Meaning |
|---|---|---|
| `providers` | `[]` | Model providers beyond the built-ins ([custom models](#custom-models)) |
| `settings` | none | What each instance may choose, as a schema (`obj({ repo: str() })` from `@earendil-works/pi-schema`). Not for secrets |
| `defaults.model` | none | `provider/modelId` ([model selection](#model-selection)) |
| `defaults.thinkingLevel` | the harness's | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `defaults.starters` | none | Up to 6 example first messages a client may offer |
| `defaults.settings` | none | Default values of `settings` |
| `defaults.http.port` | `8787` | Port of `dev` and `start` |
| `defaults.http.publicUrl` | none | The public `https://` URL platforms reach the instance at. Set, a serve points Telegram, Feishu and Lark there itself |
| `defaults.http.api` | `true` | Serve the [Agent API](#the-agent-api-over-http) under `/v1` when a key is set. `false` turns it off |
| `defaults.channels.<name>.ingress` | `dev`: `connection`; else `webhook` | How a channel that can do both receives |
| `defaults.channels.<name>.app` | none | Slack and Lark only: the app this instance is bound to and its saved URL (written by `deploy --run` and `channels setup --record-url`) |
| `defaults.deploy.agentcore.idleTimeoutSeconds` | `180` | AgentCore only: how long an idle session keeps its microVM |

The name and description of the program come from its `package.json`.

### An instance's `fastagent.json`

It overrides `starters`, `model`, `thinkingLevel`, `http`, `channels` and `settings`, and adds what only an instance has:
`name`, `description`, `content`, `mcpServers`, `instructions`, `skills`, `prompts`. Objects merge, arrays replace. A
bad value refuses the open, naming file and path (`fastagent.json: /http/port expected <= 65535`).

```json
{
  "settings": { "repo": "acme/api" },
  "instructions": ["./notes/house-rules.md"],
  "skills": ["./extra-skills"],
  "prompts": ["./extra-prompts"]
}
```

| Command | Reads |
|---|---|
| `dev`, `invoke`, `info` | the project's `fastagent.json`, or the one `--config` names |
| `start`, `deploy` | only the one `--config` names |
| an app | the `config` it passes `openAgent` |

`FASTAGENT_CONFIG` is the same as `--config`; `FASTAGENT_CONFIG_JSON` holds the JSON itself (what a deploy sets on a
host). Paths in it are relative to the file. An instance only adds: a skill or template with a program's name refuses
the open. `fastagent build` writes the file's JSON Schema as `fastagent.schema.json`; point `$schema` at it.

Code reads the settings through [`needs`](#secrets-in-code): `needs([], (_, settings) => ...)`.

### Variables and flags

Order: the program's defaults, then `fastagent.json`, then the variable, then the flag. `fastagent info --json` shows
where each value came from.

| Sets | Variable | Flag |
|---|---|---|
| `model` | `FASTAGENT_MODEL` | `--model` |
| `thinkingLevel` | `FASTAGENT_THINKING_LEVEL` | `--thinking` |
| `http.port` | `PORT` (`start` only) | `--port` |
| `http.api` | `FASTAGENT_HTTP_API` | |
| `http.publicUrl` | `FASTAGENT_HTTP_PUBLIC_URL` | |
| `channels.<name>.ingress` | `FASTAGENT_INGRESS` | `--ingress slack=webhook,feishu=connection` |

`openAgent` and `deploy` read none of these: give them a configuration.

## Model selection

```txt
--model > FASTAGENT_MODEL > fastagent.json model > defaults.model
```

With none set, a command in a terminal lets you pick one (and sign in), then prints the line to keep in the config.
Without a terminal it fails with `missing model`. `fastagent models [search]` lists the specs. A command that runs the
agent stops at startup when the model it resolves is not in the lists; `openAgent` opens an agent whose configured
default is not, as [embedding](embedding.md) says.

`deploy` takes the model from the configuration only, never from your shell. The model lists are refreshed from
[pi.dev](https://pi.dev/models) at most every 4 hours and kept in `<state root>/models/`; `FASTAGENT_OFFLINE=1` skips
the network.

## Custom models

A self-hosted model or a gateway is a provider in code:

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

Read the key through `needs`, never write it into the config: the config ships in the image.

## Content

What the agent works on is declared by name:

- `fastagent.config.ts` (committed): GitHub repositories every instance gets (`content`).
- `fastagent.json`: repositories and local directories of this instance only.

```json
{
  "content": {
    "app": { "github": "acme/app", "ref": "main", "description": "The product. Open pull requests against main." },
    "notes": { "path": "~/Documents/notes", "description": "My notes. Cite them." }
  }
}
```

| Key | Meaning |
|---|---|
| `github` | `owner/repo`, cloned to `content/<name>` in the working directory and updated at each start |
| `ref` | Branch, tag or commit; default the repository's default branch |
| `path` | A local directory, used in place (`fastagent.json` only) |
| `description` | One sentence telling the agent what it is and how to treat it |

- An update never overwrites the agent's work: if git would, the clone is kept as is and the start warns.
- Private repositories use your git credentials, or `GITHUB_TOKEN`.
- A project's `AGENTS.md` and skills are files the agent reads there. They never join its prompt; say so in the
  `description` if it should read them first.
- Changes to the declarations apply at the next start. A deployment only gets repositories: a local directory never
  reaches a host.

Edit with `fastagent init --content` and `fastagent content add|remove|list`, or by hand.

## The system prompt

`SYSTEM.md` is the whole prompt, read for every message. FastAgent appends: the agent's `AGENTS.md`, its skills, its
content, and (when deployed) what a self-edit changes. Nothing comes from the machine (no `~/.pi/agent`).

Prompt templates (`prompts/<name>.md`) run on a bare `/<name>`, and on a channel anyone can type one. A template named
like a platform command (`prompts/start.md` for Telegram's `/start`) takes that command over.

## Auth and secrets

| Source | Use |
|---|---|
| `fastagent login` | Stores credentials in `.secrets/auth.json`; `-g` stores them in `~/.fastagent/.secrets/auth.json` |
| Provider variables | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … for servers and CI |
| `.secrets/.env` | Values for local commands; git-ignored |
| `.secrets/production/.env` | Values for `start` |

A provider's credential comes from the agent's `auth.json`, then the provider's variable, then the global file. A
deployment never reads your files: give it `--env-file` or `--from-env`. `--env-file <file>` works on `dev`, `start`,
`invoke`, `info` and `schedules run` too.

### Secrets in code

Code declares the secrets it reads, in the module that reads them:

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

A required secret without a value refuses the start, naming the file. `info` lists every declaration, and `deploy`
checks the target holds them. `needs` works around tools, extensions, channels, schedules and providers.

## Ports and bind address

```txt
port   dev:   --port > http.port > 8787           start: --port > PORT > http.port > 8787
bind   dev:   --bind > 127.0.0.1                  start: --bind > all interfaces
```

`--bind` takes an IP or `localhost`. A serve answers its channels' routes (each checks its platform), the
[Agent API](#the-agent-api-over-http) with a key, and `GET /health`: public, `200 {"status": "ok", "webhooks": [...]}`
once ready and `503 {"status": "starting", …}` before, each webhook channel as `{ channel, outcome }`.

## The Agent API over HTTP

Set `FASTAGENT_API_KEY` (in `.secrets/.env`, or on the host) and a serve answers the [Agent API](agent-api.md#over-http) under
`/v1` to `Authorization: Bearer <key>`. Several keys, comma-separated, let you rotate one. The key opens the whole
instance ([security model](agent-api.md#security)): keep it on a server.

```bash
FASTAGENT_API_KEY=$(openssl rand -hex 32)
```

Call it with `connectAgent(url, { apiKey })` from `@fastagent-sh/fastagent/client`, or check it with
`fastagent invoke --url <url> "hello"`. `deploy --run` makes a key when the target has none.

## Where things live

| Path | Holds |
|---|---|
| `.fastagent/dev/`, `.fastagent/start/` | The local instances of `dev` and `start`: working directory and state. Safe to delete `dev/` to start over |
| `<root>/.state/` | Storage (`agent.sqlite`), channel and schedule state. One process at a time |
| `.secrets/` | `.env`, `auth.json`, MCP grants. Never in git or the image |
| `<workdir>/content/` | Clones of `github` content |

| Flag | Variable | Default |
|---|---|---|
| `--root <dir>` | `FASTAGENT_ROOT` | `.fastagent/dev` (`start`: `.fastagent/start`) |
| `--state <dir>` | `FASTAGENT_STATE_DIR` | `<root>/.state` |
| `--workdir <dir>` | `FASTAGENT_WORKDIR` | `<root>` |
| `--name <name>` | `FASTAGENT_NAME` | `fastagent.json`'s `name`, else the program's |
| | `FASTAGENT_SECRETS_DIR` | `.secrets` (`start`: `.secrets/production`) |
| | `FASTAGENT_AUTH_PATH` | `<secrets>/auth.json` |

A deployment's root is `/data` (Docker, Fly, Railway) or `/mnt/data` (AgentCore). On your own server:

```bash
fastagent build
FASTAGENT_ROOT=/data FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

## Code: `src/`

| Directory | Each file default-exports |
|---|---|
| `src/tools/` | a tool: `defineTool` from `@earendil-works/pi-durable` |
| `src/extensions/` | an extension: `defineExtension` |
| `src/channels/` | a channel ([Channels](channels.md)) |
| `src/schedules/` | a schedule: `defineSchedule` |

Any of them may be wrapped in `needs`. Every file is loaded; there is nothing to register. Tests (`*.test.*`) are
skipped, and helpers go elsewhere (`lib/`). Rename a file to `<name>.ts.disabled` to turn it off.

## Tools

Every agent has the coding tools `read`, `write`, `edit` and `bash`. They are not a sandbox: to isolate an agent,
sandbox its process. A tool's `parameters` schema is checked before `execute` runs. A tool that needs its session id
calls `await sessionIdOf(api, context)`. [MCP servers](mcp.md) add tools from `mcpServers`.

## Extensions

An extension (`defineExtension({ name, … })`) bundles tools, prompt sections and hooks. A third-party one is a file in
`src/extensions/` that re-exports it: `export { default } from "some-extension-package"`.

## Schedules

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  tz: "America/New_York",
  prompt: "Generate today's digest and send it with slack_send to channel C0123456789.",
});
```

- `cron` has 5 fields; `tz` defaults to UTC; `prompt` is text or `({ at }) => text`.
- Runs at most every 10 minutes; at most 20 schedules. Cron forms AgentCore cannot run (`L`, `#`, `@daily`, both day
  fields) are refused everywhere.
- Each schedule has one session that every run continues.
- It delivers nothing itself: name the send tool and the target in the prompt.
- Each instant runs at most once. After downtime, one missed run is caught up. A run still going makes the next one
  `skipped`.
- `dev` and `start` run the clock; on AgentCore, EventBridge does.

`fastagent schedules list` shows the next runs and the last outcome; `fastagent schedules run <name>` runs one now.

### Self-scheduling

Every serve (not `fastagent invoke`) gives the agent `wake` and `unwake`:

- `wake({ in: "30m", prompt })` or `wake({ cron: "0 9 * * *", tz?, prompt })` fires back into the same session, and
  survives restarts.
- At most 20 pending per session, at least 10 minutes between recurring runs.
- `unwake({ id })` cancels one; `fastagent schedules unwake <id>` cancels any while nothing serves.

## Logging

`FASTAGENT_LOG_LEVEL` is `debug`, `info`, `warn` or `error`. Defaults: `debug` for `dev`, `info` for `start`, which
keeps message content out of the logs.
