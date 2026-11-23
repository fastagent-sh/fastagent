---
title: Documentation
description: "FastAgent documentation: product overview, technical architecture, packaging and CI/CD, configuration, remote operations, embedding, deployment, and API reference."
status: current
---

# Documentation

**English** · [简体中文](zh-CN/README.md)

FastAgent is the open-source TypeScript & Node.js runtime for production AI agents. Write agents in Markdown (`SYSTEM.md`, `AGENTS.md`, `skills/`), typed TypeScript tools, and MCP — package as versioned npm artifacts, embed in your app, self-host with Docker, or deploy to Fly.io, Railway, and AWS AgentCore.

## Start here

| Goal | Guide |
| --- | --- |
| Understand what FastAgent is, what it solves, and where it fits | [Overview](overview.md) |
| Build and run your first agent in five minutes | [Quickstart](quickstart.md) |
| Explore production examples (`pr-review-agent`, `incident-triage-agent`, `saas-copilot`, `agentcore-per-user`, `deep-research-agent`) | [Examples](../examples/README.md) |
| Package an agent as a versioned npm artifact & gate releases in CI | [Packaging, Distribution & CI/CD](packaging-and-ci.md) |
| Follow the end-to-end build workflow (for humans and coding agents) | [Agent development guide](ai-start.md) |

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
