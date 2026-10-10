---
title: Overview
description: "What FastAgent is: the serving layer that takes a local agent directory out of the terminal and serves it as a live service on any channel."
status: current
---

# Overview

**Vibe first. Then FastAgent.** FastAgent is the serving layer for local agent directories: take a directory out of the terminal, then run it inside your app, connect it to Telegram, Slack or Feishu, handle webhook events, expose it as an API endpoint, or put it behind your own channel.

It does not ask you to rewrite an agent into a framework-specific project. An agent is a directory of its own, and a git repository from the start (`fastagent init`): grow it with `APPEND_SYSTEM.md`, `AGENTS.md`, `skills/`, `tools/`, channels and schedules, declare the projects it works on and knows as its content, and FastAgent serves it as a live service. The agent can change itself the same way: what it writes into its prompt files and skills takes effect on its next turn.

Coding agents made it cheap to vibe useful agent directories. The next gap is serving: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs. FastAgent connects those directories to real triggers and runtimes.

```txt
reviewer/                   # the agent, its working directory, and a git repository
├── fastagent.config.ts     # the marker, its content, plus deployment choices
├── APPEND_SYSTEM.md        # optional standing instructions (SYSTEM.md replaces pi's default prompt)
├── AGENTS.md               # optional: how this agent is built and changed, loaded every turn
├── skills/  prompts/       # optional skills; prompt templates (run as /<name>)
├── tools/                  # optional code tools
├── channels/               # optional webhook/bot adapters
├── schedules/              # optional prompts run on a cron (<name>.md)
├── extensions/             # optional pi extension modules (see configuration.md)
├── reference.md            # optional reference material the agent reads (any file layout)
└── .state/ .secrets/ .contexts/   # this machine's instance: sessions, credentials, clones (kept out of git, except .secrets/.env.example)

app/                        # content it works on, declared in fastagent.config.ts
├── AGENTS.md               # optional project context, loaded with the agent
└── .agents/skills/         # optional skills the project provides, named app/<skill>
```

Each content entry is a directory on this machine (`{ local }`) or a GitHub repository (`{ github }`). A repository
reaches every place the agent runs: here, your checkout when `local` names one, otherwise a clone; on a host, always a clone. A local
directory stays on this machine, and a deployment says so.

## What FastAgent provides

