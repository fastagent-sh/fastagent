---
title: Overview
description: "The TypeScript runtime for production AI agents: write with Markdown, skills, typed tools, and MCP — package as an npm artifact, embed in Node.js, self-host with Docker, or deploy to any cloud."
status: current
---

# Overview

**The TypeScript runtime for production AI agents.**

FastAgent is an open-source TypeScript & Node.js runtime for embedded, background, and self-hosted AI agents. Write your agent in Markdown (`SYSTEM.md`, `AGENTS.md`, `skills/`), typed TypeScript tools (`defineTool`), and MCP servers — built for both engineers and coding agents. Compile it into a versioned npm package (`fastagent build`), then embed it directly in Next.js, Hono, Express, or Fastify (keeping your own auth and database), self-host it with Docker, or deploy to Fly.io, Railway, and AWS AgentCore behind one Agent API.

## The production problems FastAgent solves

1. **Embed in your existing app without rewriting your stack.** Drop an agent directly into Next.js, Hono, Express, or Fastify with `openAgent()`, or mount its Fetch handler alongside your existing routes. Your application keeps its authentication, user model, and PostgreSQL database—no separate Python service to maintain.
2. **Background runs that survive crashes, disconnects, and retries.** Accepted messages persist before acknowledgment in SQLite, PostgreSQL, or Aurora DSQL with single-writer safety. Long-running tasks resume automatically after deploys or restarts, SSE streams reconnect from the last durable entry (`after`), retried webhooks never double-fire (`Idempotency-Key`), and idle containers scale to zero and wake on demand (`POST /v1/invoke`).
3. **Production security beyond prompt guardrails.** Secrets are declared beside the code that reads them (`needs()`), blocked from leaking into container images (`fastagent deploy check`), and kept out of child shells. Confine execution with tool-only mode (`codingTools: false`), kernel-enforced OS sandboxing (`--harness dsh`), or per-user microVMs on Amazon Bedrock AgentCore, and export OpenTelemetry traces without logging prompt or answer text.
4. **Move from laptop to any infrastructure without changing caller code.** Because every caller—CLI, embedded `openAgent()`, zero-Node-dep HTTP `@fastagent-sh/client`, AWS `@fastagent-sh/client-agentcore`, and interactive Pi TUI `@fastagent-sh/pi-remote`—uses the same [Agent API](agent-api.md), you can move from local SQLite to Docker, Fly.io, Railway, or AWS AgentCore, or swap models and harnesses (`pi-durable` ↔ `dsh`), with zero rewrites.

## How an agent is structured

Each agent lives in a clean standalone directory marked by `fastagent.config.ts`:

```text
my-agent/
├── fastagent.config.ts   # defineAgent({ model, harness, sandbox, codingTools, providers, mcpServers, starters })
├── package.json          # agent name, description, dependencies, and dev/build/start scripts
├── SYSTEM.md             # standing system prompt (re-read on every message)
├── AGENTS.md             # optional project conventions appended to the prompt
├── skills/               # optional Agent Skills (skills/<name>/SKILL.md), callable via /skill:<name>
├── prompts/              # optional prompt templates (prompts/<name>.md), callable via /<name>
├── src/
│   ├── tools/            # optional portable TypeScript tools (defineTool)
│   └── extensions/       # optional pi-durable extensions (defineExtension)
├── .secrets/             # git-ignored local secrets (.env, auth.json) — never shipped in builds or images
└── .fastagent/           # git-ignored local runtime instances (dev/, start/)
```

