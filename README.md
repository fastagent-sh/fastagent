<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — Take your agent from prototype to durable service. Embed in your app or serve over HTTP behind one Agent API." width="860"></a>
</p>

<h3 align="center">Take your agent from prototype to durable service.</h3>

<p align="center">
  The durable runtime and serving layer that turns your prompts, skills, and TypeScript tools into a live service — embedded in your app or served over HTTP behind one <a href="https://fastagent.sh/docs/agent-api/">Agent API</a>.
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
  <a href="https://fastagent.sh/docs/architecture/">Architecture</a> ·
  <a href="https://fastagent.sh/docs/agent-api/">Agent API</a> ·
  <a href="https://fastagent.sh/docs/">Docs</a> ·
  <a href="https://github.com/fastagent-sh/fastagent/discussions">Discussions</a>
</p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="FastAgent workflow: write your prompt, skills, and tools, run locally with fastagent dev, invoke over the Agent API, and prepare a container with fastagent deploy init." width="860">
</p>

## Why FastAgent

Writing an agent prototype takes minutes. Putting it into production means building durable session storage, crash recovery, resumable SSE streaming, idempotent retries, secret isolation, OS sandboxing, tracing, and container deployments. FastAgent ships that entire backend out of the box—without forcing you into a workflow DSL, a single model vendor, or a proprietary cloud.

| Production need | What FastAgent gives you |
| --- | --- |
| **No lost or duplicate work** | Accepted messages survive crashes, deploys, and scale-to-zero suspends on SQLite, PostgreSQL, or Aurora DSQL with single-writer lease fencing and `Idempotency-Key` deduplication. |
| **One API everywhere** | Identical [Agent API](https://fastagent.sh/docs/agent-api/) in process (`openAgent`), over HTTP (`connectAgent`), on AWS AgentCore (`connectAgentCore`), in the CLI, and in Pi TUI (`@fastagent-sh/pi-remote`). |
| **Scale-to-zero & stateless callers** | Single-call `POST /v1/invoke` with caller-named `conversation` wakes a container, runs up to 600 s (or streams), and suspends cleanly afterward. |
| **Two harnesses, optional OS sandbox** | Built-in `pi-durable` by default, or switch to `@fastagent-sh/harness-dsh` (`--harness dsh`) for kernel-enforced OS sandboxing (`workspace`, `read-only`, `off`) with zero changes to your agent or callers. |
| **Zero-leak secrets & clean ops** | Declare secrets beside code with `needs()`, gate CI with `fastagent deploy check`, log deployed instances into OAuth providers remotely (`fastagent login --remote`), and export zero-content OpenTelemetry traces. |
| **Deploy anywhere** | Generate editable configs for Docker, Compose, Fly.io, Railway, or Amazon Bedrock AgentCore (`fastagent deploy init <target>`), or embed directly inside your Node backend. |

## Quickstart

**With a coding agent** (Claude Code, Codex, Cursor, …), paste:

> Read https://fastagent.sh/start.md and build an agent in this project.

**From your terminal** (Node ≥ 24.15):

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # serve locally with live reload
fastagent invoke "hello"      # send a message through the Agent API
```

Inside an agent directory, the global `fastagent` delegates automatically to that agent's installed version. Without a global install, use `npm run dev` / `build` / `start` or `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is a different package).

Follow the 5-minute [Quickstart](https://fastagent.sh/docs/quickstart/) to add a typed TypeScript tool (`defineTool`) and build for production, or browse runnable [examples](https://github.com/fastagent-sh/fastagent/tree/main/examples) (`basic-agent`, `embed-hono`, `client-invoke`).

## Use it your way

### 1. Embed in your Node backend or desktop app

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

Your app keeps its authentication, database, and routes. See [Embedding](https://fastagent.sh/docs/embedding/).

### 2. Call over HTTP or scale-to-zero (`@fastagent-sh/client`)

Zero Node dependencies—runs on Node, Bun, Deno, and edge workers anywhere `fetch` exists:

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});

const reply = await agent.invoke(
  { conversation: "order:9231", content: "Check refund status" },
  { wait: 120 },
);
console.log(reply.status, reply.answer?.text);
```

### 3. Deploy, sandbox & operate remotely

```bash
# Run with kernel-enforced OS sandboxing (requires @fastagent-sh/harness-dsh)
fastagent dev --harness dsh --sandbox workspace

# Prepare & verify deployment (docker | compose | fly | railway | agentcore)
fastagent deploy init fly && fastagent deploy check

# Save a remote, invoke it, or authenticate model providers remotely
fastagent remote add prod https://agent.example.com --key '$PROD_AGENT_KEY'
fastagent invoke --remote prod --conversation daily-digest "/daily-digest"
fastagent login openai-codex --remote prod
```

## Architecture at a glance

```text
Callers (CLI · openAgent · @fastagent-sh/client · client-agentcore · @fastagent-sh/pi-remote)
                                        │  One Contract: Agent API (/v1)
┌───────────────────────────────────────▼───────────────────────────────────────┐
│ Unified Serving Layer (@fastagent-sh/fastagent)                               │
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
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | Durable runtime (`pi-durable`), unified serving layer, `openAgent`, `defineTool`, `openPostgresDatabase`, HTTP Agent API server, and `fastagent` CLI |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | Zero-Node-dep HTTP Agent API & Auth client (`connectAgent`, `connectAuth`, pluggable `remotes.json` transport protocol) |
| [`@fastagent-sh/client-agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client-agentcore/README.md) | Pure Amazon Bedrock AgentCore client (`connectAgentCore`, `connectAgentCoreAuth`) and `remotes.json` transport plugin (zero server or Node deps) |
| [`@fastagent-sh/agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/agentcore/README.md) | Amazon Bedrock AgentCore server runtime, Aurora DSQL adapter, Secrets Manager integration, CLI extension, and CDK construct |
| [`@fastagent-sh/harness-dsh`](https://github.com/fastagent-sh/fastagent/blob/main/packages/harness-dsh/README.md) | Optional DeepSeek Harness (`@deepseek-ai/dsh`) runtime adapter with kernel-enforced OS sandboxing (`--harness dsh`, experimental) |
| [`@fastagent-sh/pi-remote`](https://github.com/fastagent-sh/fastagent/blob/main/packages/pi-remote/README.md) | Pi TUI extension (`/fa`) for interactive terminal sessions against deployed HTTP or AgentCore instances |

## Documentation

Full documentation lives at **[fastagent.sh/docs](https://fastagent.sh/docs/)**:

- **Start:** [Overview](https://fastagent.sh/docs/overview/) · [Quickstart](https://fastagent.sh/docs/quickstart/) · [Agent development guide](https://fastagent.sh/docs/ai-start/)
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
