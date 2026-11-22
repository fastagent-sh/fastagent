---
title: Overview
description: "Take your agent from prototype to durable service: what FastAgent solves, core concepts, where it runs, and what it leaves to your application."
status: current
---

# Overview

**Take your agent from prototype to durable service.**

FastAgent is the durable runtime and serving layer that turns your prompts, skills, and TypeScript tools into a live service—embedded in your app or served over HTTP behind one [Agent API](agent-api.md).

Building an agent prototype takes minutes: a system prompt, a few reusable skills, and typed tools. Taking that agent to production is where engineering time goes—persisting sessions across restarts, recovering cleanly from crashes, resuming dropped streams, preventing duplicate executions on retries, isolating secrets and subprocesses, enforcing OS sandboxing, exporting traces, and deploying to containers or scale-to-zero infrastructure.

FastAgent provides that entire serving layer out of the box without forcing you to rewrite your agent into a proprietary workflow framework or lock into one model provider or cloud.

## What FastAgent gives you

1. **Durable execution out of the box.** Every accepted message is recorded before acknowledgment and settles cleanly even across crashes, deploys, and scale-to-zero suspends. Callers can retry safely with an `Idempotency-Key` and reconnect to live streams from the last durable entry they saw.
2. **One Agent API everywhere.** Whether you run locally via the CLI, embed the agent inside your backend (`openAgent`), call it over HTTP (`@fastagent-sh/client`), invoke microVM-isolated instances on Amazon Bedrock AgentCore (`@fastagent-sh/client-agentcore`), or connect interactively from Pi (`@fastagent-sh/pi-remote`), every caller uses the exact same [Agent API](agent-api.md).
3. **Production isolation & operations.** Secrets are declared next to the code that uses them (`needs()`) and never baked into images; child processes run with sanitized environments; remote model-provider credentials persist across restarts via `/v1/auth/*`; and OpenTelemetry OTLP traces export token/tool telemetry without capturing prompt or answer content.
4. **Harness, model, and cloud neutrality.**
   - **Harnesses:** Run on the built-in `pi-durable` harness by default, or switch to the optional [`@fastagent-sh/harness-dsh`](configuration.md#harness-and-sandbox-selection) harness for kernel-enforced OS sandboxing (`workspace`, `read-only`, or `off`) with no change to your prompt, skills, tools, or callers.
   - **Models:** Use any built-in provider from `pi-ai` or add your own gateway or self-hosted endpoint in code.
   - **Hosts:** Embed in Node, deploy containers to Docker, Compose, Fly.io, Railway, or any host, or run per-user microVMs on Amazon Bedrock AgentCore.
5. **Simple authoring, zero framework lock-in.** Define your agent with plain files (`SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `src/tools/`, `fastagent.config.ts`) and compile it into a standard package with `fastagent build`.

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
│   ├── tools/            # optional harness-neutral TypeScript tools (defineTool)
│   └── extensions/       # optional pi-durable extensions (defineExtension)
├── .secrets/             # git-ignored local secrets (.env, auth.json) — never shipped in builds or images
└── .fastagent/           # git-ignored local runtime instances (dev/, start/)
```

`fastagent init` scaffolds this directory as a git repository. Edits to prompts, `AGENTS.md`, skills, and templates take effect on the next message with no restart. `fastagent build` compiles the agent into `dist/`, an immutable package that `fastagent start`, embedded apps, and containers open directly.

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Agent (Definition)** | The immutable program built from your prompts, skills, tools, providers, and config. |
| **Instance** | One running copy of an agent with its own working directory, secrets, and durable storage (SQLite or PostgreSQL / Aurora DSQL). |
| **Session** | One durable conversation inside an instance. Holds history, settings (`model`, `thinkingLevel`, `instructions`, `tools`), usage, and live execution state. |
| **Conversation** | A caller-chosen name (such as `"daily-digest"` or `"slack:C123:456"`) passed to `POST /v1/invoke` or `fastagent invoke --conversation` that automatically maps to and reuses a session. |
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
| **Fixed DAG workflows & cron schedulers** | The agent decides its own tool steps. Drive scheduled or event-driven work externally with single-call `POST /v1/invoke` (Cloud Scheduler, EventBridge, GitHub Actions, webhooks). |
| **Opinionated UI** | Use [`@fastagent-sh/pi-remote`](remotes.md#4-chat-interactively-from-your-terminal-fastagent-shpi-remote) for interactive terminal access, or build any UI over `sessions.events` and `messages.stream`. |

## Current boundaries

- **Single-writer per instance:** One process owns an instance's storage at a time (enforced via SQLite `EXCLUSIVE` locks or PostgreSQL/DSQL leases). Scale horizontally across instances (for example, one instance per user or team), not by attaching multiple writers to one instance.
- **Experimental DSH harness:** `@fastagent-sh/harness-dsh` provides full Agent API conformance and kernel-enforced OS sandboxing, while pinning a pre-1.0 upstream `@deepseek-ai/dsh` release.

## Next steps

- Read [Technical architecture](architecture.md) to see how packages, harnesses, storage, and security boundaries fit together.
- Follow the [Quickstart](quickstart.md) to build and run an agent in five minutes.
- Give the [Agent development guide](ai-start.md) to a coding agent—or follow it yourself—for an end-to-end build and deploy workflow.
