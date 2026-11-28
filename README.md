<p align="center">
  <a href="https://github.com/fastagent-sh/fastagent"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — The TypeScript runtime for production AI agents." width="860"></a>
</p>

<h3 align="center">The TypeScript runtime for production AI agents.</h3>

<p align="center">
  <strong>English</strong> · <a href="https://github.com/fastagent-sh/fastagent/blob/main/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  Write agents in <strong>Markdown (<code>SYSTEM.md</code>, <code>skills/</code>), typed TypeScript tools, and MCP</strong> — built for engineers and coding agents.<br>
  Package as an <strong>npm artifact</strong>, <strong>embed</strong> in Next.js, Hono, Express, or Fastify, <strong>self-host</strong> with Docker, or <strong>deploy</strong> to Fly.io, Railway, and AWS.
</p>

<p align="center">
  <a href="https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml"><img src="https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@fastagent-sh/fastagent"><img src="https://img.shields.io/npm/v/@fastagent-sh/fastagent.svg" alt="npm version"></a>
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@fastagent-sh/fastagent.svg" alt="MIT License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@fastagent-sh/fastagent.svg" alt="Node version"></a>
  <a href="https://github.com/fastagent-sh/fastagent/stargazers"><img src="https://img.shields.io/github/stars/fastagent-sh/fastagent?style=social" alt="GitHub stars"></a>
  <a href="https://x.com/kid7st"><img src="https://img.shields.io/badge/follow-%40kid7st-000?logo=x" alt="follow @kid7st"></a>
</p>

<p align="center">
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/docs/quickstart.md"><strong>Quickstart</strong></a> ·
  <a href="https://github.com/fastagent-sh/fastagent/tree/main/examples">Examples</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/docs/packaging-and-ci.md">Packaging &amp; CI</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/docs/embedding.md">Embed</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/docs/deploy.md">Deploy</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/blob/main/docs/README.md">Docs</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/discussions">Discussions</a>
</p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="FastAgent workflow: write in Markdown and TypeScript, run locally with durable sessions, invoke via CLI or HTTP webhook, and deploy to any host." width="860">
</p>

## Why FastAgent?

Modern teams build with both **engineers and coding agents**. Visual canvases and proprietary graph DSLs break that workflow, while wrapping raw LLM SDKs forces you to build weeks of backend plumbing by hand.

**FastAgent treats an AI agent like normal TypeScript software and ships the production runtime out of the box:**

| Production problem | Built into FastAgent |
| --- | --- |
| Graph DSLs are hard for humans and coding agents to maintain | **Zero DSL:** plain Markdown, typed TypeScript tools, MCP, and a `--json` CLI |
| Prompts and tools have no clean CI gate or rollback path | **Versioned npm packages:** `fastagent build` runs `tsc` and emits `dist/` |
| Deploys, crashes, or browser refreshes drop long runs | **Durable sessions** (SQLite, PostgreSQL) and **resumable SSE** |
| Webhook retries double-run or corrupt active sessions | **Idempotent `POST /v1/invoke`**, per-conversation locking, and live **`steer`** |
| Your app already has authentication and a database | **Native Node.js embedding** (`openAgent()` or Fetch handler) sharing your auth & DB |
| Secrets leak into shells or containers; tools need isolation | **Declared `needs()` secrets**, **`deploy check`**, **OS sandboxing**, and **container isolation** |

## Quickstart

