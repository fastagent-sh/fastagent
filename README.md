# FastAgent

[![CI](https://github.com/kid7st/fastagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kid7st/fastagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kid7st/fastagent.svg)](https://www.npmjs.com/package/@kid7st/fastagent)
[![license](https://img.shields.io/npm/l/@kid7st/fastagent.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@kid7st/fastagent.svg)](https://nodejs.org)

**Vibe first. Then FastAgent.** Any folder can become a live agent service. FastAgent takes your local agent folder out of the terminal and serves it in your Next/Astro app, Telegram, GitHub/webhook events, an API endpoint, or your own channel.

Leave the terminal. Become a real service.

- **Add it to your app** — one route, your auth, your database, your host.
- **Run it as a live service** — Telegram support, GitHub PR review, webhook handler, API endpoint, or custom channel.

FastAgent is not another agent framework. It does not ask you to rewrite your agent in a new DSL or project layout. You bring the agent definition; FastAgent provides the serving layer around it.

## Why FastAgent

Coding agents made it cheap to vibe useful agent folders. The hard part is the next step: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs.

FastAgent is the missing bridge from local agent folder to real service.

## Features

|  |  |
|---|---|
| **The folder is the agent**<br>Keep identity, skills, tools, channels, and markdown context as files you can inspect, edit, and commit. No framework rewrite. | **App embedding**<br>Mount the same agent inside your Next, Astro, or Node app with one route, your auth, your database, and your host. |
| **Always-on channels**<br>Connect the same agent to GitHub PR review, Telegram support, or any custom channel adapter. | **Fast local loop**<br>Use `fastagent info`, `dev`, `chat`, `tool`, and `invoke` to inspect and test before serving. |
| **Typed tools and reusable skills**<br>Add TypeScript tools and Agent Skills without rewriting the agent loop. | **Neutral handler contract**<br>Engine-, model-, and host-neutral at the Agent Handler layer. The current reference implementation is built on pi. |

Using a coding agent? Give it [`start.md`](start.md) for an AI-guided setup path.

## Design philosophy

FastAgent is built around a small serving contract, app-owned runtime concerns, typed boundaries, and composable adapters.

- **Small serving core** — `invoke` decouples channels, agents, engines, and hosts.
- **App-owned runtime** — no takeover of your auth, database, routes, or deployment.
- **Typed edges** — typed tools, explicit events, boundary validation.
- **Agent-native shape** — the folder is the deployable unit, and channels drive the same contract.

Read [Design principles](docs/principles.md) for the full rationale.

## Install

```bash
npm i -g @kid7st/fastagent   # CLI: fastagent init/dev/start/...
npm i @kid7st/fastagent      # library API for embedding or code tools
```

Requires **Node >= 22.19**. The npm package ships compiled JavaScript and type declarations.

## Quickstart

```bash
fastagent init my-agent
cd my-agent
fastagent dev
```

Then send a local test turn:

```bash
curl -N -X POST localhost:8787/invoke \
  -H 'content-type: application/json' \
  -d '{"session":"s1","text":"hello"}'
```

For production-style local serving:

```bash
fastagent start
```

There is no FastAgent build step: the directory is the agent.

## Embed in an app

```ts
import { createInvokeHandler, createPiAgentFromDefinition } from "@kid7st/fastagent";

const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

export const POST = createInvokeHandler(agent); // Fetch-shaped handler
```

No folder? Assemble from typed parts:

```ts
import { createPiAgent, defineTool, z } from "@kid7st/fastagent";

const lookupOrder = defineTool({
  name: "lookup-order",
  description: "Look up an order by id.",
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return await db.find(orderId);
  },
});

const agent = createPiAgent({
  model: "openai-codex/gpt-5.5",
  instructions: "You are a support assistant. Use lookup-order for order questions.",
  tools: [lookupOrder],
});
```

## Documentation

| Document | Purpose |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/quickstart.md](docs/quickstart.md) | Scaffold, run, add a tool, and start |
| [docs/configuration.md](docs/configuration.md) | Configure model, auth, ports, sessions, tools, and channels |
| [docs/principles.md](docs/principles.md) | Design choices, core primitives, and non-goals |
| [docs/cli.md](docs/cli.md) | CLI reference |
| [docs/embedding.md](docs/embedding.md) | Use FastAgent as a library inside your own app |
| [docs/channels.md](docs/channels.md) | Add webhook/bot channels |
| [docs/github.md](docs/github.md) / [docs/telegram.md](docs/telegram.md) | First-party channel guides |
| [docs/channel-development.md](docs/channel-development.md) | Build custom channel adapters |
| [docs/api-reference.md](docs/api-reference.md) | Public TypeScript API reference |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common setup/runtime issues |
| [docs/SPEC.md](docs/SPEC.md) | Agent Handler protocol v0.1 |
| [docs/design/core.md](docs/design/core.md) | Maintainer architecture notes |

## Repository layout

```txt
core/    npm package: CLI, library API, reference implementation, tests
docs/    user docs, SPEC, and maintainer design notes
```

## Status

FastAgent is pre-1.0. The stable design center is the Agent Handler contract in `docs/SPEC.md`; the package API may still tighten before 1.0. See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## Project

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
