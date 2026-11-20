---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent API, opening and serving an agent directory, what a host embedding agents needs, what an author writes, "
status: current
---

# API reference

A compact reference for the packages, one entry per kind of user:

| Import | Holds |
|---|---|
| `@fastagent-sh/fastagent` | The Agent API's types and `AgentError`, `openAgent`, `McpError`, and what an author writes: `defineAgent`, `defineSchedule`, `needs`, `sessionIdOf` |
| `@fastagent-sh/client` | `connectAgent` (core Agent API), `connectClock` (schedules & wake-ups), and `connectAuth` (remote provider login/logout) over HTTP, with `AgentError` and the types: for a program anywhere `fetch` runs (Node, Bun, Deno, Workers). It does not install the runtime |
| `@fastagent-sh/client/agentcore` | `connectAgentCore`, `connectAgentCoreClock`, and `connectAgentCoreAuth` (plus `connectAgent`, `connectClock`, `connectAuth`, `AgentError` and the types), for one AgentCore session with `@aws-sdk/client-bedrock-agentcore` installed |
| `@fastagent-sh/agentcore` | Running on Amazon Bedrock AgentCore: `serveAgentCore`, `createAlarmGroup`, and `dsqlDatabase`, an Aurora DSQL cluster as `openAgent`'s `database`. Installed in an agent, it adds `fastagent agentcore` |
| `@fastagent-sh/agentcore/cdk` | `FastAgentResources`, the AWS resources an agent on AgentCore needs beside its runtime, for a CDK stack |
| `@fastagent-sh/fastagent/platform` | What a platform extension builds on: the command it adds (`ExtensionCli`), the container it writes (`writeContainer`), the check of what an image would carry, the agent's build and the values it declares |

Each export's signature and its documentation are its declaration: the package ships them (`dist/*.d.ts`), and an
editor shows them. Each entry names every export.
How to use them:

| To | Read |
|---|---|
| Call an agent, in process or over HTTP | [Agent API](agent-api.md) |
| Open an agent in an app and serve it | [Embedding](embedding.md) |
| Write `fastagent.config.ts`, tools, schedules and `needs` | [Configuration](configuration.md) |
| Add MCP servers and their sign-in | [MCP servers](mcp.md) |

FastAgent is pre-1.0; the [Agent API](agent-api.md) is the stable design center.