Requires **Node ≥ 22.18** (Node 24/26 LTS recommended) or **Bun ≥ 1.4.4**. Client SDK (`@fastagent-sh/client`) supports Node 22+, modern browsers, edge runtimes, and Bun.

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # local server with hot reload & SQLite persistence
fastagent invoke "hello"      # send a message through the Agent API
```

**Using a coding agent?** Paste this into Claude Code, Codex, Cursor, or Pi:

> Read https://raw.githubusercontent.com/fastagent-sh/fastagent/main/docs/ai-start.md and build an agent in this project.

> **Tip:** Without a global install, run `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is an unrelated package). See the full [Quickstart](https://github.com/fastagent-sh/fastagent/blob/main/docs/quickstart.md).

## Write once in Markdown & TypeScript

Every agent is a standalone Git project with zero framework DSL. Both engineers and coding agents can read, refactor, type-check, and review it with standard tools:

```text
my-agent/
├── fastagent.config.ts   # model, tool permissions, MCP servers, sandbox
├── SYSTEM.md             # system prompt (hot-reloaded in dev)
├── AGENTS.md             # optional operating rules
├── skills/               # reusable Agent Skills (skills/<name>/SKILL.md)
└── src/tools/            # typed TypeScript tools (defineTool + needs())
```

```ts
// fastagent.config.ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "anthropic/claude-sonnet-4-6",
  codingTools: false, // or ["read", "bash"] with sandbox: "read-only"
  mcpServers: {
    sentry: {
      type: "http",
      url: "https://mcp.sentry.example.com/mcp",
      headers: { Authorization: "Bearer ${SENTRY_MCP_TOKEN}" },
    },
  },
});
```

## Build, verify & ship as an npm package

<p align="center">
  <img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/lifecycle.svg" alt="FastAgent software engineering lifecycle: write in Markdown and TypeScript with humans and coding agents, compile into an immutable npm package with CI gates, and run embedded, sleep-when-idle, or on per-user AWS microVMs." width="860">
</p>

`fastagent build` runs `tsc`, verifies tools and MCP commands, warns on hardcoded credentials, and atomically emits an ESM npm package in `dist/` (with `index.js`, `index.d.ts`, a SHA-256 `build.json` fingerprint, and `peerDependencies` so multi-agent hosts share one runtime):

```bash
# In CI (non-interactive, deterministic exit codes 0 / 1 / 2)
npm exec -- fastagent info --json
npm exec -- fastagent build --json          # type-checks and emits immutable dist/ npm package
npm exec -- fastagent deploy check --json   # blocks builds if .secrets/, .env*, or .state/ would leak

# Publish to your private registry (or consume in a monorepo workspace)
npm publish ./dist --access restricted
```

Upgrading or rolling back an agent is a standard SemVer version change (`npm i @acme/saas-copilot@1.4.2`), and platform teams can host multiple teams' compiled npm agent packages inside one Node.js host with unified auth and observability. See [Packaging, Distribution & CI/CD](https://github.com/fastagent-sh/fastagent/blob/main/docs/packaging-and-ci.md).

## Embed, self-host, or call over HTTP

Use the same compiled agent package across every runtime shape with zero code rewrites.

### Embed in your Node.js app (Next.js, Hono, Express, Fastify)

Keep your own authentication, tenancy rules, and PostgreSQL pool:

```ts
import { baseEnv, openAgent, openPostgresDatabase } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot"; // versioned npm package from `fastagent build`

const db = openPostgresDatabase({ url: process.env.DATABASE_URL! }, { max: 20 });

const agent = await openAgent(copilot, {
  root: "/var/lib/myapp/tenants/acme",
  name: "tenant-acme",
  database: db, // share one pool across tenants
  secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  env: baseEnv(process.env),
});

const session = await agent.sessions.create();
for await (const event of agent.messages.stream({ sessionId: session.id, content: "Summarize my usage" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
}
```

### Self-host with Docker or deploy to your cloud

```bash
# Targets: docker | compose | fly | railway
fastagent deploy init fly
fastagent deploy check

# Optional: kernel-enforced OS sandboxing (sandbox-exec / bwrap / Landlock)
fastagent dev --harness dsh --sandbox read-only
```

### Call from webhooks, cron jobs, CI, or edge workers

`@fastagent-sh/client` has zero Node.js dependencies and runs anywhere `fetch` exists:

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});

