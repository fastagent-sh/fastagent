---
title: Documentation
description: "The FastAgent documentation map: quickstart, configuration, embedding, channels, deployment, and reference for serving agent directories as live services."
status: current
---

# Documentation

FastAgent is the serving layer for local agent directories. It takes a directory out of the terminal and serves it as a live service: embedded in your app, connected to Telegram, Slack or Feishu, handling webhook events, running on a clock, or behind your own channel. `SYSTEM.md` is its prompt (its own `AGENTS.md` says how it is built and changed; a content entry's `AGENTS.md` is a file of that project, which the agent reads there), but the directory is the unit.

## Recommended path

1. Start with [Develop an Agent with FastAgent](ai-start.md), the canonical authoring guide for humans and coding agents. It covers responsibilities, TypeScript, verification, channels, scheduling, and deployment.
2. Use [Overview](overview.md) for the product shape or [Quickstart](quickstart.md) for a short first run.
3. Use [Configuration](configuration.md) when choosing models, auth, ports, tools, channels, and schedules.
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
| Configure the model, providers, auth, ports, tools, channels and schedules | [Configuration](configuration.md) |
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
| Look up the API every Caller uses | [Agent API SPEC](SPEC.md) |
| Fix common setup/runtime issues | [Troubleshooting](troubleshooting.md) |

## Core concepts

- **The agent is a directory of its own.** Runtime behavior comes from the agent directory: `SYSTEM.md` (the prompt), `AGENTS.md`, `skills/`, `prompts/`, code under `src/` (tools, extensions, channels, schedules), and markdown context. What it works on is declared as its content, whose files, `AGENTS.md` included, the agent reads there and never takes into its prompt.
- **The Agent API is the contract.** Every channel, schedule and app calls the same [Agent API](SPEC.md), in process or over HTTP: sessions the Agent names, messages whose outcome outlives their callers, and a durable history.
- **Channels are adapters.** A channel receives external events (Telegram, Slack, a webhook, …), verifies its platform, sends the agent messages, and returns host-specific responses.
- **The instance holds the state.** Sessions live in its storage (`.state/agent.sqlite`), credentials in `.secrets/`; neither is part of the agent definition.
- **Small core, typed edges.** One API, in process and over HTTP, app-level composition, and validation at the boundaries.

## Maintainer notes

These are not required to use FastAgent, but they explain public architecture decisions and tradeoffs:

| Document | Purpose |
|---|---|
| [Design notes](design/README.md) | What belongs in public design docs |
| [Architecture](design/architecture.md) | One harness (pi-durable), one API, the definition and its assembly, the artifact, context packages, and hosts |
| [Core design](design/core.md) | The code as it is now: the agent directory and its content, the assembly onto pi-durable, channels, schedules, state, and deployment |
| [Configuration and credential ownership](design/configuration.md) | Where each configuration fact lives, deployment environments, and who owns which credential |
| [Distribution and provenance](design/distribution.md) | Why an agent directory has no manifest, and where a vendored skill's origin should be recorded |
| [Participant model](design/participant-model.md) | When a chat channel speaks, where it answers, and what it remembers — the authority behind Feishu/Lark and Slack routing |
| [Place history](design/place-history.md) | In progress: what a chat place said, read from the platform when a turn needs it instead of copied into a buffer |
| [Channels across environments](design/channel-environments.md) | A deployment receives Feishu/Lark by webhook by default and `dev` keeps WebSocket (`FEISHU_INGRESS`); one app serves one environment at a time until per-environment apps (#749) |
| [Security boundary](design/security-boundary.md) | What a serve exposes (routes that verify their caller, and the Agent API behind the instance's keys), and why an instance is one trust domain, so people who must be kept apart get an instance each |

For contribution workflow, see [../CONTRIBUTING.md](../CONTRIBUTING.md).
