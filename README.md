<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — The TypeScript runtime for production AI agents." width="860"></a>
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
  <a href="https://fastagent.sh/docs/quickstart/"><strong>Quickstart</strong></a> ·
  <a href="https://github.com/fastagent-sh/fastagent/tree/main/examples">Examples</a> ·
  <a href="https://fastagent.sh/docs/packaging-and-ci/">Packaging &amp; CI</a> ·
  <a href="https://fastagent.sh/docs/embedding/">Embed</a> ·
  <a href="https://fastagent.sh/docs/deploy/">Deploy</a> ·
  <a href="https://fastagent.sh/docs/">Docs</a> ·
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
| Deploys, crashes, or browser refreshes drop long runs | **Durable sessions** (SQLite, PostgreSQL, Aurora DSQL) and **resumable SSE** |
| Webhook retries double-run or corrupt active sessions | **Idempotent `POST /v1/invoke`**, per-conversation locking, and live **`steer`** |
| Your app already has authentication and a database | **Native Node.js embedding** (`openAgent()` or Fetch handler) sharing your auth & DB |
| Secrets leak into shells or containers; tools need isolation | **Declared `needs()` secrets**, **`deploy check`**, **OS sandboxing**, and **AWS microVMs** |

## Quickstart

Requires **Node ≥ 24.15** (Node 26 LTS recommended). Client SDKs (`@fastagent-sh/client`, `@fastagent-sh/client-agentcore`) support Node 22+, modern browsers, edge runtimes, and Bun.

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # local server with hot reload & SQLite persistence
fastagent invoke "hello"      # send a message through the Agent API
```

**Using a coding agent?** Paste this into Claude Code, Codex, Cursor, or Pi:

> Read https://fastagent.sh/start.md and build an agent in this project.

> **Tip:** Without a global install, run `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is an unrelated package). See the full [Quickstart](https://fastagent.sh/docs/quickstart/).

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

Upgrading or rolling back an agent is a standard SemVer version change (`npm i @acme/saas-copilot@1.4.2`). See [Packaging, Distribution & CI/CD](https://fastagent.sh/docs/packaging-and-ci/).

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
# Targets: docker | compose | fly | railway | agentcore
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
| **100–1,000+ SaaS tenants**<br>(embedded product copilot) | Per-tenant services or 1,000 DB pools exhaust Postgres connections | **Embed in your backend** via `openAgent()` + shared `openPostgresDatabase({ url }, { max: 20 })` (`codingTools: false`) | **0 extra services**; **1 fixed 20-connection Postgres pool** serves 1,000 name-partitioned tenants with 1 schema migration |
| **100–10,000+ isolated users**<br>(per-user sandboxed assistants) | Operating hundreds of always-on VMs and idle costs | **Per-user AWS MicroVMs** on Bedrock AgentCore + serverless Aurora DSQL | **0 always-on servers**; on-demand microVMs recycle when idle and resume cleanly from DSQL |

<sub>Single-writer fencing guarantees one active owner per instance (default limits: `inFlightPerProcess: 100`, `queuedPerSession: 20`). Scale horizontally across instances or automatically per user on AgentCore.</sub>

## Production examples

Clone a complete working agent from [`examples/`](https://github.com/fastagent-sh/fastagent/tree/main/examples):

| Example | Runs on | Key capabilities |
| --- | --- | --- |
| [**Multi-Tenant SaaS Copilot**](https://github.com/fastagent-sh/fastagent/tree/main/examples/saas-copilot) | Embedded (Hono + PostgreSQL) | Shared DB pool, `codingTools: false`, resumable SSE |
| [**Sandboxed PR Review Agent**](https://github.com/fastagent-sh/fastagent/tree/main/examples/pr-review-agent) | Self-hosted + GitHub Actions | Read-only OS sandbox, per-PR memory, idempotent retries |
| [**Sleep-When-Idle AI SRE**](https://github.com/fastagent-sh/fastagent/tree/main/examples/incident-triage-agent) | Fly.io + Alert Webhooks | Alert deduplication, mid-run `steer`, MCP servers |
| [**Deep Research & Daily Brief**](https://github.com/fastagent-sh/fastagent/tree/main/examples/deep-research-agent) | Self-hosted + External Cron | Long crash-resilient runs, live terminal attach via Pi |
| [**Per-User AWS MicroVM Agent**](https://github.com/fastagent-sh/fastagent/tree/main/examples/agentcore-per-user) | AWS Bedrock AgentCore | Per-user microVM, Aurora DSQL, Secrets Manager, IAM auth |

## When to use FastAgent

| Need | Workflow Frameworks | Raw LLM SDKs | Coding CLIs | **FastAgent** |
| --- | --- | --- | --- | --- |
| **How you write it** | Graph DSLs & chains | Custom loop in code | Local terminal | **Markdown, skills, typed TS tools, MCP (zero DSL)** |
| **Packaging & CI** | App-coupled code | App-coupled code | Not packageable | **Compiled npm packages, `tsc`, `--json` CI gates** |
| **Embed in Node.js** | Separate service / glue | Stateless by default | Not embeddable | **Native `openAgent()` + shared Postgres pool** |
| **Scale & isolation** | DIY hosting & sandbox | DIY hosting & sandbox | Local machine | **Docker, sleep-when-idle cloud, AWS microVMs, OS sandbox** |

<sub>Compared: Workflow frameworks (LangGraph, CrewAI), Raw LLM SDKs (Vercel AI SDK, OpenAI SDK), Coding CLIs (Claude Code).</sub>

**Not the right fit if you want:**

- A **visual no-code canvas** for non-engineers → use Dify or n8n.
- An **interactive local coding assistant** only on your laptop → use Claude Code, Codex, or Pi.
- A **static deterministic DAG workflow engine** → use Temporal or Inngest.

## Architecture & operations

Every caller speaks one contract: the [Agent API](https://fastagent.sh/docs/agent-api/). Swap models, storage backends, hosts, or execution harnesses without changing your agent or application code:

```text
Callers (CLI · openAgent · @fastagent-sh/client · client-agentcore · @fastagent-sh/pi-remote)
                                        │  Agent API (/v1)
┌───────────────────────────────────────▼───────────────────────────────────────┐
│ Unified Runtime Layer (@fastagent-sh/fastagent)                               │
│  Build · defineTool · needs() Secrets · Models & Durable Auth · MCP · OTLP    │
└───────────────────┬───────────────────────────────────────┬───────────────────┘
                    │                                       │ (optional, lazy)
         ┌──────────▼──────────┐                 ┌──────────▼──────────┐
         │ pi-durable (default)│                 │ @fastagent-sh/      │
         │ SQLite / PostgreSQL │                 │ harness-dsh         │
         │ / Aurora DSQL       │                 │ + Kernel OS Sandbox │
         └─────────────────────┘                 └─────────────────────┘
```

- **Privacy-safe tracing:** Export cost, token, and tool spans via OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`) without logging prompts or answers.
- **Remote CLI & OAuth:** Manage live instances (`fastagent remote add prod <url>`) and complete provider OAuth remotely (`fastagent login openai-codex --remote prod`).
- **Live terminal attach:** Inspect or steer running remote sessions from your terminal with [`@fastagent-sh/pi-remote`](https://fastagent.sh/docs/remotes/).

## Packages & documentation

| Package | Role | Runtime baseline |
| --- | --- | --- |
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | Core runtime (`pi-durable`), `openAgent`, `defineTool`, `openPostgresDatabase`, HTTP server, CLI | Node ≥ 24.15 (26 LTS recommended) |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | Zero-Node-dep HTTP Agent API & Auth client (`connectAgent`, `connectAuth`) | Node 22+, Browsers, Edge, Bun (ES2024) |
| [`@fastagent-sh/client-agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client-agentcore/README.md) | Zero-Node-dep Amazon Bedrock AgentCore client (`connectAgentCore`, `connectAgentCoreAuth`) | Node 22+, Browsers, Edge, Bun (ES2024) |
| [`@fastagent-sh/agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/agentcore/README.md) | AWS AgentCore server runtime, Aurora DSQL adapter, Secrets Manager, CDK construct | Node ≥ 24.15 (26 LTS recommended) |
| [`@fastagent-sh/harness-dsh`](https://github.com/fastagent-sh/fastagent/blob/main/packages/harness-dsh/README.md) | Optional DeepSeek Harness (`@deepseek-ai/dsh`) adapter with kernel OS sandboxing (experimental) | Node ≥ 24.15 (26 LTS recommended) |
| [`@fastagent-sh/pi-remote`](https://github.com/fastagent-sh/fastagent/blob/main/packages/pi-remote/README.md) | Pi TUI extension (`/fa`) for live terminal access to deployed HTTP or AgentCore instances | Node ≥ 24.15 (26 LTS recommended) |

**Docs at [fastagent.sh/docs](https://fastagent.sh/docs/):**
[Overview](https://fastagent.sh/docs/overview/) · [Quickstart](https://fastagent.sh/docs/quickstart/) · [Packaging & CI](https://fastagent.sh/docs/packaging-and-ci/) · [AI Guide](https://fastagent.sh/docs/ai-start/) · [Architecture](https://fastagent.sh/docs/architecture/) · [Agent API](https://fastagent.sh/docs/agent-api/) · [Configuration](https://fastagent.sh/docs/configuration/) · [MCP](https://fastagent.sh/docs/mcp/) · [Embedding](https://fastagent.sh/docs/embedding/) · [Deploy](https://fastagent.sh/docs/deploy/) · [AgentCore](https://fastagent.sh/docs/agentcore/) · [Remotes](https://fastagent.sh/docs/remotes/) · [CLI](https://fastagent.sh/docs/cli/) · [API Reference](https://fastagent.sh/docs/api-reference/)

## Community & status

FastAgent is pre-1.0 with the [Agent API](https://fastagent.sh/docs/agent-api/) as its stable contract. See [releases](https://github.com/fastagent-sh/fastagent/releases), join [GitHub Discussions](https://github.com/fastagent-sh/fastagent/discussions), or read [Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md), [Code of Conduct](https://github.com/fastagent-sh/fastagent/blob/main/CODE_OF_CONDUCT.md), [Security](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md), and the [MIT license](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE).

> ☁️ **Prefer managed hosting?** FastAgent Cloud adds managed multi-instance durability, sleep-when-idle hosting, and observability while self-hosting stays free. [Join the waitlist →](https://tally.so/r/44DVMB)

<p align="center">
  <sub>Powered by</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="18" /></a>
  <sub>(<code>pi-durable</code> &amp; <code>pi-ai</code>), <a href="https://github.com/Effect-TS/effect">Effect</a>, <a href="https://github.com/nodejs/undici">undici</a>, <a href="https://node-postgres.com">node-postgres</a>, and optional OS sandboxing via <a href="https://github.com/deepseek-ai/deepseek-harness">@deepseek-ai/dsh</a>. Scaffolded <code>writing-great-skills</code> vendored from <a href="https://github.com/mattpocock/skills">mattpocock/skills</a>.</sub>
</p>

<p align="center">
  If FastAgent saves you from building agent infrastructure from scratch, <a href="https://github.com/fastagent-sh/fastagent">give it a ⭐</a>.
</p>
