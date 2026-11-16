---
title: Configuration
description: "Configure a FastAgent agent: fastagent.config.ts, models and custom providers, the prompt, the environment, secrets, ports, paths, tools, extensions and schedules."
status: current
---

# Configuration

| What | Where |
|---|---|
| Behavior | `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, code in `src/` |
| Model, providers, MCP servers, starters | `fastagent.config.ts` |
| Where one instance runs | flags and environment variables |
| Secrets | `.secrets/.env`, `.secrets/auth.json` (`fastagent login`), provider variables |

## `fastagent.config.ts`

`fastagent.config.ts` belongs to the agent's author and is committed. It is the same wherever the agent runs; what
differs between deployments comes from the environment, read through [`needs`](#secrets-in-code).

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  thinkingLevel: "high",
  starters: ["Summarize today's issues"],
});
```

Every key is optional. An unknown key refuses the start.

| Key | Default | Meaning |
|---|---|---|
| `model` | none | `provider/modelId` ([model selection](#model-selection)) |
| `thinkingLevel` | the harness's | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `starters` | none | Up to 6 example first messages a client may offer |
| `providers` | `[]` | Model providers beyond the built-ins ([custom models](#custom-models)) |
| `mcpServers` | none | [MCP servers](mcp.md) whose tools the agent gets |

The name and description of the agent come from its `package.json`.

## Model selection

```txt
--model > FASTAGENT_MODEL > model in fastagent.config.ts
```

With none set, a command in a terminal lets you pick one (and sign in), then prints the line to keep in the config.
Without a terminal it fails with `missing model`. `fastagent models [search]` lists the specs. A command that runs the
agent stops at startup when the model it resolves is not in the lists; `openAgent` opens an agent whose configured
default is not, as [embedding](embedding.md) says.

The model lists are refreshed from
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

Read the key through `needs`, never write it into the config: the config ships in the image.

## The system prompt

`SYSTEM.md` is the whole prompt, read for every message. FastAgent appends: the agent's `AGENTS.md`, its skills, where
it works, and (when deployed) what a self-edit changes. Nothing comes from the machine (no `~/.pi/agent`).

Prompt templates (`prompts/<name>.md`) run on a message that is a bare `/<name>`, whoever sends it.

## Auth and secrets

| Source | Use |
|---|---|
| `fastagent login` | Stores credentials in `.secrets/auth.json`; `-g` stores them in `~/.fastagent/.secrets/auth.json` |
| Provider variables | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … for servers and CI |
| `.secrets/.env` | Values for local commands; git-ignored |
| `.secrets/production/.env` | Values for `start` |

A provider's credential comes from the agent's `auth.json`, then the provider's variable, then the global file. A
container never reads your files: give it its values as environment variables. `--env-file <file>` works on `dev`,
`start`, `invoke`, `info` and `schedules run`.

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

A required secret without a value refuses the start, naming the file. `info` lists every declaration. `needs` works around tools, extensions, schedules and providers.

A value that differs between deployments but is not secret (a repository name, a team id) is read the same way:
declare it with `optional: true` and fall back to a default in code.

## Ports and bind address

```txt
port   dev:   --port > 8787                       start: --port > PORT > 8787
bind   dev:   --bind > 127.0.0.1                  start: --bind > all interfaces
```

`--bind` takes an IP or `localhost`. A serve answers the [Agent API](#the-agent-api-over-http) with a key, and
`GET /health`: public, `200 {"status": "ok"}`.

## The Agent API over HTTP

Set `FASTAGENT_API_KEY` (in `.secrets/.env`, or on the host) and a serve answers the [Agent API](agent-api.md#over-http) under
`/v1` to `Authorization: Bearer <key>`. Several keys, comma-separated, let you rotate one. The key opens the whole
instance ([security model](agent-api.md#security)): keep it on a server.

```bash
FASTAGENT_API_KEY=$(openssl rand -hex 32)
```

Call it with `connectAgent(url, { apiKey })` from `@fastagent-sh/client`, or check it with
`fastagent invoke --url <url> "hello"`.

## Where things live

| Path | Holds |
|---|---|
| `.fastagent/dev/`, `.fastagent/start/` | The local instances of `dev` and `start`: working directory and state. Safe to delete `dev/` to start over |
| `<root>/` | The agent's working directory |
| `<root>/.state/` | Storage (`agent.sqlite`) and schedule state. One process at a time |
| `.secrets/` | `.env`, `auth.json`. Never in git or the image |

| Flag | Variable | Default |
|---|---|---|
| `--root <dir>` | `FASTAGENT_ROOT` | `.fastagent/dev` (`start`: `.fastagent/start`) |
| `--name <name>` | `FASTAGENT_NAME` | the package's name |

The container `deploy docker` writes keeps its root at `/data`. On your own server without a container:

```bash
fastagent build
FASTAGENT_ROOT=/data fastagent start
```

## Code: `src/`

| Directory | Each file default-exports |
|---|---|
| `src/tools/` | a tool: `defineTool` from `@earendil-works/pi-durable` |
| `src/extensions/` | an extension: `defineExtension` |
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
  prompt: "Generate today's digest and post it with the post_digest tool.",
});
```

- `cron` has 5 fields; `tz` defaults to UTC; `prompt` is text or `({ at }) => text`.
- Runs at most every 10 minutes; at most 20 schedules.
- Each schedule has one session that every run continues.
- It delivers nothing itself: name the send tool and the target in the prompt.
- Each instant runs at most once. After downtime, one missed run is caught up. A run still going makes the next one
  `skipped`.
- `dev` and `start` run the clock.

`fastagent info` shows the next runs and the last outcome; `fastagent schedules run <name>` runs one now, through the
running `dev` when there is one (`--url` for a deployment).

### Self-scheduling

Every opened instance gives the agent `wake` and `unwake`; only a serve's clock fires the wake-ups:

- `wake({ in: "30m", prompt })` or `wake({ cron: "0 9 * * *", tz?, prompt })` fires back into the same session, and
  survives restarts.
- At most 20 pending per session, at least 10 minutes between recurring runs.
- `unwake({ id })` cancels one; `fastagent schedules unwake <id>` cancels any (`fastagent info` lists them).

## Logging

`FASTAGENT_LOG_LEVEL` is `debug`, `info`, `warn` or `error`. Defaults: `debug` for `dev`, `info` for `start`, which
keeps message content out of the logs.
