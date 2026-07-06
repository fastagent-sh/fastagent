---
title: FastAgent documentation
status: current
---

# FastAgent documentation

FastAgent is the serving layer for local agent directories. It takes a directory out of the terminal and turns it into a running service: embedded in your app, connected to Telegram, handling GitHub/webhook events, exposed as an API endpoint, or running behind your own channel. `AGENTS.md` is recommended for identity, but the directory is the unit.

## Recommended path

1. Read the [Overview](overview.md) to understand the shape.
2. Run the [Quickstart](quickstart.md) to create and serve a workspace.
3. Use [Configuration](configuration.md) when choosing models, auth, ports, sessions, tools, and channels.
4. Pick the integration path you need: [Embedding](embedding.md) or [Channels](channels.md).

Using a coding agent? Give it the repository's [`ai-start.md`](ai-start.md) for an AI-guided setup path.

## Guides

| Goal | Read |
|---|---|
| Understand what FastAgent is | [Overview](overview.md) |
| Understand the design choices and non-goals | [Design principles](principles.md) |
| Scaffold, run locally, add a tool, and start | [Quickstart](quickstart.md) |
| Configure model, auth, ports, sessions, tools, and channels | [Configuration](configuration.md) |
| Embed an agent in an existing app or route | [Embedding](embedding.md) |
| Connect GitHub, Telegram, or another channel | [Channels](channels.md) |

## Channel guides

| Goal | Read |
|---|---|
| Use GitHub webhooks | [GitHub channel](github.md) |
| Use a Telegram bot | [Telegram channel](telegram.md) |
| Build a custom channel adapter | [Channel development](channel-development.md) |

## Reference

| Goal | Read |
|---|---|
| Use the CLI | [CLI reference](cli.md) |
| Look up TypeScript exports | [API reference](api-reference.md) |
| Understand the event stream contract | [Agent Handler SPEC](SPEC.md) |
| Fix common setup/runtime issues | [Troubleshooting](troubleshooting.md) |

## Core concepts

- **The directory is the agent.** Runtime behavior comes from the workspace: optional `AGENTS.md`, `skills/`, `tools/`, `channels/`, and markdown context.
- **`invoke` is the contract.** Every channel or host drives an `Agent` through `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
- **Channels are adapters.** A channel receives external events (HTTP, GitHub, Telegram, Slack, …), maps them to one or more agent turns, and returns host-specific responses.
- **Hosts own runtime state.** Sessions, credentials, execution environment, and locking are runtime concerns, not part of the agent definition.
- **Small core, typed edges.** FastAgent uses a small callable contract, app-level composition, and validation at the boundaries.

## Maintainer notes

These are not required to use FastAgent, but they explain public architecture decisions and tradeoffs:

| Document | Purpose |
|---|---|
| [Design notes](design/README.md) | What belongs in public design docs |
| [Core design](design/core.md) | pi reference implementation, assembly ladder, sessions, auth, and deployment model |

For contribution workflow, see [../CONTRIBUTING.md](../CONTRIBUTING.md).
