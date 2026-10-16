---
title: Documentation
description: "The FastAgent documentation map: quickstart, configuration, embedding, channels, deployment, and reference for serving agent directories as live services."
status: current
---

# Documentation

FastAgent is the serving layer for local agent directories. It takes a directory out of the terminal and serves it as a live service: embedded in your app, connected to Telegram, Slack or Feishu, handling webhook events, exposed as an API endpoint, or running behind your own channel. `APPEND_SYSTEM.md` holds its standing instructions and `SYSTEM.md` an identity of its own (its own `AGENTS.md` says how it is built and changed; a content entry's `AGENTS.md` is a file of that project, which the agent reads there), but the directory is the unit.

## Recommended path

1. Start with [Develop an Agent with FastAgent](ai-start.md), the canonical authoring guide for humans and coding agents. It covers responsibilities, TypeScript, verification, channels, scheduling, and deployment.
2. Use [Overview](overview.md) for the product shape or [Quickstart](quickstart.md) for a short first run.
3. Use [Configuration](configuration.md) when choosing models, auth, ports, sessions, tools, and channels.
4. Pick the integration path you need: [Embedding](embedding.md) or [Channels](channels.md).
5. Ship the directory with [Deploy](deploy.md) when the agent should run on a host.

Give a coding agent the same [`ai-start.md`](ai-start.md). The repository's `AGENTS.md` and the maintainer notes below describe FastAgent development, not how to author an agent.

## Guides

| Goal | Read |
|---|---|
| Develop an agent from responsibilities through verified deployment | [Agent development guide](ai-start.md) |
| Understand what FastAgent is | [Overview](overview.md) |
| Understand the design choices and non-goals | [Design principles](principles.md) |
| Scaffold, run locally, add a tool, and start | [Quickstart](quickstart.md) |
| Configure model, auth, ports, sessions, tools, and channels | [Configuration](configuration.md) |
| Embed an agent in an existing app or route | [Embedding](embedding.md) |
| Connect Telegram, Slack, Feishu, or another channel | [Channels](channels.md) |
| Run the agent on a cron, or let it wake itself | [Quickstart §8](quickstart.md#8-run-on-a-clock), [Schedules](configuration.md#schedules) |
| Ship the agent to a host | [Deploy](deploy.md) |

## Channel guides

| Goal | Read |
|---|---|
| Use a Telegram bot | [Telegram channel](telegram.md) |
| Use a Slack app | [Slack channel](slack.md) |
| Use Feishu or its Lark compatibility profile | [Feishu channel (Lark compatibility)](feishu.md) |
| Build a custom channel adapter | [Channel development](channel-development.md) |

## Reference

| Goal | Read |
|---|---|
| Use the CLI | [CLI reference](cli.md) |
| Look up TypeScript exports | [API reference](api-reference.md) |
| Understand the event stream contract | [Agent Handler SPEC](SPEC.md) |
| Fix common setup/runtime issues | [Troubleshooting](troubleshooting.md) |

## Core concepts

- **The agent is a directory of its own.** Runtime behavior comes from the agent directory: optional `SYSTEM.md` / `APPEND_SYSTEM.md` (the prompt), `skills/`, `prompts/`, `tools/`, `channels/`, `schedules/`, and markdown context. What it works on is declared as its content, whose files, `AGENTS.md` included, the agent reads there and never takes into its prompt.
- **The Agent is the contract.** Every channel or host drives an `Agent` ([SPEC v1](SPEC.md)) through `invoke(request) => AsyncIterable<InvokeEvent>` and its sessions.
- **Channels are adapters.** A channel receives external events (HTTP, Telegram, Slack, …), maps them to one or more agent turns, and returns host-specific responses.
- **Hosts own runtime state.** Sessions, credentials, execution environment, and locking are runtime concerns, not part of the agent definition.
- **Small core, typed edges.** FastAgent uses a small callable contract, app-level composition, and validation at the boundaries.

## Maintainer notes

These are not required to use FastAgent, but they explain public architecture decisions and tradeoffs:

| Document | Purpose |
|---|---|
| [Design notes](design/README.md) | What belongs in public design docs |
| [Core design](design/core.md) | pi reference implementation, assembly ladder, sessions, auth, and deployment model |
| [Configuration and credential ownership](design/configuration.md) | Where each configuration fact lives, deployment environments, and who owns which credential |
| [Distribution and provenance](design/distribution.md) | Why an agent directory has no manifest, and where a vendored skill's origin should be recorded |
| [Participant model](design/participant-model.md) | When a chat channel speaks, where it answers, and what it remembers — the authority behind Feishu/Lark and Slack routing |
| [Place history](design/place-history.md) | In progress: what a chat place said, read from the platform when a turn needs it instead of copied into a buffer |
| [Channels across environments](design/channel-environments.md) | A deployment receives Feishu/Lark by webhook by default and `dev` keeps WebSocket (`FEISHU_INGRESS`); one app serves one environment at a time until per-environment apps (#749) |
| [Security boundary](design/security-boundary.md) | Why FastAgent authenticates nothing, what an anonymous caller of a serve can do, and a multi-tenant facade in front of one deployment |

For contribution workflow, see [../CONTRIBUTING.md](../CONTRIBUTING.md).
