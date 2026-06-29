---
title: FastAgent overview
status: current
---

# FastAgent overview

**Vibe first. Then FastAgent.** FastAgent is the serving layer for local agent folders: take a folder out of the terminal, then run it inside your app, connect it to Telegram, handle GitHub/webhook events, expose it as an API endpoint, or put it behind your own channel.

It does not ask you to rewrite an agent into a framework-specific project. Start with any folder; add `AGENTS.md`, `skills/`, `tools/`, channels, and markdown context as the agent grows. FastAgent gives that folder a running service shape.

Coding agents made it cheap to vibe useful agent folders. The next gap is serving: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs. FastAgent connects those folders to real triggers and runtimes.

```txt
agent/
├── AGENTS.md           # optional identity and standing instructions
├── skills/             # optional reusable markdown expertise
├── tools/              # optional code tools
├── channels/           # optional webhook/bot adapters
├── reference.md        # optional markdown context (any file layout)
└── fastagent.config.mjs # optional deployment choices
```

## What FastAgent provides

1. **Your folder is the agent** — `AGENTS.md`, `skills/`, `tools/`, `channels/`, and markdown context stay as files you can inspect, edit, and commit. `AGENTS.md` is recommended for identity, not a rewrite requirement.
2. **A contract** — [Agent Handler SPEC](SPEC.md), centered on `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
3. **A reference implementation** — pi-based assembly for `AGENTS.md`, Agent Skills, code tools, sessions, auth, and model selection.
4. **Developer workflow** — `init`, `info`, `dev`, `chat`, `tool`, `invoke`, `start`, and channel scaffolding.
5. **Composable adapters** — GitHub, Telegram, the default local invoke channel, and a small public kit for third-party channels.

## Design choices

FastAgent deliberately keeps the serving layer small and composable:

- **Handler contract** — `invoke` is the internal seam between triggers, agents, engines, and hosts.
- **Small core** — the stable center is the Agent Handler contract, not a platform runtime.
- **App-owned runtime** — your app keeps auth, users, database, routes, deployment, and policy.
- **Typed edges** — tools, events, and request bodies are explicit and validated at boundaries.
- **Filesystem truth** — the deployable definition is the folder, not ambient machine state.

See [Design principles](principles.md) for the full rationale and non-goals.

## What FastAgent is not

- Not another agent framework.
- Not a new agent definition format or DSL.
- Not a full application framework that owns your routes, database, or deployment layout.
- Not a durable workflow engine.
- Not a replacement for the underlying harness engine.

## Two main use cases

### Embed an agent in an existing app

Use FastAgent as a library, then mount the agent in your own route:

```ts
import { createInvokeHandler, createPiAgentFromDefinition } from "@kid7st/fastagent";

const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

export const POST = createInvokeHandler(agent);
```

Your app still owns auth, database, routing, and deployment.

### Run it for GitHub or Telegram

Use the CLI:

```bash
fastagent init my-agent
cd my-agent
fastagent dev
fastagent start
```

Add GitHub or Telegram when the agent should review PRs or help Telegram users:

```bash
fastagent add github
fastagent add telegram
```

## Documentation map

| If you want to… | Read |
|---|---|
| Get running quickly | [Quickstart](quickstart.md) |
| Configure a workspace | [Configuration](configuration.md) |
| Understand design choices | [Design principles](principles.md) |
| Use CLI commands | [CLI reference](cli.md) |
| Embed in an app | [Embedding](embedding.md) |
| Add webhooks/bots | [Channels](channels.md) |
| Use GitHub webhooks | [GitHub channel](github.md) |
| Use Telegram bots | [Telegram channel](telegram.md) |
| Build a channel adapter | [Channel development](channel-development.md) |
| Look up public TypeScript exports | [API reference](api-reference.md) |
| Fix common issues | [Troubleshooting](troubleshooting.md) |
| Implement or review the contract | [Agent Handler SPEC](SPEC.md) |
| Understand implementation tradeoffs | [Design notes](design/README.md) |

## Current status

Implemented today:

- Agent Handler v0.1 reference implementation over pi.
- Folder assembly from `AGENTS.md`, `skills/`, discovered `tools/`, and `fastagent.config.*`.
- HTTP/SSE invoke channel.
- GitHub and Telegram channel adapters.
- `dev`, `chat`, `invoke`, `tool`, `info`, and `start` workflows.
- jsonl session persistence with restart continuity.
- CLI login backed by `~/.fastagent/auth.json`.

Not implemented yet:

- Hosted deployment (`fastagent deploy`).
- Durable post-ACK execution for webhook turns.
- Multi-instance session/lease/auth backends out of the box.
- Non-pi engine bindings.