1. **The agent is a directory** — it holds its prompt files (`APPEND_SYSTEM.md`, `SYSTEM.md`, `AGENTS.md`), `skills/`, `tools/`, `channels/`, `schedules/` and reference material as files you can inspect, edit, and commit, in a repository of its own. What it works on and knows is declared as its [content](configuration.md#content), each entry with its `AGENTS.md` as project context.
2. **A contract** — [Agent Handler SPEC](SPEC.md), centered on `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
3. **A reference implementation** — pi-based assembly for `SYSTEM.md` / `APPEND_SYSTEM.md`, the agent's own and each content entry's `AGENTS.md`, Agent Skills, code tools, sessions, auth, and model selection.
4. **Developer workflow** — `init`, `info`, `content`, `dev`, `chat`, `tool`, `invoke`, `schedules`, `start`, `login`, `models`, channel scaffolding, and `deploy` / `logs` / `destroy`.
5. **Composable adapters**: Telegram, Slack, Feishu with Lark compatibility, the default local invoke channel, and a small public kit for third-party channels.
6. **Clients** — HTTP routes a served agent can add for session control (`/control/*`: state, history, live events, steer and stop; opt-in with [`sessionControl`](configuration.md#config-file), and unauthenticated, so bind loopback or put a gateway in front), and an [authoring API](api-reference.md#content) (`createAgent`, `addContent`, `removeContent`) for clients such as a desktop app, to create agents and edit their content under the same rules as the CLI.
7. **Time triggers** — schedules (`schedules/<name>.md`) and agent self-scheduling (the `wake` tool, on every serve), with a bounded fire history (`fastagent schedules list`).

## Design choices

FastAgent deliberately keeps the serving layer small and composable:

- **Handler contract** — `invoke` is the internal seam between triggers, agents, harnesses, and hosts.
- **Small core** — the stable center is the Agent Handler contract, not a platform runtime.
- **App-owned runtime** — your app keeps auth, users, database, routes, deployment, and policy.
- **Typed edges** — tools, events, and request bodies are explicit and validated at boundaries.
- **Filesystem truth** — the deployable definition is the directory, not ambient machine state.

See [Design principles](principles.md) for the full rationale and non-goals.

## What we didn't build

FastAgent stays a small serving layer, so it never dictates your stack. Capabilities other agent frameworks bake into a platform, we leave to your app, your host, or the agent itself — composed in, not locked in.

- **No platform to move to** — no dashboard, no hosted control plane, no runtime you deploy *into*; run it locally, embed it, or ship the directory to any host.
- **No new format or DSL** — `AGENTS.md`, Agent Skills, TypeScript tools, HTTP/SSE; FastAgent consumes the standards you already use, not a parallel ecosystem.
- **No workflow engine** — the agent decides its own steps; for deterministic orchestration, call `invoke` from your own queue or workflow.
- **Harness-neutral contract; pi reference implementation** — channels depend on `Agent`, while the included assembly uses pi; models and hosts remain replaceable runtime choices.

## Two main use cases

### Embed an agent in an existing app

Use FastAgent as a library, then mount the agent in your own route:

```ts
import { createInvokeHandler, createPiAgentFromDefinition } from "@fastagent-sh/fastagent";

const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

export const POST = createInvokeHandler(agent);
```

Your app still owns auth, database, routing, and deployment.

### Run it for Telegram, Slack, or Feishu

Use the CLI:

```bash
fastagent init my-agent
cd my-agent
fastagent dev
fastagent start
```

Add Telegram, Slack, Feishu, or Lark when the agent should help chat users:

```bash
fastagent add telegram
fastagent add slack
fastagent add feishu   # 飞书; Lark international: fastagent add lark
```

## Documentation map

| If you want to… | Read |
|---|---|
| Develop an agent from responsibilities through verification | [Agent development guide](ai-start.md) |
| Get running quickly | [Quickstart](quickstart.md) |
| Configure an agent | [Configuration](configuration.md) |
| Understand design choices | [Design principles](principles.md) |
| Use CLI commands | [CLI reference](cli.md) |
| Embed in an app | [Embedding](embedding.md) |
| Add webhooks/bots | [Channels](channels.md) |
| Run the agent on a cron / let it wake itself | [Quickstart §8](quickstart.md#8-run-on-a-clock), [CLI reference](cli.md) |
| Ship to Fly, Railway, AWS Bedrock AgentCore, or any Docker host | [Deploy](deploy.md) |
| Use Telegram bots | [Telegram channel](telegram.md) |
| Use Slack apps | [Slack channel](slack.md) |
| Use Feishu bots / Lark compatibility | [Feishu channel (Lark compatibility)](feishu.md) |
| Build a channel adapter | [Channel development](channel-development.md) |
| Look up public TypeScript exports | [API reference](api-reference.md) |
| Fix common issues | [Troubleshooting](troubleshooting.md) |
| Implement or review the contract | [Agent Handler SPEC](SPEC.md) |
| Understand implementation tradeoffs | [Design notes](design/README.md) |

## Current status

Implemented today:

- Agent Handler v0.1 reference implementation over pi.
- Directory assembly from `SYSTEM.md` / `APPEND_SYSTEM.md`, the agent's own and each content entry's `AGENTS.md`, `skills/`, discovered `tools/`, and `fastagent.config.ts`.
- Content: local directories and GitHub repositories (here, a checkout `local` names, used as it is, otherwise a clone; on a host, always a clone; a clone is brought up to date in place at each start).
- Session control (`/control/*`) and the authoring API for clients.
- HTTP/SSE invoke channel.
- Telegram, Slack, and Feishu channel adapters (Lark international rides the same engine as a compatibility profile).
- Schedules (`schedules/` files) and agent self-scheduling (the `wake` tool, on every serve), with a bounded fire history.
- `dev`, `chat`, `invoke`, `tool`, `info`, `schedules`, `start`, and `deploy docker` / `deploy fly` / `deploy railway` / `deploy agentcore` (`--run` drives Docker Compose or the host CLI end-to-end).
- jsonl session persistence with restart continuity.
- CLI login backed by a project-level `<agent dir>/.secrets/auth.json` (override: `FASTAGENT_AUTH_PATH`, dir: `FASTAGENT_SECRETS_DIR`).

Not implemented yet:

- Multi-instance session/lease/auth backends out of the box (the single-machine tier is the shipped scope).
- Additional harness reference bindings beyond pi.
