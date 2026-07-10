---
title: FastAgent overview
status: current
---

# FastAgent overview

**Vibe first. Then FastAgent.** FastAgent is the serving layer for local agent directories: take a directory out of the terminal, then run it inside your app, connect it to Telegram, handle GitHub/webhook events, expose it as an API endpoint, or put it behind your own channel.

It does not ask you to rewrite an agent into a framework-specific project. Start with any directory; add `persona.md`, `skills/`, `tools/`, channels, and markdown context as the agent grows. FastAgent gives that directory a running service shape.

Coding agents made it cheap to vibe useful agent directories. The next gap is serving: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs. FastAgent connects those directories to real triggers and runtimes.

```txt
agent/
├── persona.md          # optional identity and standing instructions
├── skills/             # optional reusable markdown expertise
├── tools/              # optional code tools
├── channels/           # optional webhook/bot adapters
├── schedules/          # optional cron time triggers
├── AGENTS.md           # optional project context (yours, or a host repo's)
├── reference.md        # optional markdown context (any file layout)
└── fastagent.config.mjs # optional deployment choices
```

## What FastAgent provides

1. **Your directory is the agent** — `persona.md` (identity), `skills/`, `tools/`, `channels/`, and markdown context stay as files you can inspect, edit, and commit. An `AGENTS.md` is *project context* the agent reads (its own, or a host repo's) — not a rewrite requirement.
2. **A contract** — [Agent Handler SPEC](SPEC.md), centered on `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
3. **A reference implementation** — pi-based assembly for `persona.md`, `AGENTS.md` context, Agent Skills, code tools, sessions, auth, and model selection.
4. **Developer workflow** — `init`, `info`, `dev`, `chat`, `tool`, `invoke`, `fire`, `schedule`, `start`, `login`, `models`, channel scaffolding, and `deploy`.
5. **Composable adapters** — GitHub, Telegram, the default local invoke channel, and a small public kit for third-party channels.
6. **Time triggers** — cron schedules (`schedules/` files) and opt-in agent self-scheduling (the `wake` tool), with a per-run audit (`fastagent schedule history`).

## Design choices

FastAgent deliberately keeps the serving layer small and composable:

- **Handler contract** — `invoke` is the internal seam between triggers, agents, engines, and hosts.
- **Small core** — the stable center is the Agent Handler contract, not a platform runtime.
- **App-owned runtime** — your app keeps auth, users, database, routes, deployment, and policy.
- **Typed edges** — tools, events, and request bodies are explicit and validated at boundaries.
- **Filesystem truth** — the deployable definition is the directory, not ambient machine state.

See [Design principles](principles.md) for the full rationale and non-goals.

## What we didn't build

FastAgent stays a small serving layer, so it never dictates your stack. Capabilities other agent frameworks bake into a platform, we leave to your app, your host, or the agent itself — composed in, not locked in.

- **No platform to move to** — no dashboard, no control plane, no runtime you deploy *into*; run it locally, embed it, or ship the directory to any host.
- **No new format or DSL** — `AGENTS.md`, Agent Skills, TypeScript tools, HTTP/SSE; FastAgent consumes the standards you already use, not a parallel ecosystem.
- **No workflow engine** — the agent decides its own steps; for deterministic orchestration, call `invoke` from your own queue or workflow.
- **No engine, model, or cloud lock-in** — one neutral `invoke` contract; swap the engine, the model, or the host without touching the agent.

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
| Run the agent on a cron / let it wake itself | [Quickstart §8](quickstart.md#8-run-on-a-clock), [CLI reference](cli.md) |
| Ship to Fly, Railway, or any Docker host | [Deploy](deploy.md) |
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
- Directory assembly from `persona.md`, `AGENTS.md` project context, `skills/`, discovered `tools/`, and `fastagent.config.*`.
- HTTP/SSE invoke channel.
- GitHub and Telegram channel adapters.
- `dev`, `chat`, `invoke`, `tool`, `info`, `start`, and `deploy fly` / `deploy railway` (`--run` drives flyctl / the railway CLI end-to-end).
- jsonl session persistence with restart continuity.
- CLI login backed by a project-level `<state root>/auth.json` (default `<dir>/.fastagent/auth.json`; override: `--auth-path` / `FASTAGENT_AUTH_PATH`, root: `FASTAGENT_STATE_DIR`).

Not implemented yet:

- Durable post-ACK execution for webhook turns.
- Multi-instance session/lease/auth backends out of the box (the single-machine tier is the shipped scope).
- Non-pi engine bindings.
