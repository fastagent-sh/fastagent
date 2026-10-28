---
title: Overview
description: "What FastAgent is: the serving layer that takes a local agent directory out of the terminal and serves it as a live service on any channel."
status: current
---

# Overview

**Vibe first. Then FastAgent.** FastAgent is the serving layer for local agent directories: take a directory out of the terminal, then run it inside your app, connect it to Telegram, Slack or Feishu, handle webhook events, or put it behind your own channel.

It does not ask you to rewrite an agent into a framework-specific project. An agent is a directory of its own, and a git repository from the start (`fastagent init`): grow it with `SYSTEM.md`, `AGENTS.md`, `skills/` and code under `src/` (tools, channels, schedules), declare the projects it works on and knows as its content, and FastAgent serves it as a live service. The agent can change itself the same way: what it writes into its prompt files and skills takes effect on its next message.

Coding agents made it cheap to vibe useful agent directories. The next gap is serving: local agents live in terminals, but real services receive webhooks, join chats, run on a clock and keep their conversations across restarts. FastAgent connects those directories to real triggers and runtimes.

```txt
reviewer/                   # the agent, its working directory, and a git repository
├── fastagent.config.ts     # the marker: defineAgent({ model, providers, … })
├── context.json            # its content and environment: the repositories it works on and knows, the commands it runs
├── context.local.json      # this machine's directories it is bound to (kept out of git and of every image)
├── SYSTEM.md               # the system prompt
├── AGENTS.md               # optional: how this agent is built and changed, a section of every prompt
├── skills/  prompts/       # optional skills; prompt templates (run as /<name>)
├── src/tools/              # optional code tools
├── src/channels/           # optional webhook/bot adapters
├── src/schedules/          # optional prompts run on a cron
├── reference.md            # optional reference material the agent reads (any file layout)
├── content/handbook/       # a clone fastagent makes of each repository with no checkout bound here
└── .state/ .secrets/       # this machine's instance: its storage, credentials (kept out of git, except .secrets/.env.example)

~/code/app/                 # a checkout of acme/app, declared in context.json and bound here
└── AGENTS.md               # the project's own: a file the agent reads there, never part of its prompt
```

`context.json` declares GitHub repositories (`{ "github": "acme/app" }`), which reach every place the agent runs: here,
your checkout when `context.local.json` binds one, otherwise a clone; on a host, always a clone. A directory only this
machine has is bound in `context.local.json` alone: it stays here, and a deployment says so.

## What FastAgent provides

1. **The agent is a directory**: its prompt files (`SYSTEM.md`, `AGENTS.md`), `skills/`, `prompts/`, its code under `src/` and reference material are files you can inspect, edit, and commit, in a repository of its own. What it works on and knows is declared as its [content](configuration.md#content): files the agent reads and changes there, none of which becomes part of its prompt.
2. **One API**: the [Agent API](SPEC.md), in process: sessions the Agent names, messages whose outcome outlives whoever sent them, and a durable history every Caller reads the same way.
3. **One harness**: [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which keeps every conversation in the instance's storage and answers an accepted message after a restart. Models come from pi-ai, with your own providers in code.
4. **Developer workflow**: `init`, `info`, `content`, `env`, `dev`, `invoke`, `schedules`, `start`, `login`, `models`, channel scaffolding, and `deploy` / `logs` / `destroy`. Every check is a command a coding agent can run and read.
5. **Composable adapters**: Telegram, Slack, Feishu with Lark compatibility, and a small public kit for your own channels.
6. **Time triggers**: schedules (`src/schedules/`) and agent self-scheduling (the `wake` tool, on every serve), with a bounded fire history (`fastagent schedules list`).

## Design choices

FastAgent deliberately keeps the serving layer small and composable:

- **One API, in process**: every Caller (a channel, a schedule, `invoke`, your app) uses the Agent API; FastAgent puts it on no network.
- **Small core**: the stable center is the Agent API, not a platform runtime.
- **App-owned runtime**: your app keeps auth, users, database, routes, deployment, and policy.
- **Typed edges**: tools, events, and request bodies are explicit and validated at boundaries.
- **Filesystem truth**: the deployable definition is the directory, not ambient machine state.

See [Design principles](principles.md) for the full rationale and non-goals.

## What we didn't build

FastAgent stays a small serving layer, so it never dictates your stack. Capabilities other agent frameworks bake into a platform, we leave to your app, your host, or the agent itself — composed in, not locked in.

- **No platform to move to**: no dashboard, no hosted control plane, no runtime you deploy *into*; run it locally, embed it, or ship the directory to any host.
- **No new format or DSL**: `AGENTS.md`, Agent Skills, TypeScript modules; FastAgent consumes the standards you already use, not a parallel ecosystem.
- **No workflow engine**: the agent decides its own steps; for deterministic orchestration, send messages from your own queue or workflow.
- **No HTTP API of its own**: a served agent answers only its channels, which verify their platform. An app that wants the agent on its network writes routes over the Agent API, behind its own authentication.

## Two main use cases

### Embed an agent in an existing app

Use FastAgent as a library and call the agent in process:

```ts
import { openAgent } from "@fastagent-sh/fastagent";

const agent = await openAgent("./agent", { model: "openai-codex/gpt-5.5" });
const session = await agent.sessions.create();
// agent.messages.send({ sessionId: session.id, content }, { wait }) for the answer, or messages.stream() as written
```

Your app still owns auth, database, routing, and deployment. See [Embedding](embedding.md).

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
| Look up the Agent API | [Agent API SPEC](SPEC.md) |
| Understand implementation tradeoffs | [Design notes](design/README.md) |

## Current status

Implemented today:

- The Agent API on pi-durable, with one SQLite storage per instance (`.state/agent.sqlite`).
- Directory assembly from `SYSTEM.md` / `AGENTS.md`, `skills/`, `prompts/`, `src/` and `fastagent.config.ts`, with secrets declared by the code that reads them (`needs`).
- Content: local directories and GitHub repositories (here, a checkout `local` names, used as it is, otherwise a clone; on a host, always a clone; a clone is brought up to date in place at each start).
- Telegram, Slack, and Feishu channel adapters (Lark international rides the same engine as a compatibility profile).
- Schedules (`src/schedules/`) and agent self-scheduling (the `wake` tool, on every serve), with a bounded fire history.
- `dev`, `invoke`, `info`, `schedules`, `start`, and `deploy docker` / `deploy fly` / `deploy railway` / `deploy agentcore` (`--run` drives Docker Compose or the host CLI end-to-end).
- CLI login backed by a project-level `<agent dir>/.secrets/auth.json` (override: `FASTAGENT_AUTH_PATH`, dir: `FASTAGENT_SECRETS_DIR`).
- `openAgent` and its `serve()`: an agent directory opened and served inside an app.

Not implemented yet:

- An npm package as the deployable artifact, and context packages ([architecture.md](design/architecture.md) §4).
- MCP servers as connectors ([#678](https://github.com/fastagent-sh/fastagent/issues/678)).
- One instance spread over several processes (one process holds an instance's storage).
