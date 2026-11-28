---
title: Overview
description: "The TypeScript runtime for production AI agents: write with Markdown, skills, typed tools, and MCP — package as an npm artifact, embed in Node.js, self-host with Docker, or deploy to any cloud."
status: current
---

# Overview

**The TypeScript runtime for production AI agents.**

FastAgent is an open-source TypeScript & Node.js runtime for embedded, background, and self-hosted AI agents. Write your agent in Markdown (`SYSTEM.md`, `AGENTS.md`, `skills/`), typed TypeScript tools (`defineTool`), and MCP servers — built for both engineers and coding agents. Compile it into a versioned npm package (`fastagent build`), then embed it directly in Next.js, Hono, Express, or Fastify (keeping your own auth and database), self-host it with Docker, or deploy to Fly.io, Railway, and any cloud behind one Agent API.

## The production problems FastAgent solves

1. **Embed in your existing app without rewriting your stack.** Drop an agent directly into Next.js, Hono, Express, or Fastify with `openAgent()`, or mount its Fetch handler alongside your existing routes. Your application keeps its authentication, user model, and PostgreSQL database—no separate Python service to maintain.
2. **Background runs that survive crashes, disconnects, and retries.** Accepted messages persist before acknowledgment in SQLite or PostgreSQL with single-writer safety. Long-running tasks resume automatically after deploys or restarts, SSE streams reconnect from the last durable entry (`after`), retried webhooks never double-fire (`Idempotency-Key`), and idle containers scale to zero and wake on demand (`POST /v1/invoke`).
3. **Production security beyond prompt guardrails.** Secrets are declared beside the code that reads them (`needs()`), blocked from leaking into container images (`fastagent deploy check`), and kept out of child shells. Confine execution with tool-only mode (`codingTools: false`), kernel-enforced OS sandboxing (`--harness dsh`), or isolated containers, and export OpenTelemetry traces without logging prompt or answer text.
4. **Move from laptop to any infrastructure without changing caller code.** Because every caller—CLI, embedded `openAgent()`, and zero-Node-dep HTTP `@fastagent-sh/client`—uses the same [Agent API](agent-api.md), you can move from local SQLite to Docker, Fly.io, Railway, or shared PostgreSQL, or swap models and harnesses (`pi-durable` ↔ `dsh`), with zero rewrites.

## How an agent is structured

Any directory with open-standard `AGENTS.md`, `skills/<name>/SKILL.md`, or `.mcp.json` runs and builds out of the box—or add `fastagent.config.ts` and `src/tools/` when you want typed defaults and custom TypeScript tools:

```text
my-agent/
├── AGENTS.md             # standing instructions / AAIF open-standard prompt (re-read on every message)
├── SYSTEM.md             # optional dedicated system prompt (re-read on every message)
├── .mcp.json             # optional open-standard MCP server declarations (supports ${VAR} secrets)
├── fastagent.config.ts   # optional defineAgent({ model, harness, sandbox, codingTools, providers, mcpServers, starters })
├── package.json          # optional for markdown/MCP-only agents; required when compiling TypeScript in src/tools/
├── skills/               # optional Agent Skills (skills/<name>/SKILL.md), callable via /skill:<name>
├── prompts/              # optional prompt templates (prompts/<name>.md), callable via /<name>
├── src/tools/            # optional 100% harness-portable TypeScript tools (defineTool or Standard JSON Schema v1)
├── .secrets/             # git-ignored local secrets (.env, auth.json) — never shipped in builds or images
└── .fastagent/           # git-ignored local runtime instances (dev/, start/)
```

`fastagent init` scaffolds this directory as a git repository. Edits to prompts, `AGENTS.md`, skills, and templates apply on the next message with no restart. `fastagent build` compiles the agent into `dist/`, an immutable package that `fastagent start`, embedded apps, and containers open directly.

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Agent (Definition)** | The immutable program built from your prompts, skills, tools, providers, and config. |
| **Instance** | One running copy of an agent with its own working directory, secrets, and durable storage (SQLite or PostgreSQL). |
| **Session** | One durable conversation inside an instance. Holds history, settings (`model`, `thinkingLevel`, `instructions`, `tools`), usage, and live execution state. |
| **Conversation** | A caller-chosen name (such as `"pr-fastagent-1140"` or `"incident:inc-415"`) passed to `POST /v1/invoke` or `fastagent invoke --conversation` that automatically maps to and reuses a session. |
| **Message** | One caller submission into a session. Once accepted, it settles to one terminal state (`completed`, `incomplete`, `failed`, or `canceled`) even across restarts. |
| **Entry** | One durable record in a session's history (`user`, `assistant`, `tool_result`, `compaction`). |
| **Tool** | A typed action the model can call—built-in coding tools (`read`, `write`, `edit`, `bash`), custom TypeScript tools (`defineTool`), or [MCP server tools](mcp.md). |
| **Skill** | Reusable instructions under `skills/<name>/SKILL.md` loaded on demand or explicitly via `/skill:<name>`. |
| **Remote** | A saved HTTP deployment endpoint in `~/.config/fastagent/remotes.json` used by `fastagent --remote`. |

