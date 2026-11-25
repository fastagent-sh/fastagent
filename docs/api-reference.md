---
title: API Reference
description: "Which FastAgent npm package to install for your role, its public TypeScript entry points, and where to read the full guides."
status: current
---

# API Reference

FastAgent publishes six version-locked npm packages so you install only what your role needs. Every package ships full TypeScript declarations (`dist/*.d.ts`) for inline editor documentation.

## Building or embedding an agent

| Package | When to install | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/fastagent`** | Writing an agent, packaging it, running the CLI, or embedding in Node | `defineAgent`, `defineTool`, `needs`, `sessionIdOf`, `openAgent`, `openPostgresDatabase`, `baseEnv`, `AgentError`, `LIMITS`, `hasEnded`, `McpError`, plus all Agent API types (`Agent`, `LocalAgent`, `RemoteAgent`, `Session`, `Message`, `Entry`, `InvokeRequest`, `AuthApi`, …) |
| **`@fastagent-sh/harness-dsh`** | Opting into kernel-enforced OS sandboxing (`--harness dsh`, experimental; loaded lazily by `@fastagent-sh/fastagent`) | `openDshAgent`, `MemoryDshEventStore`, `openSqliteDshStore` |

## Calling or operating a deployed agent

| Package | When to install | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/client`** | Calling any HTTP FastAgent from Node, Bun, Deno, or edge workers (zero Node deps) | `connectAgent`, `connectAuth`, `ConnectOptions`, `AgentError`, `LIMITS`, `hasEnded`, and all Agent API types |
| **`@fastagent-sh/client-agentcore`** | Calling an AWS AgentCore-deployed FastAgent from your backend, CLI `--remote`, or Pi (zero server/DB/CDK deps) | `connectAgentCore`, `connectAgentCoreAuth`, `connectRemote`, `AgentCoreConnection`, plus re-exported `connectAgent`, `connectAuth`, `AgentError`, and Agent API types |
| **`@fastagent-sh/pi-remote`** | Chatting interactively with deployed HTTP or AgentCore instances inside Pi TUI (`/fa`) | Default export `fastAgentRemoteExtension` |

## Deploying on Amazon Bedrock AgentCore

| Package / entry | When to install | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/agentcore`** | Running the AgentCore container server & Aurora DSQL adapter | `serveAgentCore`, `AgentCoreOptions`, `dsqlDatabase`, `DsqlOptions` |
| **`@fastagent-sh/agentcore/cdk`** | Adding Aurora DSQL & Secrets Manager grants in an AWS CDK stack | `FastAgentResources`, `FastAgentResourcesProps`, `AgentRuntime` |
| **`@fastagent-sh/agentcore/cli`** | Invoked automatically by `fastagent agentcore ...` | `run` (`init`, `start`, `invoke`) |

## Extending FastAgent (platform & transport authors)

| Entry point | Purpose | Key exports |
| --- | --- | --- |
| **`@fastagent-sh/fastagent/platform`** | Building custom `fastagent deploy init <target>` & runtime CLI extensions | `ExtensionCli`, `ContainerTarget`, `agentFacts`, `writeContainer`, `buildContextLeaks`, `loadAgentBuild`, `invokeOverApi`, `readInvokeMessage`, `modelRefOf`, `DATABASE_URL_ENV`, `Unavailable`, `PostgresDatabase`, `PostgresLimits`, `CreateIndex`, `PgExecutor` |
| **`@fastagent-sh/client/remotes`** | Building pluggable `remotes.json` transport packages (`@fastagent-sh/client-<type>`) | `RemotesFile`, `RemoteConfig`, `HttpRemoteConfig`, `ExtensionRemoteConfig`, `RemoteConnection`, `resolveRemotesPath`, `parseRemotesJson`, `upsertRemoteConfig`, `removeRemoteConfig`, `setDefaultRemoteConfig`, `expandRemoteEnvRef`, `connectExtensionRemote` |
| **`@fastagent-sh/client/agent-api`** | Validating or composing Agent API Effect Schemas directly | Effect Schemas for every Agent API type, event, auth flow, `AgentError`, `LIMITS`, `hasEnded`, `decodeRequest` |
| **`@fastagent-sh/client/http/contract`** | Integrating directly with the HTTP contract & OpenAPI schema | `AgentHttpApi`, `API_PREFIX`, `statusOf`, `Refusal`, `Authorization`, `Malformed`, `SessionEventFrame`, `MessageStreamEventFrame` |
| **`@fastagent-sh/client/stream`** | Composing `messages.stream` over an `Agent` implementation | `messageStream`, `StreamSource`, `leavableIterator` |

## Guides by task

| Task | Guide |
| --- | --- |
| Call sessions, messages, `POST /v1/invoke`, streaming, or remote auth | [Agent API](agent-api.md) |
| Configure models, tools, `needs`, OS sandboxing, PostgreSQL, and traces | [Configuration](configuration.md) |
| Embed `openAgent`, `openPostgresDatabase`, and `service.fetch` | [Embedding](embedding.md) |
| Manage saved remotes, remote login, and `@fastagent-sh/pi-remote` | [Remotes & clients](remotes.md) |
| Deploy on Docker, Compose, Fly.io, Railway, or AWS AgentCore | [Deploy](deploy.md) · [AgentCore](agentcore.md) |
| Understand system architecture and isolation boundaries | [Technical architecture](architecture.md) |

FastAgent is pre-1.0. The [Agent API](agent-api.md) is the stable contract at the center of all packages.