// Wakes a sleeping container (up to 600s wait), deduplicates retries, and steers if already running
const reply = await agent.invoke(
  {
    conversation: "incident:inc-415",
    idempotencyKey: webhookEventId,
    whenBusy: "steer",
    content: alertSummary,
  },
  { wait: 300 },
);
console.log(reply.status, reply.answer?.text);
```

## Cost & scale

Pick the hosting topology that matches your workload and budget without changing agent or caller code:

| Scale & workload | Typical bottleneck | FastAgent pattern | Quantified architecture impact |
| --- | --- | --- | --- |
| **1–20 background agents**<br>(PR review, AI SRE, daily briefs) | Always-on containers sit idle 95%+ of the day | **Sleep when idle** on Fly.io (`suspend`) or Railway (App Sleeping) woken via `POST /v1/invoke` | **~98% less idle compute** vs 24/7 containers (20 runs/day × 1 min ≈ 10 active hrs/mo vs 720 always-on hrs/mo) |
| **100–1,000+ SaaS tenants**<br>(embedded product copilot) | Per-tenant services, 1,000 DB pools, or lease heartbeats overload Postgres | **Embed in your backend** via `openAgent()` + shared `openPostgresDatabase({ url }, { max: 20 })` (`codingTools: false`) | **0 extra services**; **1 fixed 20-connection pool** with **batched lease renewals (up to 500 tenants/query)** and cooperative idle handoff across replicas |
| **Per-user isolated cloud workspaces**<br>(per-user coding & shell assistants) | Always-on VMs burn compute and lose history on recycle | **Ephemeral sandboxed containers** (`--harness dsh`) + **shared PostgreSQL** (`FASTAGENT_DATABASE_URL`) | **0 always-on idle compute**; containers suspend or recycle cleanly while durable sessions and leases persist in 1 shared PostgreSQL cluster |

<sub>Single-writer fencing guarantees one active owner per instance (default limits: `inFlightPerProcess: 100`, `queuedPerSession: 20`). Scale horizontally across instances with cooperative idle lease handoff across replicas.</sub>

## Production examples

Clone a complete working agent from [`examples/`](https://github.com/fastagent-sh/fastagent/tree/main/examples):

| Example | Runs on | Key capabilities |
| --- | --- | --- |
| [**Multi-Tenant SaaS Copilot**](https://github.com/fastagent-sh/fastagent/tree/main/examples/saas-copilot) | Embedded (Hono + PostgreSQL) | Shared DB pool, `codingTools: false`, resumable SSE |
| [**Sandboxed PR Review Agent**](https://github.com/fastagent-sh/fastagent/tree/main/examples/pr-review-agent) | Self-hosted + GitHub Actions | Read-only OS sandbox, per-PR memory, idempotent retries |
| [**Sleep-When-Idle AI SRE**](https://github.com/fastagent-sh/fastagent/tree/main/examples/incident-triage-agent) | Fly.io + Alert Webhooks | Alert deduplication, mid-run `steer`, MCP servers |
| [**Deep Research & Daily Brief**](https://github.com/fastagent-sh/fastagent/tree/main/examples/deep-research-agent) | Self-hosted + External Cron | Long crash-resilient runs, scheduled `POST /v1/invoke` |

## When to use FastAgent

| Need | Workflow Frameworks | Raw LLM SDKs | Coding CLIs | **FastAgent** |
| --- | --- | --- | --- | --- |
| **How you write it** | Graph DSLs & chains | Custom loop in code | Local terminal | **Markdown, skills, typed TS tools, MCP (zero DSL)** |
| **Packaging & CI** | App-coupled code | App-coupled code | Not packageable | **Compiled npm packages, `tsc`, `--json` CI gates** |
| **Embed in Node.js** | Separate service / glue | Stateless by default | Not embeddable | **Native `openAgent()` + shared Postgres pool** |
| **Scale & isolation** | DIY hosting & sandbox | DIY hosting & sandbox | Local machine | **Docker, sleep-when-idle cloud, shared Postgres, OS sandbox** |

<sub>Compared: Workflow frameworks (LangGraph, CrewAI), Raw LLM SDKs (Vercel AI SDK, OpenAI SDK), Coding CLIs (Claude Code).</sub>

**Not the right fit if you want:**

- A **visual no-code canvas** for non-engineers → use Dify or n8n.
- An **interactive local coding assistant** only on your laptop → use Claude Code, Codex, or Pi.
- A **static deterministic DAG workflow engine** → use Temporal or Inngest.

## Architecture & operations

Every caller speaks one contract: the [Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md). Swap models, storage backends, hosts, or execution harnesses without changing your agent or application code:

```text
Callers (CLI · openAgent · @fastagent-sh/client · Webhooks / Edge / UI Clients)
                                        │  Agent API (/v1)
┌───────────────────────────────────────▼───────────────────────────────────────┐
│ Unified Runtime Layer (@fastagent-sh/fastagent)                               │
│  Build · defineTool · needs() Secrets · Models & Durable Auth · MCP · OTLP    │
└───────────────────┬───────────────────────────────────────┬───────────────────┘
                    │ (lazy)                                │ (optional, lazy)
         ┌──────────▼──────────┐                 ┌──────────▼──────────┐
         │ pi-durable (default)│                 │ @fastagent-sh/      │
         │ SQLite / PostgreSQL │                 │ harness-dsh         │
         │ (fenced leases)     │                 │ + Kernel OS Sandbox │
         └─────────────────────┘                 └─────────────────────┘
