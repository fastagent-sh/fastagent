<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — Take your AI agent from prototype to production without a black-box framework." width="860"></a>
</p>

<h3 align="center">Take your AI agent from prototype to production — without a black-box framework.</h3>

<p align="center">
  Open-source TypeScript &amp; Node.js runtime for embedded, background, and self-hosted AI agents.<br>
  Embed in <strong>Next.js, Hono, Express, or Fastify</strong> keeping your own auth and database — with durable sessions (SQLite, PostgreSQL, Aurora DSQL), idempotent webhooks, MCP tools, OS sandboxing, OpenTelemetry, and scale-to-zero deployment.
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
  <a href="https://fastagent.sh">Website</a> ·
  <a href="https://fastagent.sh/docs/quickstart/">Quickstart</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/tree/main/examples">Examples</a> ·
  <a href="https://fastagent.sh/docs/embedding/">Embed in Your App</a> ·
  <a href="https://fastagent.sh/docs/architecture/">Architecture</a> ·
  <a href="https://fastagent.sh/docs/">Docs</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/discussions">Discussions</a>
</p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="FastAgent workflow: build an agent, run locally with durable sessions, invoke via CLI or HTTP webhook, and deploy to any container host." width="860">
</p>

## What you can build right now

Skip the boilerplate and start from a production-ready example in [`examples/`](https://github.com/fastagent-sh/fastagent/tree/main/examples):

| Example | What it does | Highlights |
| --- | --- | --- |
| [**Sandboxed PR Review Agent**](https://github.com/fastagent-sh/fastagent/tree/main/examples/pr-review-agent) | Background code review triggered by GitHub Actions on every push | Read-only OS sandbox, per-PR conversation memory, idempotent webhook retries |
| [**Scale-to-Zero AI SRE**](https://github.com/fastagent-sh/fastagent/tree/main/examples/incident-triage-agent) | On-call alert triage for Sentry / Datadog / PagerDuty webhooks | Alert-storm deduplication, live steering mid-investigation, SSRF-guarded probe, MCP servers |
| [**Multi-Tenant SaaS Copilot**](https://github.com/fastagent-sh/fastagent/tree/main/examples/saas-copilot) | Embedded product copilot inside a Hono / Node.js backend | Shared PostgreSQL pool across tenants, tool-only mode (`codingTools: false`), resumable SSE |
| [**Per-User AWS AgentCore MicroVM**](https://github.com/fastagent-sh/fastagent/tree/main/examples/agentcore-per-user) | Dedicated microVM-isolated assistant for every end user on AWS | Amazon Bedrock AgentCore + Aurora DSQL + Secrets Manager + IAM-signed client |
| [**Deep Research & Daily Brief**](https://github.com/fastagent-sh/fastagent/tree/main/examples/deep-research-agent) | Long-running technical research & scheduled cron brief | Live Hacker News & GitHub Releases tools, crash-resilient runs, live terminal attach via Pi |

## The production problems FastAgent solves

Building an agent demo takes an afternoon. Running it reliably for real users takes weeks of unglamorous backend plumbing. FastAgent gives you that production layer without locking you into a black-box workflow framework:

- **Embed in Next.js, Hono, Express, or Fastify — keep your auth & database.** Drop an agent directly into your existing Node.js backend with `openAgent()`, or mount its Fetch handler on your existing server. No separate Python microservice, no rewriting your user model or permissions.
- **Never lose a run — or run it twice.** Deploys, process crashes, browser refreshes, and retried webhooks won't drop in-flight work or duplicate side effects. Sessions persist in SQLite, PostgreSQL, or Aurora DSQL; SSE streams pick up where they left off; idle containers scale to zero and wake on demand.
- **Real production security, not prompt-only guardrails.** Secrets are declared beside the code that needs them (`needs()`), blocked from leaking into Docker images (`fastagent deploy check`), and kept out of child shells. Lock down execution with tool-only mode (`codingTools: false`), kernel-enforced OS sandboxing (`--harness dsh`), or per-user microVMs on AWS AgentCore.
- **Plain Markdown & TypeScript — zero lock-in.** Author prompts (`SYSTEM.md`, `AGENTS.md`), reusable Agent Skills (`skills/`), strict Zod / JSON-Schema tools (`defineTool`), and MCP servers (`mcpServers`) in git. Move from your laptop to Docker, Fly.io, Railway, or AWS AgentCore—or swap models and runtimes—without rewriting your agent or callers.

## Quickstart

**With a coding agent** (Claude Code, Codex, Cursor, …), paste:

> Read https://fastagent.sh/start.md and build an agent in this project.

**From your terminal** (Node ≥ 24.15):

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # serve locally with live reload
fastagent invoke "hello"      # send a message
```

Inside an agent directory, the global `fastagent` delegates automatically to that agent's installed version. Without a global install, use `npm run dev` / `build` / `start` or `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is an unrelated npm package). See the 5-minute [Quickstart](https://fastagent.sh/docs/quickstart/).

## Use it your way

### 1. Embed inside your Node.js app (Next.js, Hono, Express, Fastify)

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import support from "@acme/support-agent"; // built with `fastagent build`

const agent = await openAgent(support, {
  root: "/var/lib/myapp/support",
  secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  env: baseEnv(process.env),
  model: "openai/gpt-5.5",
});

const session = await agent.sessions.create();
for await (const event of agent.messages.stream({ sessionId: session.id, content: "hi" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
}
```

Share a single PostgreSQL pool across multi-tenant instances with `openPostgresDatabase()`, or mount `service.fetch` on your existing HTTP server. See [Embedding](https://fastagent.sh/docs/embedding/).

### 2. Trigger from webhooks, cron jobs, or edge workers (`@fastagent-sh/client`)

Zero Node dependencies — runs in Node, Bun, Deno, and edge workers anywhere `fetch` exists:

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});

// Single idempotent call: wakes a scale-to-zero container, reuses the conversation, and settles cleanly
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

### 3. Sandbox, deploy & operate live instances

```bash
# Run with kernel-enforced OS sandboxing (sandbox-exec / bwrap / Landlock via @fastagent-sh/harness-dsh)
fastagent dev --harness dsh --sandbox read-only

# Prepare & verify deployment (docker | compose | fly | railway | agentcore)
fastagent deploy init fly && fastagent deploy check

# Manage deployments, invoke remotely, or authenticate OAuth providers remotely
fastagent remote add prod https://agent.example.com --key '$PROD_AGENT_KEY'
fastagent invoke --remote prod --conversation daily-brief "/daily-brief"
fastagent login openai-codex --remote prod
```

Export cost, token, and tool traces to any OpenTelemetry collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) without logging prompts or answers, or attach live to running remote sessions from your terminal with [`@fastagent-sh/pi-remote`](https://fastagent.sh/docs/remotes/).

## When to use FastAgent

| Need | Graph / Workflow Frameworks (LangGraph, CrewAI) | Terminal Coding CLIs (Claude Code) | FastAgent |
| --- | --- | --- | --- |
| **Authoring style** | Graph DSLs, nodes, edges, chains | Interactive local terminal | Plain Markdown (`SYSTEM.md`, `skills/`) + typed TypeScript tools & MCP |
| **Embed in Next.js / Hono / Express** | Custom wrapper / separate Python service | Not designed for multi-tenant embedding | Native `openAgent()` + Fetch handler, keeping your auth & database |
| **Durable background & webhook runs** | Requires separate queue/worker plumbing | Local interactive session | Built-in SQLite / PostgreSQL / Aurora DSQL persistence, idempotency & scale-to-zero |
| **Isolation & deployment** | Bring your own sandbox & hosting | Local machine permissions | `codingTools: false`, kernel OS sandbox (`dsh`), Docker/Fly/Railway, or AWS AgentCore microVMs |
| **Best when** | You want visual or rigid multi-agent DAG orchestration | You are coding interactively at your own laptop | You want to ship headless, background, or embedded AI agents to production |

## How it works

Under the hood, every caller (CLI, embedded `openAgent()`, HTTP `@fastagent-sh/client`, AWS `@fastagent-sh/client-agentcore`, and Pi TUI `@fastagent-sh/pi-remote`) talks through one contract—the [Agent API](https://fastagent.sh/docs/agent-api/). That keeps your agent and application code decoupled from storage, hosting, and runtime harnesses:

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

Read the full [Technical architecture](https://fastagent.sh/docs/architecture/).

## Packages

| Package | Role |
| --- | --- |
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | Durable runtime (`pi-durable`), `openAgent`, `defineTool`, `openPostgresDatabase`, HTTP Agent API server, and `fastagent` CLI |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | Zero-Node-dep HTTP Agent API & Auth client (`connectAgent`, `connectAuth`, pluggable `remotes.json` transport protocol) |
| [`@fastagent-sh/client-agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client-agentcore/README.md) | Pure Amazon Bedrock AgentCore client (`connectAgentCore`, `connectAgentCoreAuth`) and `remotes.json` transport plugin (zero server or Node deps) |
| [`@fastagent-sh/agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/agentcore/README.md) | Amazon Bedrock AgentCore server runtime, Aurora DSQL adapter, Secrets Manager integration, CLI extension, and CDK construct |
| [`@fastagent-sh/harness-dsh`](https://github.com/fastagent-sh/fastagent/blob/main/packages/harness-dsh/README.md) | Optional DeepSeek Harness (`@deepseek-ai/dsh`) runtime adapter with kernel-enforced OS sandboxing (`--harness dsh`, experimental) |
| [`@fastagent-sh/pi-remote`](https://github.com/fastagent-sh/fastagent/blob/main/packages/pi-remote/README.md) | Pi TUI extension (`/fa`) for connecting interactively to deployed HTTP or AgentCore instances |

## Documentation

Full documentation lives at **[fastagent.sh/docs](https://fastagent.sh/docs/)**:

- **Start:** [Overview](https://fastagent.sh/docs/overview/) · [Quickstart](https://fastagent.sh/docs/quickstart/) · [Examples](https://github.com/fastagent-sh/fastagent/tree/main/examples) · [Agent development guide](https://fastagent.sh/docs/ai-start/)
- **Architecture & contract:** [Technical architecture](https://fastagent.sh/docs/architecture/) · [Agent API](https://fastagent.sh/docs/agent-api/)
- **Build & operate:** [Configuration](https://fastagent.sh/docs/configuration/) · [MCP servers](https://fastagent.sh/docs/mcp/) · [Remotes & clients](https://fastagent.sh/docs/remotes/) · [CLI reference](https://fastagent.sh/docs/cli/)
- **Embed & deploy:** [Embedding](https://fastagent.sh/docs/embedding/) · [Deploy](https://fastagent.sh/docs/deploy/) · [AgentCore](https://fastagent.sh/docs/agentcore/) · [API reference](https://fastagent.sh/docs/api-reference/)

## Community & status

FastAgent is pre-1.0. The [Agent API](https://fastagent.sh/docs/agent-api/) is the stable center; see [releases](https://github.com/fastagent-sh/fastagent/releases) for updates.

- **Questions, ideas & show-and-tell:** [GitHub Discussions](https://github.com/fastagent-sh/fastagent/discussions)
- **Contribute:** [Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md) · [Code of Conduct](https://github.com/fastagent-sh/fastagent/blob/main/CODE_OF_CONDUCT.md) · [Security policy](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md) · [MIT license](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)

> ☁️ **Prefer managed hosting?** FastAgent Cloud will run your agents with multi-instance durability, scale-to-zero, and observability built in, while self-hosting stays free. [Join the waitlist →](https://tally.so/r/44DVMB)

<p align="center">
  <sub>Powered by</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="18" /></a>
  <sub>(<code>pi-durable</code> &amp; <code>pi-ai</code>), with <a href="https://github.com/Effect-TS/effect">Effect</a>, <a href="https://github.com/nodejs/undici">undici</a>, <a href="https://node-postgres.com">node-postgres</a>, and optional OS sandboxing via <a href="https://github.com/deepseek-ai/deepseek-harness">@deepseek-ai/dsh</a>. Scaffolded <code>writing-great-skills</code> vendored from <a href="https://github.com/mattpocock/skills">mattpocock/skills</a>.</sub>
</p>

<p align="center">
  If FastAgent saves you from building agent serving infrastructure from scratch, <a href="https://github.com/fastagent-sh/fastagent">give it a ⭐</a>.
</p>
