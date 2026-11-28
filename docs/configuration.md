---
title: Configuration
description: "Configure your agent's model, custom providers, tools, OS sandboxing, secrets, HTTP API, SQLite or PostgreSQL storage, and OpenTelemetry traces."
status: current
---

# Configuration

FastAgent keeps what you commit with your agent (`fastagent.config.ts`, prompts, skills, tools) cleanly separate from per-environment settings and secrets (environment variables, `.secrets/`, or `openAgent` options).

| What you want to configure | Where it lives |
| --- | --- |
| Prompt, standing rules, skills, prompt templates | `AGENTS.md`, `SYSTEM.md`, `skills/`, `prompts/` |
| Portable TypeScript tools | `src/tools/` |
| MCP tool servers | `.mcp.json` / `mcp.json` or `fastagent.config.ts` (`mcpServers`) |
| Default model, harness, OS sandbox, coding tools, custom providers | `fastagent.config.ts` (optional) |
| Per-environment overrides (port, storage, model, harness, API keys) | CLI flags & `FASTAGENT_*` environment variables |
| Provider logins & secrets | `.secrets/.env`, `.secrets/auth.json`, env vars, or remote `fastagent login --remote` |

## Agent defaults (`fastagent.config.ts`)

Committed in git and shared across every environment. Never hardcode secrets here—use [`needs()`](#declare-secrets-in-code).

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  thinkingLevel: "high",
  harness: "pi-durable",
  codingTools: true,
  starters: ["Summarize today's issues"],
});
```

All fields are optional; unknown keys fail startup immediately.

| Key | Default | What it controls |
| --- | --- | --- |
| `model` | none | Default `provider/modelId` ([Model selection](#model-selection)) |
| `thinkingLevel` | harness default | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `harness` | `"pi-durable"` | Runtime harness: `"pi-durable"` or `"dsh"` (experimental; requires `@fastagent-sh/harness-dsh`) |
| `sandbox` | `"workspace"` (on `dsh`) | OS sandbox mode when `harness: "dsh"`: `"workspace"`, `"read-only"`, or `"off"` |
| `codingTools` | `true` | Built-in `read`, `write`, `edit`, `bash`: `true`, `false`, or an explicit subset such as `["read"]` |
| `maxSteps` | unlimited | Maximum model steps (tool rounds) per message turn before stopping `incomplete` (positive integer; overridable per session) |
| `starters` | none | Up to 6 example first messages exposed in `info().starters` |
| `providers` | `[]` | Custom model providers or gateways (`createProvider`, optionally wrapped in `needs()`) |
| `mcpServers` | none | [MCP tool servers](mcp.md) available to the agent |

The agent's `name` and `description` come from `package.json`.

## Model selection

Precedence (highest first):

```text
--model > FASTAGENT_MODEL > model in fastagent.config.ts
```

Run `fastagent models [search]` to list all built-in and custom `provider/modelId` specs. When no model is set, interactive CLI commands prompt you to pick one and sign in; non-interactive runs fail with `missing model`.

CLI commands stop at startup if the selected model does not exist. In embedded apps, `openAgent()` still opens if a configured default model was retired or renamed (exposing `info().unusableDefault` and refusing messages without an explicit model), while failing immediately if an explicit `openAgent({ model })` override is invalid.

### Custom models & self-hosted gateways

Add a self-hosted endpoint (vLLM, Ollama) or internal gateway with `createProvider` from `@earendil-works/pi-ai`, wrapping credentials in `needs()`:

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
            id: "deepseek-v3",
            name: "DeepSeek V3",
            api: "openai-completions",
            provider: "mygw",
            baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
        api: openAICompletionsApi(),
      }),
    ),
  ],
});
```

Declaring a provider with the same `id` as a built-in provider replaces that built-in.

## Harness and sandbox selection

Precedence (highest first):

```text
--harness > FASTAGENT_HARNESS > harness in fastagent.config.ts > "pi-durable"
--sandbox > FASTAGENT_SANDBOX > sandbox in fastagent.config.ts > "workspace" (on "dsh")
```

| Choice | When to pick it |
| --- | --- |
| **`pi-durable` (default)** | Standard production choice built into `@fastagent-sh/fastagent`. |
| **`dsh` + `sandbox: "workspace"`** | When your agent enables `bash`/file tools and you want kernel-enforced confinement (`sandbox-exec` on macOS, `bwrap`/`Landlock` on Linux, restricted tokens on Windows) limited to the working directory. Fails closed if OS sandboxing is unavailable. |
| **`dsh` + `sandbox: "read-only"`** | When the agent may inspect workspace files and run read-only commands but must not modify files (`write` and `edit` are refused). |
| **`dsh` + `sandbox: "off"`** | Running `dsh` inside an already-isolated container without nested kernel sandboxing. |