```

- **Privacy-safe tracing:** Export cost, token, and tool spans via OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`) without logging prompts or answers.
- **Remote CLI & OAuth:** Manage live instances (`fastagent remote add prod <url>`) and complete provider OAuth remotely (`fastagent login openai-codex --remote prod`).

## Packages & documentation

| Package | Role | Runtime baseline |
| --- | --- | --- |
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | Cloud runtime, `openAgent`, `defineTool`, `openPostgresDatabase`, `HarnessProvider` SDK, HTTP server, CLI | Node ≥ 22.18 (24/26 LTS recommended) or Bun ≥ 1.4.4 |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | Zero-Node-dep HTTP Agent API (`connectAgent`) & remote Auth (`./auth`) client | Node 22+, Browsers, Edge, Bun (ES2024) |
| [`@fastagent-sh/harness-dsh`](https://github.com/fastagent-sh/fastagent/blob/main/packages/harness-dsh/README.md) | Optional DeepSeek Harness (`@deepseek-ai/dsh`) server adapter with kernel OS sandboxing (experimental) | Node ≥ 22.18 (24/26 LTS recommended) or Bun ≥ 1.4.4 |

**Documentation ([docs/](https://github.com/fastagent-sh/fastagent/blob/main/docs/README.md)):**
[Overview](https://github.com/fastagent-sh/fastagent/blob/main/docs/overview.md) · [Quickstart](https://github.com/fastagent-sh/fastagent/blob/main/docs/quickstart.md) · [Packaging & CI](https://github.com/fastagent-sh/fastagent/blob/main/docs/packaging-and-ci.md) · [AI Guide](https://github.com/fastagent-sh/fastagent/blob/main/docs/ai-start.md) · [Architecture](https://github.com/fastagent-sh/fastagent/blob/main/docs/architecture.md) · [Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md) · [Configuration](https://github.com/fastagent-sh/fastagent/blob/main/docs/configuration.md) · [MCP](https://github.com/fastagent-sh/fastagent/blob/main/docs/mcp.md) · [Embedding](https://github.com/fastagent-sh/fastagent/blob/main/docs/embedding.md) · [Deploy](https://github.com/fastagent-sh/fastagent/blob/main/docs/deploy.md) · [Remotes](https://github.com/fastagent-sh/fastagent/blob/main/docs/remotes.md) · [CLI](https://github.com/fastagent-sh/fastagent/blob/main/docs/cli.md) · [API Reference](https://github.com/fastagent-sh/fastagent/blob/main/docs/api-reference.md) · [Troubleshooting](https://github.com/fastagent-sh/fastagent/blob/main/docs/troubleshooting.md)

## Community & status

FastAgent is pre-1.0 with the [Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md) as its stable contract. See [releases](https://github.com/fastagent-sh/fastagent/releases), join [GitHub Discussions](https://github.com/fastagent-sh/fastagent/discussions), or read [Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md), [Code of Conduct](https://github.com/fastagent-sh/fastagent/blob/main/CODE_OF_CONDUCT.md), [Security](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md), and the [MIT license](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE).

> ☁️ **Prefer managed hosting?** FastAgent Cloud adds managed multi-instance durability, sleep-when-idle hosting, and observability while self-hosting stays free. [Join the waitlist →](https://tally.so/r/44DVMB)

<p align="center">
  <sub>Powered by</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="18" /></a>
  <sub>(<code>pi-durable</code> &amp; <code>pi-ai</code>), <a href="https://github.com/Effect-TS/effect">Effect</a>, <a href="https://github.com/nodejs/undici">undici</a>, <a href="https://node-postgres.com">node-postgres</a>, and optional OS sandboxing via <a href="https://github.com/deepseek-ai/deepseek-harness">@deepseek-ai/dsh</a>. Scaffolded <code>writing-great-skills</code> vendored from <a href="https://github.com/mattpocock/skills">mattpocock/skills</a>.</sub>
</p>

<p align="center">
  If FastAgent saves you from building agent infrastructure from scratch, <a href="https://github.com/fastagent-sh/fastagent">give it a ⭐</a>.
</p>
