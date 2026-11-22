---
title: Documentation
description: "FastAgent documentation: product overview, technical architecture, authoring, configuration, remote operations, embedding, deployment, and API reference."
status: current
---

# Documentation

Take your agent from prototype to durable service. FastAgent is the durable runtime and serving layer that turns your prompts, skills, and TypeScript tools into a live service—embedded in your app or served over HTTP behind one Agent API.

## Start here

| Goal | Guide |
| --- | --- |
| Understand what FastAgent is, what it solves, and where it fits | [Overview](overview.md) |
| Build and run your first agent in five minutes | [Quickstart](quickstart.md) |
| Follow the full authoring workflow (for humans and coding agents) | [Agent development guide](ai-start.md) |

## Architecture & contract

| Goal | Guide |
| --- | --- |
| Understand system layers, packages, dual harnesses, storage, and security | [Technical architecture](architecture.md) |
| Learn sessions, messages, `POST /v1/invoke`, streaming, remote auth, and errors | [Agent API](agent-api.md) |

## Build & configure

| Goal | Guide |
| --- | --- |
| Configure models, harnesses, OS sandboxing, tools, secrets, storage, and traces | [Configuration](configuration.md) |
| Connect stdio and Streamable HTTP MCP tool servers | [MCP servers](mcp.md) |

## Connect & operate

| Goal | Guide |
| --- | --- |
| Save remotes, call deployments, log in remotely, and use `@fastagent-sh/pi-remote` | [Remotes & clients](remotes.md) |
| Look up every `fastagent` command, flag, and exit code | [CLI reference](cli.md) |

## Embed & deploy

| Goal | Guide |
| --- | --- |
| Embed an agent in your own backend or desktop app | [Embedding](embedding.md) |
| Deploy a container to Docker, Compose, Fly.io, Railway, or any host | [Deploy](deploy.md) |
| Deploy isolated per-user instances on Amazon Bedrock AgentCore + Aurora DSQL | [AgentCore](agentcore.md) |

## Reference & support

| Goal | Guide |
| --- | --- |
| Inspect public npm packages and TypeScript entry points | [API reference](api-reference.md) |
| Diagnose common setup, harness, remote, and deployment issues | [Troubleshooting](troubleshooting.md) |