## Where FastAgent runs

| Mode | How you use it | Storage |
| --- | --- | --- |
| **Local development** | `fastagent dev`, `fastagent invoke` | Local SQLite under `.fastagent/dev/.state/` |
| **Embedded in your app** | `openAgent(definition, { root, secrets, env })` | Local SQLite or PostgreSQL (dedicated or shared pool via `openPostgresDatabase`) |
| **Self-hosted / cloud container** | `fastagent deploy init docker\|compose\|fly\|railway` | Mounted volume at `/data` or `FASTAGENT_DATABASE_URL` (PostgreSQL) |

### Pick your topology

| Product scenario | Recommended topology | Why it fits |
| --- | --- | --- |
| **B2B SaaS sidebar copilot** (no user `bash`) | Embedded `openAgent()` + shared `openPostgresDatabase()` (`codingTools: false`) | Reuses your auth and Postgres pool with batched lease heartbeats and cooperative idle handoff across replicas |
| **Per-user cloud workspace** (users run `bash` / code) | Ephemeral sandboxed containers (`--harness dsh`) + shared PostgreSQL (`FASTAGENT_DATABASE_URL`) | Kernel-sandboxed per-user isolation with durable session state and single-writer fencing in shared PostgreSQL |
| **Low-frequency background agents** (PR review, AI SRE, daily brief) | Fly.io / Railway sleep-when-idle container + `POST /v1/invoke` + optional `dsh` sandbox | Sleeps to zero between webhooks/crons, deduplicates retries, and confines shell access |
| **Org-wide multi-team agent platform** | Teams publish versioned npm packages (`fastagent build`); platform hosts them in one Node app | Shared runtime via `peerDependencies`, unified auth/tracing, and standard SemVer rollbacks |

## What FastAgent intentionally leaves to you

| Responsibility | Why it stays outside FastAgent |
| --- | --- |
| **Chat platform connectors** | Slack, Telegram, Discord, and web UIs are external callers of the Agent API, not runtime plugins. |
| **End-user auth & billing** | One API key controls a whole instance. Your application keeps user authentication, tenancy, and routing. |
| **Multi-tenant instance cache & routing** | FastAgent is a single-instance data plane: it gives you `openPostgresDatabase()`, coalesced lease renewals, cooperative idle handoff, and `ready()` / `busy()` / `closed` signals, while your host owns tenant secret resolution, sticky routing, active stream tracking, and cache eviction ([Embedding](embedding.md#hosting-multiple-instances-on-one-postgresql-pool)). |
| **Fixed DAG workflows & cron schedulers** | The agent decides its own tool steps. Drive scheduled or event-driven work externally with single-call `POST /v1/invoke` (GitHub Actions, Cloud Scheduler, EventBridge, webhooks). |
| **Opinionated UI** | Build any Web, mobile, or native client over `@fastagent-sh/client` (`sessions.events` and `messages.stream`). |

## Current boundaries

- **Single-writer per instance:** One process owns an instance's storage at a time (enforced via SQLite `EXCLUSIVE` locks or PostgreSQL leases). Scale horizontally across instances (for example, one instance per user or tenant), not by attaching multiple writers to one instance. On PostgreSQL, idle instances cooperatively hand off their leases to waiting replicas during rolling deploys or traffic shifts without interrupting active turns.
- **Experimental DSH harness:** `@fastagent-sh/harness-dsh` provides full Agent API parity and kernel-enforced OS sandboxing, while pinning a pre-1.0 upstream `@deepseek-ai/dsh` release.

## Next steps

- Browse production [Examples](../examples/README.md) (PR review, AI SRE triage, multi-tenant SaaS copilot, deep research).
- Follow the [Quickstart](quickstart.md) to build and run an agent in five minutes.
- Read [Packaging, Distribution & CI/CD](packaging-and-ci.md) to compile versioned npm packages and gate releases in CI.
- Read [Technical architecture](architecture.md) to see how packages, harnesses, storage, and security boundaries fit together.
- Give the [Agent development guide](ai-start.md) to a coding agent—or follow it yourself—for an end-to-end build and deploy workflow.
