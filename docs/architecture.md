---
title: Technical Architecture
description: "How FastAgent turns prompts, skills, and tools into a durable, isolated, cloud-neutral service: system layers, single Agent API contract, server-grade harnesses, storage fencing, security boundaries, and packages."
status: current
---

# Technical Architecture

Running an AI agent reliably in production requires solving five hard engineering problems:

1. **Decoupling callers from the runtime** so your app, CLI, and remote clients never break when you change models, harnesses, or hosts.
2. **Preventing lost or duplicated work** across crashes, deploys, client disconnects, and scale-to-zero restarts.
3. **Keeping secrets and host state out of artifacts and agent subprocesses.**
4. **Confining tool execution** when an agent runs shell commands or touches files.
5. **Keeping client bundles light and cloud-agnostic** so edge workers, browsers, and backends never pull in runtime or cloud-vendor SDKs.

FastAgent is architected in clean layers around those five requirements.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Callers & Clients                                                          │
│  fastagent CLI · Your App (openAgent) · @fastagent-sh/client (HTTP/SSE)    │
│  Webhooks / Cron / Edge Workers · Remote Web / Mobile / Native Clients     │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  One Contract: Agent API
                                   │  (In-process / HTTP /v1)
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ Unified Serving Layer (@fastagent-sh/fastagent)                            │
│  Build & Definition · needs() Secrets · Model & Durable Auth Store         │
│  MCP Clients · POST /v1/invoke Conversations · OTLP Tracing · HTTP Server  │
└───────────────────┬────────────────────────────────────┬───────────────────┘
                    │ (lazy)                             │ (optional, lazy)
