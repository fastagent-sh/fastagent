---
title: Remotes & Clients
description: "Operate deployed FastAgent instances: save named HTTP endpoints, invoke and log in remotely from the CLI, and connect from any backend or edge worker."
status: current
---

# Remotes & Clients

Once your agent is deployed—on Docker, Fly.io, Railway, or your own cloud—you need three things: quick CLI access across environments, a way to authenticate model providers remotely without redeploying, and a zero-dependency client for your apps and webhooks.

FastAgent handles all three through `~/.config/fastagent/remotes.json` and the [Agent API](agent-api.md).

## 1. Save your deployments (`fastagent remote`)

`fastagent remote` manages named HTTP endpoints in `~/.config/fastagent/remotes.json` (override with `FASTAGENT_REMOTES_PATH`, or `$XDG_CONFIG_HOME/fastagent/remotes.json`).

```bash
# Save an HTTP deployment (prefer a $ENV_VAR reference over a literal API key)
fastagent remote add prod https://agent.example.com --key '$PROD_AGENT_KEY' --default

# List saved remotes (literal keys are always redacted; $ENV_VAR names are shown)
fastagent remote list
fastagent remote list --json

# Change default or remove a remote
fastagent remote default prod
fastagent remote remove prod
```

Example `~/.config/fastagent/remotes.json`:

```json
{
  "default": "prod",
  "remotes": {
    "prod": {
      "type": "http",
      "url": "https://agent.example.com",
      "apiKey": "$PROD_AGENT_KEY"
    }
  }
}
```

## 2. Invoke & authenticate remotely from the CLI

### Send messages

```bash
# Named remote from remotes.json
fastagent invoke --remote prod "Summarize open incidents"

# Reuse a caller-named conversation (great for recurring jobs)
fastagent invoke --remote prod --conversation daily-digest "/daily-digest"

# Direct URL (reads FASTAGENT_API_KEY from env, or pass --key)
FASTAGENT_API_KEY="$PROD_AGENT_KEY" fastagent invoke --url https://agent.example.com "hello"
```

Pass `--session <id>` to continue a specific session, `--model <provider/modelId>` to override the model for that call, or `--json` for NDJSON event streams.

### Remote model-provider authentication

Deployed instances store provider credentials obtained via `/v1/auth/*` in their durable storage (SQLite on `/data` or PostgreSQL), so OAuth sessions and refreshed tokens survive restarts and scale-to-zero cycles:

```bash
# Interactive OAuth or API-key login on a remote instance
fastagent login openai-codex --remote prod
fastagent login anthropic --url https://agent.example.com

# Non-interactive readiness check (exit 0 ready, 1 not_ready, 2 invalid)
fastagent login openai/gpt-5.5 --check --remote prod --json

# Remove a stored credential from the remote instance
fastagent logout openai-codex --remote prod
```

Keep server authentication and provider authentication distinct:
- **`FASTAGENT_API_KEY`** authenticates **your caller to the FastAgent instance**.
- **`fastagent login --remote`** authenticates **the FastAgent instance to a model provider** (OpenAI, Anthropic, etc.).

## 3. Connect from your application (`@fastagent-sh/client`)

Zero Node dependencies—works anywhere `fetch` runs (Node, Bun, Deno, browsers, edge workers):

```ts
import { connectAgent } from "@fastagent-sh/client";
import { connectAuth } from "@fastagent-sh/client/auth";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.PROD_AGENT_KEY!,
});

const msg = await agent.invoke(
  { conversation: "customer:42", content: "Check my latest invoice" },
  { wait: 120 },
);

const auth = connectAuth("https://agent.example.com", {
  apiKey: process.env.PROD_AGENT_KEY!,
});
const providers = await auth.providers();
```
