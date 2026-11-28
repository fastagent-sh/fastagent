---
title: Remotes & Clients
description: "Operate deployed FastAgent instances: save named endpoints, invoke and log in remotely from the CLI, connect from any backend, and chat interactively from Pi."
status: current
---

# Remotes & Clients

Once your agent is deployed—on Docker, Fly.io, Railway, your own server, or Amazon Bedrock AgentCore—you need three things: quick CLI access across environments, a way to authenticate model providers remotely without redeploying, and lightweight clients for your apps and terminal.

FastAgent handles all three through one shared remotes config (`~/.config/fastagent/remotes.json`) and one Agent API.

## 1. Save your deployments (`fastagent remote`)

The CLI (`--remote`) and [`@fastagent-sh/pi-remote`](#4-chat-interactively-from-your-terminal-fastagent-shpi-remote) share `~/.config/fastagent/remotes.json` (override with `FASTAGENT_REMOTES_PATH`, or `$XDG_CONFIG_HOME/fastagent/remotes.json`).

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

Example `~/.config/fastagent/remotes.json` with both an HTTP deployment and an AWS AgentCore deployment:

```json
{
  "default": "prod",
  "remotes": {
    "prod": {
      "type": "http",
      "url": "https://agent.example.com",
      "apiKey": "$PROD_AGENT_KEY"
    },
    "bedrock": {
      "type": "agentcore",
      "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
      "sessionId": "ops-session-id-at-least-33-characters",
      "qualifier": "prod"
    }
  }
}
```

For cloud transport types (`type: "<name>"`), FastAgent dynamically loads `@fastagent-sh/client-<name>` and connects through it—for example, installing `@fastagent-sh/client-agentcore` enables `type: "agentcore"` across both the CLI and `@fastagent-sh/pi-remote`.

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

Deployed instances store provider credentials obtained via `/v1/auth/*` in their durable storage (SQLite on `/data`, PostgreSQL, or Aurora DSQL), so OAuth sessions and refreshed tokens survive restarts and scale-to-zero cycles:

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
- **`FASTAGENT_API_KEY`** (or AWS IAM on AgentCore) authenticates **your caller to the FastAgent instance**.
- **`fastagent login --remote`** authenticates **the FastAgent instance to a model provider** (OpenAI, Anthropic, etc.).

## 3. Connect from your application

### Over HTTP (`@fastagent-sh/client`)

Zero Node dependencies—works anywhere `fetch` runs (Node, Bun, Deno, edge workers):

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

### Over Amazon Bedrock AgentCore (`@fastagent-sh/client-agentcore`)

Zero server, database, or CDK dependencies:

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";
import { connectAgentCoreAuth } from "@fastagent-sh/client-agentcore/auth";

const connection = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
  sessionId: "user-42-session-id-at-least-33-chars",
};

const agent = connectAgentCore(connection);
const msg = await agent.invoke({ content: "Hello from AgentCore" }, { wait: 120 });

const auth = connectAgentCoreAuth(connection);
const providers = await auth.providers();
```

## 4. Chat interactively from your terminal (`@fastagent-sh/pi-remote`)

`@fastagent-sh/pi-remote` connects your local [Pi](https://pi.dev) TUI directly to any deployed FastAgent instance (HTTP or AgentCore), sharing `~/.config/fastagent/remotes.json`.

```bash
pi install npm:@fastagent-sh/pi-remote
# Or try for a single session:
pi -e npm:@fastagent-sh/pi-remote
```

If you connect to AgentCore remotes (`type: "agentcore"`), install `@fastagent-sh/client-agentcore` alongside it.

- **Connect:** Run `/fa` inside Pi to pick or add a remote, run `/fa <name>` or `/fa https://agent.example.com [apiKey]`, or launch Pi with `pi --fa <name>`.
- **Use native Pi commands while connected:** `/resume`, `/new`, `/name`, `/session`, `/copy`, `/fork`, `/clone`, `/model`, `/thinking`, and `/compact` route directly to the remote instance. Send text and images normally; while running, `Enter` steers, `Alt+Enter` queues, and `Esc` cancels.
- **Manage remotes & sessions:** `/fa off` (return to local Pi), `/fa sessions`, `/fa remotes`, `/fa key [--clear]` (update server API key), `/fa delete`, `/fa status`.