`fastagent init` scaffolds this directory as a git repository. Edits to prompts, `AGENTS.md`, skills, and templates apply on the next message with no restart. `fastagent build` compiles the agent into `dist/`, an immutable package that `fastagent start`, embedded apps, and containers open directly.

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Agent (Definition)** | The immutable program built from your prompts, skills, tools, providers, and config. |
| **Instance** | One running copy of an agent with its own working directory, secrets, and durable storage (SQLite or PostgreSQL / Aurora DSQL). |
| **Session** | One durable conversation inside an instance. Holds history, settings (`model`, `thinkingLevel`, `instructions`, `tools`), usage, and live execution state. |
| **Conversation** | A caller-chosen name (such as `"pr-fastagent-1140"` or `"incident:inc-415"`) passed to `POST /v1/invoke` or `fastagent invoke --conversation` that automatically maps to and reuses a session. |
| **Message** | One caller submission into a session. Once accepted, it settles to one terminal state (`completed`, `incomplete`, `failed`, or `canceled`) even across restarts. |
| **Entry** | One durable record in a session's history (`user`, `assistant`, `tool_result`, `compaction`). |
| **Tool** | A typed action the model can call—built-in coding tools (`read`, `write`, `edit`, `bash`), custom TypeScript tools (`defineTool`), or [MCP server tools](mcp.md). |
| **Skill** | Reusable instructions under `skills/<name>/SKILL.md` loaded on demand or explicitly via `/skill:<name>`. |
| **Remote** | A saved deployment endpoint in `~/.config/fastagent/remotes.json` (HTTP or a pluggable cloud transport such as AgentCore), shared by the CLI and `@fastagent-sh/pi-remote`. |

## Where FastAgent runs

| Mode | How you use it | Storage |
| --- | --- | --- |
| **Local development** | `fastagent dev`, `fastagent invoke` | Local SQLite under `.fastagent/dev/.state/` |
| **Embedded in your app** | `openAgent(definition, { root, secrets, env })` | Local SQLite or PostgreSQL (dedicated or shared pool via `openPostgresDatabase`) |
| **Self-hosted container** | `fastagent deploy init docker\|compose\|fly\|railway` | Mounted volume at `/data` or `FASTAGENT_DATABASE_URL` (PostgreSQL) |
| **Amazon Bedrock AgentCore** | `npm i @fastagent-sh/agentcore && fastagent deploy init agentcore` | MicroVM per AgentCore session backed by Aurora DSQL + Secrets Manager |

## What FastAgent intentionally leaves to you

| Responsibility | Why it stays outside FastAgent |
| --- | --- |
| **Chat platform connectors** | Slack, Telegram, Discord, and web UIs are external callers of the Agent API, not runtime plugins. |
| **End-user auth & billing** | One API key controls a whole instance. Your application keeps user authentication, tenancy, and routing. |
| **Fixed DAG workflows & cron schedulers** | The agent decides its own tool steps. Drive scheduled or event-driven work externally with single-call `POST /v1/invoke` (GitHub Actions, Cloud Scheduler, EventBridge, webhooks). |
| **Opinionated UI** | Use [`@fastagent-sh/pi-remote`](remotes.md#4-chat-interactively-from-your-terminal-fastagent-shpi-remote) for interactive terminal access, or build any UI over `sessions.events` and `messages.stream`. |

## Current boundaries

- **Single-writer per instance:** One process owns an instance's storage at a time (enforced via SQLite `EXCLUSIVE` locks or PostgreSQL/DSQL leases). Scale horizontally across instances (for example, one instance per user or tenant), not by attaching multiple writers to one instance.
- **Experimental DSH harness:** `@fastagent-sh/harness-dsh` provides full Agent API parity and kernel-enforced OS sandboxing, while pinning a pre-1.0 upstream `@deepseek-ai/dsh` release.

## Next steps

- Browse production [Examples](../examples/README.md) (PR review, AI SRE triage, multi-tenant SaaS copilot, AWS AgentCore, deep research).
- Follow the [Quickstart](quickstart.md) to build and run an agent in five minutes.
- Read [Packaging, Distribution & CI/CD](packaging-and-ci.md) to compile versioned npm packages and gate releases in CI.
- Read [Technical architecture](architecture.md) to see how packages, harnesses, storage, and security boundaries fit together.
- Give the [Agent development guide](ai-start.md) to a coding agent—or follow it yourself—for an end-to-end build and deploy workflow.
