---
title: Configuration
status: current
---

# Configuration

FastAgent keeps behavior and deployment choices separate:

- agent behavior lives in `AGENTS.md`, `skills/`, and `tools/`,
- deployment choices live in `fastagent.config.*`, CLI flags, and environment variables,
- secrets live in `.env`, provider env vars, or the project-level `<dir>/.fastagent/auth.json`.

## Config file

A workspace may contain exactly one config file:

```txt
fastagent.config.ts
fastagent.config.js
fastagent.config.mjs
```

Example:

```ts
import { defineConfig } from "@kid7st/fastagent";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
});
```

Supported keys:

| Key | Meaning |
|---|---|
| `model` | Default model spec, in `provider/modelId` form. |
| `tools` | Extra programmatic tools appended after default pi tools. Most users should prefer `tools/` discovery. |
| `http.port` | Default port for `dev` / `start`. |

Unknown keys fail at startup. This catches typos such as `modle` instead of silently running zero-config.

## Model selection

Model specs are strings like:

```txt
provider/modelId
```

List available specs:

```bash
fastagent models
fastagent models gpt
```

Precedence:

```txt
CLI --model > FASTAGENT_MODEL > fastagent.config.* model
```

Examples:

```bash
fastagent dev --model openai-codex/gpt-5.5
FASTAGENT_MODEL=openai-codex/gpt-5.5 fastagent start
```

## Auth and secrets

FastAgent resolves model credentials through the model provider layer. Common options:

| Source | Use case |
|---|---|
| `fastagent login` | Stores OAuth/API-key credentials in the project-level `<cwd>/.fastagent/auth.json` (override: `--auth-path` / `FASTAGENT_AUTH_PATH`, a leading `~` is expanded; run from `$HOME` for the global file). |
| Provider env vars | Good for servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Workspace `.env` | Local development secrets loaded by CLI commands. Keep it gitignored. |

Do not commit `.env` or provider credentials.

Run `fastagent info` or `fastagent dev` to see the resolved auth source for the selected provider.

## Ports

Port precedence for `dev`:

```txt
--port > fastagent.config.* http.port > 8787
```

Port precedence for `start`:

```txt
--port > PORT > fastagent.config.* http.port > 8787
```

Use `PORT` in hosted environments that inject a port.

## Sessions

By default, `dev` and `start` persist sessions under:

```txt
<workspace>/.fastagent/sessions
```

For deployments, use durable storage:

```bash
FASTAGENT_SESSIONS_DIR=/data/sessions fastagent start
# or
fastagent start --sessions-dir /data/sessions
```

Precedence:

```txt
--sessions-dir > FASTAGENT_SESSIONS_DIR > <workspace>/.fastagent/sessions
```

A leading `~` in `--sessions-dir` / `FASTAGENT_SESSIONS_DIR` is expanded to your home dir (same as the auth path).

## Tools

There are two ways to add tools:

1. Files under `tools/` — recommended for workspace authors.
2. `config.tools` — programmatic injection for advanced embedding/config use.

`tools/` files are auto-discovered. The filename is the tool name:

```txt
tools/lookup-order.ts  ->  lookup-order
```

`config.tools` are appended after the default pi tools. Discovered `tools/` are appended after those. Name collisions are surfaced as warnings; existing tools win.

## Channels

Channels are not configured in `fastagent.config.*`. A channel needs glue code, so it is always a file under `channels/`.

```txt
channels/github.ts
channels/telegram.ts
```

See [Channels](channels.md).

## What is deliberately not config

The following are library API injection points rather than config keys:

- custom session stores,
- custom execution environments / sandboxes,
- distributed leases,
- custom model providers,
- base prompt overrides.

Use the library API in [Embedding](embedding.md) when you need those ports.
