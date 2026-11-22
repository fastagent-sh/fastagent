<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — Take your agent from prototype to durable service. Embed it in your app or serve it over HTTP behind one Agent API." width="860"></a>
</p>

[![CI](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml/badge.svg)](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@fastagent-sh/fastagent.svg)](https://www.npmjs.com/package/@fastagent-sh/fastagent)
[![license](https://img.shields.io/npm/l/@fastagent-sh/fastagent.svg)](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@fastagent-sh/fastagent.svg)](https://nodejs.org)
[![built with pi](https://img.shields.io/badge/built%20with-pi-0b7285.svg)](https://pi.dev)
[![GitHub stars](https://img.shields.io/github/stars/fastagent-sh/fastagent?style=social)](https://github.com/fastagent-sh/fastagent/stargazers)
[![follow @kid7st](https://img.shields.io/badge/follow-%40kid7st-000?logo=x)](https://x.com/kid7st)

<p align="center">
  <sub>Powered by</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="22" /></a>
  <sub>(<code>pi-durable</code> &amp; <code>pi-ai</code>) with optional OS-sandboxed <code>@fastagent-sh/harness-dsh</code></sub>
</p>

**Take your agent from prototype to durable service.**

FastAgent is the durable runtime and serving layer that turns your prompts, skills, and TypeScript tools into a live service—embedded in your app or served over HTTP behind one [Agent API](https://fastagent.sh/docs/agent-api/). Focus on what your agent does; FastAgent handles durable sessions, crash recovery, resumable streaming, idempotent retries, secret isolation, optional OS sandboxing, and deployment to any container host or AWS AgentCore.

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="FastAgent workflow: write your prompt, skills, and tools, run locally with fastagent dev, invoke over the Agent API, and prepare a container with fastagent deploy init." width="860">
</p>

## Why FastAgent

- **Production backend included:** Durable sessions, crash recovery, idempotent retries, resumable SSE streaming, single-writer fencing on SQLite / PostgreSQL / Aurora DSQL, and scale-to-zero `POST /v1/invoke` out of the box.
- **One Agent API everywhere:** Call your agent the exact same way in process (`openAgent`), over HTTP (`connectAgent`), over AWS AgentCore (`connectAgentCore`), from the CLI (`fastagent invoke`), and in Pi TUI (`@fastagent-sh/pi-remote`).
- **Two harnesses, one contract:** Built-in `pi-durable` by default, or optional `@fastagent-sh/harness-dsh` (`--harness dsh`) for kernel-enforced OS sandboxing (`workspace`, `read-only`, `off`).
- **Simple to author, no framework lock-in:** Keep your agent plain—`SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, and TypeScript tools (`defineTool`)—and compile it with `fastagent build`.
- **Built for real operations:** Manage deployments with `fastagent remote`, authenticate model providers remotely with `fastagent login --remote`, and export OpenTelemetry OTLP traces without leaking prompt content.

## Get started

With a coding agent (Claude Code, Codex, Cursor, …), paste:

> Read https://fastagent.sh/start.md and build an agent in this project.

By hand (Node ≥ 24.15):

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # serve locally, reloading on edits
fastagent invoke "hello"      # send one message through the Agent API
```

Inside an agent directory, the global `fastagent` delegates to the agent's own installed version. Without a global install, use `npm run dev` / `npm run build` / `npm start` or `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is another package on npm).

Prepare for Docker, Compose, Fly.io, Railway, or AWS AgentCore with `fastagent deploy init <target>` and gate CI with `fastagent deploy check`. See the [Quickstart](https://fastagent.sh/docs/quickstart/).

## Embed in your app

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

## Packages

| Package | Role |
| --- | --- |
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | Core durable runtime (`pi-durable`), unified serving layer, `openAgent`, `defineTool`, `openPostgresDatabase`, HTTP Agent API server, and `fastagent` CLI |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | Cloud-agnostic Agent API & Auth client (`connectAgent`, `connectAuth`, `remotes.json` transport protocol, zero Node deps) |
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

## Status

Pre-1.0. The [Agent API](https://fastagent.sh/docs/agent-api/) is the stable center; other surfaces may evolve. See [releases](https://github.com/fastagent-sh/fastagent/releases).

> ☁️ **Prefer managed hosting?** FastAgent Cloud will run your agents with multi-instance durability, scale-to-zero, and observability built in, while self-hosting stays free. [Join the waitlist →](https://tally.so/r/44DVMB)

## Project

[Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md) · [Security policy](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md) · [MIT license](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)

Built on **[pi](https://github.com/earendil-works/pi)** (`pi-durable` and `pi-ai`), with [Effect](https://github.com/Effect-TS/effect), [undici](https://github.com/nodejs/undici), [chokidar](https://github.com/paulmillr/chokidar), [node-postgres](https://node-postgres.com), [@clack/prompts](https://github.com/bombshell-dev/clack), and [ignore](https://github.com/kaelzhang/node-ignore), plus optional OS sandboxing via [@deepseek-ai/dsh](https://github.com/deepseek-ai/deepseek-harness). The scaffolded `writing-great-skills` skill is vendored from [mattpocock/skills](https://github.com/mattpocock/skills), with its license.

If FastAgent saves you from rewriting an agent into another framework, [give it a ⭐](https://github.com/fastagent-sh/fastagent).
