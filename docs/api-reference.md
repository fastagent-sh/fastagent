---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent API, opening and serving an agent directory, what a host embedding agents needs, what an author writes, and the channel kit."
status: current
---

# API reference

A compact reference for `@fastagent-sh/fastagent`. The package has one entry per kind of user:

| Import | Holds |
|---|---|
| `@fastagent-sh/fastagent` | The Agent API's types and `AgentError`, `openAgent`, what a host embedding agents needs beside it (`createAgent`, the content edits, `credentialFile`, `signIn`, `signInOptions`, `providerAuth`), and what an author writes: `defineAgent`, `defineChannel`, `defineSchedule`, `needs`, `sessionIdOf`, and a channel's helpers |
| `@fastagent-sh/fastagent/client` | `connectAgent`, the Agent API over HTTP, with `AgentError` and the types: for a program anywhere `fetch` runs (Node, Bun, Deno, Workers) |
| `@fastagent-sh/fastagent/telegram`, `/slack`, `/feishu`, `/lark` | Each first-party channel, and the transport and thread reader its tools use |

Each export's signature and its documentation are its declaration: the package ships them (`dist/*.d.ts`), and an
editor shows them. They come from `src/index.ts`, `src/client.ts` and each channel's entry, which name every export.
How to use them:

| To | Read |
|---|---|
| Call an agent, in process or over HTTP | [Agent API](agent-api.md) |
| Open an agent in an app, serve it, sign in to providers, edit its content | [Embedding](embedding.md) |
| Write `fastagent.config.ts`, tools, schedules and `needs` | [Configuration](configuration.md) |
| Write a channel | [Channel development](channel-development.md) |
| Add MCP servers and their sign-in | [MCP servers](mcp.md) |

FastAgent is pre-1.0; the [Agent API](agent-api.md) is the stable design center.
