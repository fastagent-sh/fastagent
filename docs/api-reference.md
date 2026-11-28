---
title: API Reference
description: "Which FastAgent npm package to install for your role, its public TypeScript entry points, and where to read the full guides."
status: current
---

# API Reference

FastAgent publishes three version-locked npm packages so you install only what your role needs. Every package ships full TypeScript declarations (`dist/*.d.ts`) for inline editor documentation.

## Building or embedding an agent

| Package | When to install | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/fastagent`** | Writing an agent, packaging it, running the CLI, or embedding in Node/Bun | `defineAgent`, `defineTool`, `needs`, `sessionIdOf`, `openAgent`, `openPostgresDatabase`, `baseEnv`, `AgentError`, `LIMITS`, `hasEnded`, `McpError`, plus all core Agent API types (`Agent`, `LocalAgent`, `RemoteAgent`, `Session`, `Message`, `Entry`, `InvokeRequest`, …) |
| **`@fastagent-sh/harness-dsh`** | Opting into kernel-enforced OS sandboxing (`--harness dsh`, experimental; loaded lazily by `@fastagent-sh/fastagent`) | `openDshAgent`, `MemoryDshEventStore`, `openSqliteDshStore` |

## Calling or operating a deployed agent

| Package / entry | When to install | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/client`** | Calling any HTTP FastAgent from Node, Bun, Deno, browsers, or edge workers (zero Node deps) | `connectAgent`, `ConnectOptions`, `AgentError`, `LIMITS`, `hasEnded`, and all core Agent API types |
| **`@fastagent-sh/client/auth`** | Remote OAuth / API-key provider login over HTTP (zero Node deps) | `connectAuth`, `ConnectOptions`, `AuthApi`, `AuthFlowState`, `AuthProviderStatus`, `StartAuthLoginRequest`, `AuthLoginInput` |

## Extending FastAgent (harness & protocol authors)

| Entry point | Purpose | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/fastagent/harness`** | Building pluggable server-grade runtime harness adapters (`@fastagent-sh/harness-<name>/provider`) | `HarnessProvider`, `HarnessStorageOpenContext`, `HarnessAgentOpenContext`, `adaptToolRejectingPark`, `retainToolOutput`, `createEventChannel`, `classifyPiAiError`, `toPiThinkingLevel`, `migratePgSchema`, `acquirePgInstanceLease`, `InstanceHeld`, `isPgConflict` |
| **`@fastagent-sh/client/agent-api`** | Validating or composing Agent API Effect Schemas directly | Effect Schemas for every Agent API type, event, auth flow, `AgentError`, `LIMITS`, `hasEnded`, `decodeRequest` |
| **`@fastagent-sh/client/http/contract`** | Integrating directly with the HTTP contract & OpenAPI schema | `AgentHttpApi`, `API_PREFIX`, `statusOf`, `Refusal`, `Authorization`, `Malformed`, `SessionEventFrame`, `MessageStreamEventFrame` |
| **`@fastagent-sh/client/stream`** | Composing `messages.stream` over an `Agent` implementation | `messageStream`, `StreamSource`, `leavableIterator` |

## Guides by task

| Task | Guide |
| --- | --- |
| Call sessions, messages, `POST /v1/invoke`, streaming, or remote auth | [Agent API](agent-api.md) |
| Package as a versioned npm artifact & gate releases in CI | [Packaging, Distribution & CI/CD](packaging-and-ci.md) |
| Configure models, tools, `needs`, OS sandboxing, PostgreSQL, and traces | [Configuration](configuration.md) |
| Embed `openAgent`, `openPostgresDatabase`, and `service.fetch` | [Embedding](embedding.md) |
| Manage saved remotes, remote login, and client SDKs | [Remotes & clients](remotes.md) |
| Deploy on Docker, Compose, Fly.io, Railway, or any container host | [Deploy](deploy.md) |
| Understand system architecture and isolation boundaries | [Technical architecture](architecture.md) |

FastAgent is pre-1.0. The [Agent API](agent-api.md) is the stable contract at the center of all packages.