┌───────────────────▼──────────────────┐ ┌───────────────▼───────────────────┐
│ Harness: pi-durable (default)        │ │ Harness: @fastagent-sh/harness-dsh│
│  Durable loop · Crash recovery       │ │  @deepseek-ai/dsh · OS Sandbox    │
│  SQLite (EXCLUSIVE) / PostgreSQL     │ │  SQLite / PostgreSQL              │
│  (shared fenced leases)              │ │  (shared fenced leases)           │
└──────────────────────────────────────┘ └───────────────────────────────────┘
```

## 1. One contract: the Agent API

Every interaction with a FastAgent instance—in-process embedding, HTTP/SSE, CLI `invoke`, or remote client apps—goes through a single schema-defined contract in `@fastagent-sh/client`:

- **Zero drift between server, client, and docs:** Request/response schemas, SSE frames, error codes, and `GET /v1/openapi.json` all derive from the same Effect Schema definitions.
- **No harness types leak to callers:** Switching models, databases, or harnesses never changes your caller code.
- **End-to-end reliability:** Idempotency keys, resumable entry cursors (`after` / `Last-Event-ID`), explicit terminal states, and single-call `POST /v1/invoke` are first-class parts of the contract.

See [Agent API](agent-api.md) for the full specification.

## 2. Unified serving layer & server-grade harnesses

FastAgent centralizes all platform capabilities in one shared serving layer and delegates only the agent loop, event storage, and optional OS sandbox to the selected `HarnessProvider`:

| Capability | Shared serving layer | Harness-specific |
| --- | --- | --- |
| Prompts (`AGENTS.md`, `SYSTEM.md`), skills, templates, `fastagent.config.ts`, `fastagent build` | ✓ | — |
| Portable tools (`defineTool` / Standard JSON Schema v1), `needs()` secrets, `.mcp.json` & MCP servers | ✓ | — |
| `pi-ai` model providers & layered/durable credentials (`/v1/auth/*`) | ✓ | — |
| Caller-named `POST /v1/invoke` conversation mapping | ✓ | — |
| HTTP server (`/health`, `/v1/*`) & OpenTelemetry OTLP traces | ✓ | — |
| Agent execution loop & session/message event log | — | `pi-durable` or `dsh` |
| Kernel-enforced OS sandbox (`workspace`, `read-only`, `off`) | — | `@fastagent-sh/harness-dsh` |

Because `pi-durable` and `dsh` store their session event logs in separate table namespaces while sharing durable credentials and conversation mappings, you can test or switch harnesses against the same storage without corrupting existing sessions.

## 3. Durability, single-writer fencing & crash recovery

Every accepted message is committed to storage before the caller receives acknowledgment. If the process crashes, restarts, or is recycled by a scale-to-zero platform, the next process resumes unfinished messages automatically (interrupted tool calls are reported rather than blindly re-executed unless explicitly safe).

To prevent split-brain execution (two processes resuming the same session simultaneously), **one process owns an instance's storage at a time**:

- **Local SQLite (default, lazy-loaded):** Instance data lives under `<root>/.state/` (`agent.sqlite`, `credentials.sqlite`, `conversations.sqlite`). `node:sqlite` is loaded lazily only when a SQLite file is opened, in `EXCLUSIVE` locking mode with WAL enabled—a second opener waits briefly for graceful restarts and then fails visibly.
- **Shared PostgreSQL:** When `FASTAGENT_DATABASE_URL` or `openAgent({ database })` is configured, every table is partitioned by instance `name` (required, with no default). An active writer acquires a time-bounded lease and stamps a fencing token into commits; if a process stalls and loses its lease, further commits fail fenced and the instance shuts down cleanly (`agent.closed` resolves) before a successor takes over.
- **Multi-instance connection pooling:** Hosts running many instances in one process open one pool with `openPostgresDatabase()` and pass it to each `openAgent()`. Schema migration runs once, lease renewals coalesce up to 500 instances per query, and closing one instance releases only its lease without closing the shared pool.

## 4. Security & isolation boundaries

FastAgent isolates untrusted inputs, secrets, and runtime state at four distinct boundaries:

1. **Artifact vs. environment:** Built bundles (`dist/`) and container images contain only your agent's definition—never `~/.pi/agent`, `.secrets/`, `.env*`, or `.state/`. Required secrets declared with `needs()` are checked at open; `fastagent deploy check` aborts builds that would leak local secrets or state.
2. **Sanitized subprocess environments:** Shell commands (`bash`), skill scripts, and stdio MCP servers never inherit the host's raw `process.env`. They receive only an explicit base environment (`baseEnv(process.env)` or `openAgent({ env })`), the agent's own `node_modules/.bin` on `PATH`, and declared secrets.
3. **Configurable tool & OS isolation:**
   - **Instance-level trust:** One `FASTAGENT_API_KEY` opens an entire instance. When coding tools (`read`, `write`, `edit`, `bash`) are enabled on `pi-durable`, isolate users who must not see each other into separate containers.
   - **OS sandboxing (`harness: "dsh"`):** Filesystem tools enforce canonical `realpath` confinement to the instance's working directory (or read-only), and `bash` runs inside a kernel sandbox (`sandbox-exec` on macOS, `bwrap`/`Landlock` on Linux, restricted tokens on Windows), failing closed if confinement is unavailable.
   - **Tool-only multi-user embedding:** Set `codingTools: false` in `fastagent.config.ts`, author custom tools that cannot access shared files or storage, and enforce per-user session ownership in your own backend routes.
4. **Accurate scale-to-zero liveness (`agent.busy()`):** Each instance tracks its own unsettled message turns and active remote auth flows so hosting platforms keep active instances alive and safely suspend idle ones.

## 5. Zero-content observability

When `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is configured, FastAgent exports OpenTelemetry traces over OTLP/HTTP JSON for all harnesses:
- Records message admission, loop steps, tool executions, and model calls with token counts, cost, and OpenTelemetry GenAI attributes (`gen_ai.*`).
- Propagates W3C `traceparent` across process restarts so resumed work stays linked to the original trace.
- Never includes prompt text, replies, or tool arguments in trace spans.
- Drops batches with a warning if the collector is unreachable so telemetry outages never slow down or fail agent runs.

## 6. Package map

FastAgent ships as five version-locked npm packages with isolated dependency trees so you install only what your role needs:

| Package | Install when you want to… | Dependency footprint |
| --- | --- | --- |
| [`@fastagent-sh/fastagent`](api-reference.md) | Write, run (`dev`/`start`/`invoke`), package (`build`), or embed an agent in Node/Bun | Cloud runtime, `HarnessProvider` SDK, CLI, HTTP server; zero `@deepseek-ai/*` or cloud SDKs |
| [`@fastagent-sh/client`](api-reference.md) | Call any HTTP FastAgent instance from Node, Bun, Deno, browsers, or edge workers | Depends only on `effect`; zero Node APIs, zero runtime or cloud deps |
| [`@fastagent-sh/harness-dsh`](api-reference.md) | Run an agent with kernel-enforced OS sandboxing (`--harness dsh`) | `@deepseek-ai/dsh` server adapter; lazily loaded by `@fastagent-sh/fastagent` |
| [`@fastagent-sh/agentcore`](api-reference.md) | Serve a compiled agent inside AWS Bedrock AgentCore MicroVMs over PostgreSQL | `@fastagent-sh/client` + `effect`; zero AWS SDK or CDK deps |
| [`@fastagent-sh/client-agentcore`](api-reference.md) | Call an AgentCore-deployed FastAgent over AWS IAM SigV4 | `@fastagent-sh/client` + `@aws-sdk/client-bedrock-agentcore`; zero Node/server deps |

### Runtime compatibility

| Package tier | Packages | Build target | Runtime baseline | Notes |
| --- | --- | --- | --- | --- |
| **Client SDKs** | `@fastagent-sh/client`, `@fastagent-sh/client-agentcore` | ES2024 ESM | Node 22+, Web Baseline browsers, Cloudflare Workers, Vercel Edge, Bun | No `engines` lock, zero Node APIs; public entrypoints return standard `Promise` / `AsyncIterable`. |
| **Server runtime, CLI & adapters** | `@fastagent-sh/fastagent`, `@fastagent-sh/harness-dsh`, `@fastagent-sh/agentcore` | ES2024 ESM | Node ≥ 22.22.0 (Node 24/26 LTS recommended) or Bun ≥ 1.4.4 | `node:sqlite` is loaded lazily only when SQLite storage is opened; PostgreSQL deployments run without loading `node:sqlite`. |