Both harnesses share the same SQLite file or PostgreSQL database in disjoint table namespaces (`durable_*` vs `dsh_*`), while sharing durable credentials and conversation mappings. Every agent asset—`AGENTS.md`, `SYSTEM.md`, `skills/`, `prompts/`, `.mcp.json`, `src/tools/`, and `mcpServers`—runs identically on both harnesses.

## Prompts, skills, and templates

- **`SYSTEM.md`:** Re-read on every message. FastAgent appends `AGENTS.md` (when present), skill metadata from `skills/`, workspace instructions (when `codingTools` is enabled), and deployment notes (when deployed). Machine-local files like `~/.pi/agent` are never read.
- **`skills/<name>/SKILL.md`:** Discovered automatically, listed in the system prompt, and invokable directly via `/skill:<name>`.
- **`prompts/<name>.md`:** Prompt templates expanded whenever a message begins with `/<name>`.

## Portable tools (`src/tools/`)

Every file placed directly in `src/tools/` is auto-loaded by default export—nothing to register manually. Test files (`*.test.*`) are ignored; place shared helpers outside `src/tools/` (for example in `lib/`). Rename a file to `<name>.ts.disabled` to turn it off temporarily.

| Directory | Default export | Supported harnesses |
| --- | --- | --- |
| `src/tools/` | `defineTool(...)` from `@fastagent-sh/fastagent` or a `{ name, description, parameters, execute }` object (Standard JSON Schema v1 or JSON Schema), optionally wrapped in `needs()` | All harnesses (`pi-durable` and `dsh`) |

- **Flexible parameter schemas:** `defineTool` accepts Standard JSON Schema v1 (Zod v4, Valibot, ArkType, Effect `Schema.toStandardJSONSchemaV1`) or plain JSON Schema objects (with `as const` type inference).
- **Simple return values:** `execute` can return a plain `string` or a full `ToolExecutionResult` (`{ output, details?, isError? }`).
- **Human-in-the-loop approvals & structured input:** Set `requiresApproval: true` (or `(args) => ({ summary, includeArgs })`) on `defineTool`, or call `await api.requestInput({ prompt, schema })` inside `execute` to durably hibernate the turn (`agent.busy() === false`) across restarts until resolved via `agent.messages.resolve()`.
- **Session id lookup:** Call `await sessionIdOf(api, context)` from `@fastagent-sh/fastagent` to read the active Agent API session id on either harness.
- **Built-in coding tools:** `read`, `write`, `edit`, and `bash` are enabled by default. Set `codingTools: false` for tool-only or multi-user embedded agents (this also omits workspace filesystem guidance from the system prompt), or pass a subset like `codingTools: ["read"]`. Even with `read` disabled, skills remain accessible via `/skill:<name>`.

## Auth and secrets

Provider credentials resolve in this priority order:

1. **Instance durable credentials** — saved via remote `fastagent login --url` / `--remote` or `/v1/auth/*` in `<root>/.state/credentials.sqlite` or PostgreSQL.
2. **Project auth file** — `.secrets/auth.json` (written by local `fastagent login`).
3. **Provider environment variables** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc., from the environment or `.secrets/.env` (`--env-file`).
4. **Global auth file** — `~/.fastagent/.secrets/auth.json` (written by `fastagent login -g` or `fastagent login` outside an agent).

Containers and embedded apps (`openAgent`) never read your local `.secrets/` or `~/.fastagent`: pass secrets explicitly through host environment variables, `openAgent({ secrets })`, or remote `fastagent login --remote`.

### Declare secrets in code

Wrap any tool or provider that reads a secret or per-environment setting in `needs()`:

```ts
import { z } from "zod"; // or plain JSON Schema (`as const`), Effect Schema, Valibot, or ArkType
import { defineTool, needs } from "@fastagent-sh/fastagent";

export default needs(
  ["WEATHER_API_KEY", { name: "WEATHER_UNITS", description: "metric or imperial", optional: true }],
  ({ WEATHER_API_KEY, WEATHER_UNITS }) =>
    defineTool({
      name: "weather",
      description: "Get current weather for a city.",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => await lookupWeather(city, WEATHER_API_KEY, WEATHER_UNITS ?? "metric"),
    }),
);
```

Missing required secrets fail startup immediately and name the file that declared them. Run `fastagent info` to see every secret your agent requires.

## HTTP server & API keys

```text
port   dev:   --port > 8787              start: --port > PORT > 8787
bind   dev:   --bind > 127.0.0.1         start: --bind > 0.0.0.0 (all interfaces)
```

`--bind` accepts an IP literal or `localhost`. Every running server answers `GET /health` (`200 {"status": "ok"}` while ready, `503 {"status": "unavailable"}` once shutting down).

