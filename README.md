<p align="center">
  <a href="https://github.com/kid7st/fastagent"><img src="https://raw.githubusercontent.com/kid7st/fastagent/main/assets/hero.png" alt="FastAgent — Vibe first. Then FastAgent. An agent directory becomes a live service in your app, on GitHub, in Telegram, or any channel." width="860"></a>
</p>

[![CI](https://github.com/kid7st/fastagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kid7st/fastagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kid7st/fastagent.svg)](https://www.npmjs.com/package/@kid7st/fastagent)
[![license](https://img.shields.io/npm/l/@kid7st/fastagent.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@kid7st/fastagent.svg)](https://nodejs.org)
[![built with pi](https://img.shields.io/badge/built%20with-pi-0b7285.svg)](https://pi.dev)

<p align="center">
  <sub>Built on</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="22" /></a>
  <sub>— the agent harness &amp; multi-provider LLM API under the hood</sub>
</p>

Any directory can become a live agent service. FastAgent takes your local agent directory out of the terminal and serves it in your Next/Astro app, Telegram, GitHub/webhook events, an API endpoint, or your own channel.

Leave the terminal. Become a real service.

- **Add it to your app** — one route, your auth, your database, your host.
- **Run it as a live service** — Telegram support, GitHub PR review, webhook handler, API endpoint, or custom channel.

FastAgent is not another agent framework. It does not ask you to rewrite your agent in a new DSL or project layout. You bring the agent definition; FastAgent provides the serving layer around it.

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/kid7st/fastagent@main/assets/demo.svg" alt="fastagent dev boots an existing agent directory (AGENTS.md, skills/, tools/, channels/) into a live service; a GitHub pull_request.opened webhook arrives and the agent reviews PR #42 and posts inline comments." width="860">
</p>

## Why FastAgent

Coding agents made it cheap to vibe useful agent directories. The hard part is the next step: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs.

FastAgent is the missing bridge from local agent directory to real service.

## Features

- **Vibe first — a directory is an agent.** Point FastAgent at the `AGENTS.md` + `skills/` you already vibed in a coding agent. Markdown instructions, reusable skills, and TypeScript tools stay as files you inspect, edit, and commit — no new DSL, no framework rewrite.
- **Channels.** Serve the same agent as a GitHub PR reviewer, a Telegram bot, an HTTP/SSE endpoint, or your own adapter — verified webhooks, streaming replies, group-aware.
- **Models, tools & skills.** Any model provider (OpenAI, Anthropic, Google, …) via OAuth or API key; typed tools discovered from `tools/` (the filename is the name, Zod-validated); Agent Skills loaded on demand. Built on the open-source [pi](https://github.com/earendil-works/pi) harness.
- **App embedding — your stack, we plug in.** Like Flask/FastAPI for agents: FastAgent never owns your framework. Mount the agent in your Next / Astro / Hono / Bun / Node route with one handler — your auth, your database, your host.
- **Deploy anywhere.** Run the directory directly — no build step; `fastagent deploy fly|railway` generates the host config + a runbook and hands off (`--run` drives the deploy to completion). Cloud-neutral: the directory is the deployable unit.

**Designed for more — [help build it](CONTRIBUTING.md).** FastAgent's neutral contract and injection seams are laid out for the capabilities it is growing into. Honest works-in-progress, open to contributors:

- **Durable execution** — accepted turns already replay across a crash or redeploy on Telegram (at-least-once); generalizing to every channel and exactly-once is a backend on the `PiSessionStore` / `Lease` seams.
- **Sandboxed execution** — tools run behind an `ExecutionEnv` port (local by default); E2B / micro-VM backends drop in.
- **Observability export** — leveled logs and per-turn traces today; an OpenTelemetry exporter is a clean seam.
- **More engines & channels** — the Agent Handler contract is engine-neutral (a second engine proves the seams); Slack, Discord, and other adapters plug into the channel kit.
- **More deploy targets** — `deploy fly` and `deploy railway` ship today, and the container recipe already runs the directory on any Docker host; the host-scoped `deploy <host>` seam is laid out for Cloudflare, Render, and beyond.

Using a coding agent? Give it [`docs/ai-start.md`](docs/ai-start.md) for an AI-guided setup path.

## Design philosophy

FastAgent is built around a small serving contract, app-owned runtime concerns, typed boundaries, and composable adapters.

- **Small serving core** — `invoke` decouples channels, agents, engines, and hosts.
- **App-owned runtime** — no takeover of your auth, database, routes, or deployment.
- **Typed edges** — typed tools, explicit events, boundary validation.
- **Agent-native shape** — the directory is the deployable unit, and channels drive the same contract.

Read [Design principles](docs/principles.md) for the full rationale.

## What we didn't build

FastAgent stays a small serving layer, so it never dictates your stack. Capabilities other agent frameworks bake into a platform, we leave to your app, your host, or the agent itself — composed in, not locked in.

- **No platform to move to.** No dashboard, no control plane, no runtime you deploy *into* — run it locally, embed it in your app, or ship the directory to any host.
- **No new format or DSL.** `AGENTS.md`, Agent Skills, TypeScript tools, HTTP/SSE — FastAgent consumes the standards you already use instead of a parallel ecosystem.
- **No workflow engine.** The agent decides its own steps; for deterministic multi-step orchestration, call `invoke` from your own queue or workflow.
- **No engine, model, or cloud lock-in.** One neutral `invoke` contract: swap the engine, the model (any provider, OAuth or API key), or the host without touching the agent.

## Install

```bash
npm i -g @kid7st/fastagent   # CLI: fastagent init/dev/start/...
npm i @kid7st/fastagent      # library API for embedding or code tools
```

Requires **Node >= 22.19** — the floor is inherited from the reference engine (`@earendil-works/pi-agent-core`) and `undici`, both of which require it. The npm package ships compiled JavaScript and type declarations.

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

No directory? Assemble from typed parts:

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

## Public API surface & stability

The root export intentionally contains the supported surface only.

| Area | Examples | Stability |
|---|---|---|
| Contract | `Agent`, `AgentEvent`, `collect` | Stable within SPEC v0.1 |
| Channels/host | `createInvokeHandler`, `nodeListener`, `serveNode`, `router`, `Routes` | Reference implementation, pre-1.0 |
| pi assembly | `createPiAgentFromWorkspace`, `createPiAgentFromDefinition`, `createPiAgent` | Usable now, may tighten before 1.0 |
| Tool/channel authoring | `defineTool`, `z`, `loadTools`, `loadChannels`, `ChannelModule` | Usable now, may tighten before 1.0 |
| Injection ports | `PiSessionStore`, `inMemorySessionStore`, `jsonlSessionStore`, `Lease`, `Provider`, `createProvider` | Public because options reference them |
| Not exported | L0 harness adapter, pi harness factory, prompt/config internals | Internal modules; no compatibility promise |

Subpath exports: `@kid7st/fastagent/github` (GitHub webhook channel), `@kid7st/fastagent/telegram`
(Telegram bot channel).

## Repository layout

```txt
src/     the npm package: CLI, library API, reference implementation
test/    vitest suite (faux models by default) + reusable SPEC conformance
docs/    user docs, SPEC, and maintainer design notes
```

Single package, likely long-term; subpath exports (not sibling packages) are the module boundary.
A `packages/` workspace split is deliberately deferred until a second published artifact with
independent dependencies/versioning actually exists.

## Status

FastAgent is pre-1.0. The stable design center is the Agent Handler contract in `docs/SPEC.md`; the package API may still tighten before 1.0. Notable changes are recorded in the [GitHub Releases](https://github.com/kid7st/fastagent/releases).

## Project

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Acknowledgements

FastAgent stands on open source. The reference implementation is built on **[pi](https://github.com/earendil-works/pi)** ([pi.dev](https://pi.dev)) — its agent harness, multi-provider LLM API, and the interactive TUI that `fastagent chat` drives.

It also depends on, and is grateful to, [zod](https://github.com/colinhacks/zod), [undici](https://github.com/nodejs/undici), [chokidar](https://github.com/paulmillr/chokidar), [giget](https://github.com/unjs/giget), [@clack/prompts](https://github.com/bombshell-dev/clack), [ignore](https://github.com/kaelzhang/node-ignore), and [octokit/webhooks](https://github.com/octokit/webhooks).

The scaffolded `writing-great-skills` skill is vendored from [mattpocock/skills](https://github.com/mattpocock/skills), with its license included.

## License

[MIT](LICENSE). Every runtime dependency is also MIT-licensed, and FastAgent does not bundle their code — npm installs each separately, so their licenses ship with them and none is redistributed here.
