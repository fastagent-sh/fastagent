---
title: Deploy
description: "Ship your FastAgent to Docker, Docker Compose, Fly.io, Railway, Amazon Bedrock AgentCore, or any container host—with built-in secret leak checks and scale-to-zero support."
status: current
---

# Deploy

Take your agent to production on any container host or serverless runtime. FastAgent scaffolds clean, editable deployment files once and hands execution off to each platform's own CLI—no lock-in, no hidden magic.

## Pick a target

| Target | Best for | Prepare | Deploy |
| --- | --- | --- | --- |
| **Docker / any container host** | Self-hosted VM, Kubernetes, ECS, Cloud Run | `fastagent deploy init docker` | `docker build` / `docker run` |
| **Docker Compose** | Single-server VPS with persistent volume | `fastagent deploy init compose` | `docker compose up -d --build` |
| **Fly.io** | Managed single-machine scale-to-zero HTTP | `fastagent deploy init fly` | `fly launch --copy-config --ha=false --no-deploy` → `fly deploy --ha=false` |
| **Railway** | Simple PaaS with volume & App Sleeping | `fastagent deploy init railway` | `railway init` → `railway volume add --mount-path /data` → `railway up` |
| **Amazon Bedrock AgentCore** | Per-user microVM isolation + Aurora DSQL | `npm i @fastagent-sh/agentcore && fastagent deploy init agentcore` | `npx -y @aws/agentcore@1.0.3 deploy` ([AgentCore](agentcore.md)) |

> **One replica per instance:** A single instance's SQLite volume or PostgreSQL lease is owned by one process at a time. Scale horizontally by running separate instances (or use [AgentCore](agentcore.md) for automatic per-user microVMs).

## Pre-deploy checklist

1. **Test the production build locally:**
   ```bash
   fastagent build
   fastagent start --root "$(mktemp -d)" --env-file prod.env
   ```
2. **Ensure a default model is set** in `fastagent.config.ts` (`model`) or via `FASTAGENT_MODEL` on the host.
3. **Prepare runtime secrets:** `FASTAGENT_API_KEY` (to mount `/v1`), any secrets declared with `needs()`, and either provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) or remote sign-in after deploy via [`fastagent login --remote`](remotes.md#remote-model-provider-authentication).
4. **Gate CI with `fastagent deploy check`:** Verifies that the agent loads cleanly and the build context leaks no local `.secrets/`, `.env*`, or `.state/` files (`exit 0` safe, `exit 1` blocked; supports `--json`):
   ```bash
   fastagent deploy check && fly deploy --ha=false
   ```

## Docker

```bash
fastagent deploy init docker
docker build --pull -t my-agent .
docker run -d --name my-agent --restart unless-stopped \
  -v my-agent-data:/data \
  --env-file prod.env \
  -p 8787:8787 \
  my-agent
```

## Docker Compose

```bash
fastagent deploy init compose
```

Writes `Dockerfile`, `.dockerignore`, and `compose.yml` (mounts `/data`, reads optional `prod.env`, probes `GET /health`). Put runtime secrets in `prod.env` (excluded by `.dockerignore`) and start:

```bash
docker compose up -d --build
```

## Fly.io

Fly.io defaults to two replicas, which would contend for `/data`. `fastagent deploy init fly` writes a `fly.toml` configured for scale-to-zero (`auto_stop_machines = "suspend"`, `min_machines_running = 0`), a `/data` volume mount, and a `GET /health` probe:

```bash
fastagent deploy init fly
fly launch --copy-config --ha=false --no-deploy
fly secrets set FASTAGENT_API_KEY=<key> <MODEL_API_KEY>=<value>
fly deploy --ha=false
```

Because Fly Proxy suspends machines when no HTTP connections are open, keep requests open while turns run (`POST /v1/invoke` with `wait` or `stream: true`, `messages.stream`, or `messages.send` with `wait`), or set `min_machines_running = 1` if you rely on fire-and-forget background turns.

## Railway

```bash
fastagent deploy init railway
```

Writes `Dockerfile` (`EXPOSE 8787`) and `.dockerignore`, and prints the Railway steps:

```bash
railway init
railway volume add --mount-path /data
railway variables --set FASTAGENT_API_KEY=<key> --set <MODEL_API_KEY>=<value>
railway up
```

In Railway service settings, keep **1 replica**, enable **Serverless (App Sleeping)** if you want scale-to-zero, and set the healthcheck path to `/health`.

## Scale-to-zero, scheduled jobs, and webhooks

Drive recurring jobs or event-driven triggers (Cloud Scheduler, EventBridge, GitHub Actions, Railway Cron, webhooks) with a single `POST /v1/invoke` call carrying an `Idempotency-Key`, an optional caller-named `conversation`, and `wait` (up to `600` seconds) or `"stream": true`. The platform wakes the container, holds it awake until the turn settles, and suspends it cleanly afterward:

```bash
curl -s https://<your-host>/v1/invoke \
  -H "Authorization: Bearer $FASTAGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: daily-$(date +%F)" \
  -d '{"conversation": "daily-digest", "content": "/daily-digest", "whenBusy": "reject", "wait": 300}'
```

## Verify & operate your deployment

```bash
# Save as a named remote (shared across CLI and @fastagent-sh/pi-remote)
fastagent remote add prod https://<your-host> --key '$PROD_AGENT_KEY'

# Smoke-test over the Agent API
fastagent invoke --remote prod "hello"

# Optionally sign in to an OAuth provider remotely (stored durably on /data or PostgreSQL)
fastagent login openai-codex --remote prod
```

Rotate `FASTAGENT_API_KEY` with zero downtime by setting `FASTAGENT_API_KEY=new,old`, updating callers, and removing `old`.

## Container details & file ownership

The generated `Dockerfile` installs dependencies, runs `fastagent build`, exposes port `8787`, sets `FASTAGENT_DEPLOYED=1`, `FASTAGENT_NAME=<agent>`, and `FASTAGENT_ROOT=/data`, and runs `fastagent start`. To enable OS sandboxing inside the container, install `@fastagent-sh/harness-dsh` and set `FASTAGENT_HARNESS=dsh` (plus `FASTAGENT_SANDBOX`).

The generated `.dockerignore` excludes `.secrets/`, `.env`, `*.env`, `.state/`, `.fastagent/`, and `node_modules`.

- **Platform configs (`compose.yml`, `fly.toml`, `agentcore/`)** are written once and never overwritten.
- **`Dockerfile` and `.dockerignore`** carry a `# Generated by` marker on line 1. Delete that line to take permanent ownership, or run `fastagent deploy init <target> --force` to regenerate only FastAgent-managed files.

**Persistent volume layout:**

```text
/data/
├── .state/           # SQLite sessions, durable credentials, conversation mappings (unless using PostgreSQL)
└── .deployment/      # single-writer lease and owning agent identity — do not delete
```

To store sessions, durable credentials, and conversation mappings in managed PostgreSQL instead of `/data/.state/`, pass `FASTAGENT_DATABASE_URL` ([Sessions in PostgreSQL](configuration.md#sessions-in-postgresql)).