Set `FASTAGENT_API_KEY` (in `.secrets/.env` locally or as a host secret in production) to enable the [Agent API](agent-api.md#http-binding) under `/v1` (`Authorization: Bearer <key>`). Pass comma-separated keys (`FASTAGENT_API_KEY=new,old`) to rotate keys with zero downtime.

```bash
FASTAGENT_API_KEY=$(openssl rand -hex 32)
```

## Storage: SQLite vs PostgreSQL

### Local SQLite (default)

By default each instance stores its state under `<root>/.state/` (`agent.sqlite`, `credentials.sqlite`, `conversations.sqlite`):

| Path / Flag | Env var | Default |
| --- | --- | --- |
| `--root <dir>` | `FASTAGENT_ROOT` | `.fastagent/dev` (`start`: `.fastagent/start`; container: `/data`) |
| `--name <name>` | `FASTAGENT_NAME` | Package name (required with no default when using PostgreSQL) |
| `--env-file <file>` | — | `.secrets/.env` |

`dev` and `start` use separate local instance directories (`.fastagent/dev/` vs `.fastagent/start/`) so testing a production build never touches your dev sessions.

### Sessions in PostgreSQL

Set `FASTAGENT_DATABASE_URL` (or pass `database` to `openAgent`) to keep sessions, durable credentials, and conversation mappings in PostgreSQL instead of SQLite:

```bash
FASTAGENT_DATABASE_URL='postgres://user:password@host:5432/agents?sslmode=require' \
FASTAGENT_NAME=support \
fastagent start
```

- **Explicit name required:** Multiple instances can share one PostgreSQL database keyed by `FASTAGENT_NAME` (`--name` or `openAgent({ name })`). Missing a name exits `2`.
- **Agent ownership:** The first agent package to open a name owns it; another agent opening the same name is refused.
- **Isolate environments:** Use separate databases for dev and production.
- **Single-writer lease fencing:** Only one process owns an instance at a time across hosts. A second opener waits up to 35 s before refusing (naming the holder); a crashed holder releases its lease within 30 s.
- **Automatic schema setup:** Tables are created on first open (`CREATE TABLE` privilege required).
- **Shared connection pools:** Multi-instance apps wrap a database descriptor with `openPostgresDatabase()` ([Embedding](embedding.md#1-open-the-agent)) so all tenants share one pool and coalesce lease renewals.

## Logging & OpenTelemetry traces

Set `FASTAGENT_LOG_LEVEL` to `debug`, `info`, `warn`, or `error` (defaults: `debug` in `dev`, `info` in `start`).

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to export OTLP/HTTP JSON traces for both `pi-durable` and `dsh`. Traces record message admission, turns, tool calls, and model calls with token usage, cost, OpenTelemetry GenAI attributes (`gen_ai.*`), and W3C `traceparent` propagation—without ever exporting prompt text, answers, or tool arguments.

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL (exports to `<base>/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Explicit full traces endpoint (overrides base URL) |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `key=value,...` headers (percent-encoded values) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Must be `http/json` (default) when set |
| `OTEL_SERVICE_NAME` | `service.name` resource attribute (defaults to instance name) |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional `key=value,...` resource attributes |
| `OTEL_SDK_DISABLED=true` | Disable trace export |

CLI commands read `OTEL_*` from the environment or `.secrets/.env`; `openAgent()` reads them from `options.secrets` (keeping collector credentials out of agent subprocesses). Collector outages never block agent runs; dropped batches log a warning.

## Environment variables reference

| Variable | Scope | Purpose |
| --- | --- | --- |
| `FASTAGENT_MODEL` | Runtime / CLI | Default `provider/modelId` override |
| `FASTAGENT_HARNESS` | Runtime / CLI | Harness override (`pi-durable` or `dsh`) |
| `FASTAGENT_SANDBOX` | Runtime / CLI | DSH OS sandbox override (`workspace`, `read-only`, `off`) |
| `FASTAGENT_API_KEY` | Server / CLI | Comma-separated bearer keys enabling `/v1` HTTP routes (also default key for `--url`) |
| `FASTAGENT_ROOT` | Runtime / CLI | Instance root directory (working directory + `.state/`) |
| `FASTAGENT_NAME` | Runtime / CLI | Instance name (required with PostgreSQL and containers) |
| `FASTAGENT_DATABASE_URL` | Runtime / CLI | PostgreSQL connection string for sessions, credentials, and conversations |
| `FASTAGENT_LOG_LEVEL` | Runtime / CLI | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `FASTAGENT_REMOTES_PATH` | CLI | Override path to `remotes.json` (default `~/.config/fastagent/remotes.json`) |
| `FASTAGENT_DEPLOYED` | Container | Set to `1` by generated `Dockerfile` to enforce mounted storage and deployment checks |
