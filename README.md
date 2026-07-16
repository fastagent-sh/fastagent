<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — Vibe first. Then FastAgent. An agent directory becomes a live service in your app, on GitHub, in Telegram, or any channel." width="860"></a>
</p>

[![CI](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml/badge.svg)](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@fastagent-sh/fastagent.svg)](https://www.npmjs.com/package/@fastagent-sh/fastagent)
[![license](https://img.shields.io/npm/l/@fastagent-sh/fastagent.svg)](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@fastagent-sh/fastagent.svg)](https://nodejs.org)
[![built with pi](https://img.shields.io/badge/built%20with-pi-0b7285.svg)](https://pi.dev)

<p align="center">
  <sub>Built on</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="22" /></a>
  <sub>— the agent harness &amp; multi-provider LLM API under the hood</sub>
</p>

A file-defined agent directory can become a live service. FastAgent takes it out of the terminal and serves it in your Next/Astro app, Telegram, GitHub/webhook events, an API endpoint, or your own channel.

Leave the terminal. Become a live service.

- **Add it to your app** — one route, your auth, your database, your host.
- **Run it as a live service** — Telegram support, GitHub PR review, webhook handler, API endpoint, or custom channel.

FastAgent is not a new agent-authoring DSL. You bring the existing definition and project layout; FastAgent provides the serving runtime and adapters around it.

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="Three acts in one terminal: a coding agent vibes a support agent into a directory; fastagent dev serves it live, answering a GitHub pull request, a Telegram message, and an HTTP invoke; fastagent deploy fly --run ships it to a live URL." width="860">
</p>

## Why FastAgent

Coding agents made it cheap to vibe useful agent directories. The hard part is the next step: local agents live in terminals, but real services receive webhooks, join Telegram, serve product users, and expose stable APIs.

FastAgent is the missing bridge from local agent directory to live service.

## Features

- **Vibe first — a directory is an agent.** Point FastAgent at the `AGENTS.md` + `skills/` you already vibed in a coding agent. Markdown instructions, reusable skills, and TypeScript tools stay as files you inspect, edit, and commit — no new DSL, no framework rewrite.
- **Channels.** Serve the same agent as a GitHub PR reviewer, a Telegram bot, an HTTP/SSE endpoint, or your own adapter — verified webhooks, streaming replies, group-aware.
- **Models, tools & skills.** Any model provider (OpenAI, Anthropic, Google, …) via OAuth or API key; typed tools discovered from `tools/` (the filename is the name, Zod-validated); Agent Skills loaded on demand. Built on the open-source [pi](https://github.com/earendil-works/pi) harness.
- **App embedding — your stack, we plug in.** Mount the agent in your Next / Astro / Hono / Bun / Node route with one handler, or call `invoke` like any function from your own code — your auth, your database, your infra. FastAgent composes with your app, never owns it.
- **Deploy anywhere.** No application build step — the directory is the deployable unit. `fastagent deploy docker|fly|railway` generates the container + target config and a runbook (`--run` drives it to completion). Local Docker gets user-owned Compose + durable state; optional `--tunnel` adds an ephemeral Quick Tunnel service for webhook channels. Durable ingress remains yours.

## Design philosophy

FastAgent is built around a small serving contract, app-owned runtime concerns, typed boundaries, and composable adapters.

- **Small serving core** — `invoke` decouples channels, agents, harnesses, and infra.
- **App-owned runtime** — no takeover of your auth, database, routes, or deployment.
- **Typed edges** — typed tools, explicit events, boundary validation.
- **Agent-native shape** — the directory is the deployable unit, and channels drive the same contract.

Read the [Design principles](https://fastagent.sh/docs/principles/) for the full rationale.

## What we didn't build

FastAgent stays a small serving layer, so it never dictates your stack. Capabilities other agent frameworks bake into a platform, we leave to your app, your infra, or the agent itself — composed in, not locked in.

- **No platform to move to.** No dashboard, no control plane, no runtime you deploy *into* — run it locally, embed it in your app, or ship the directory anywhere.
- **No new format or DSL.** `AGENTS.md`, Agent Skills, TypeScript tools, HTTP/SSE — FastAgent consumes the standards you already use instead of a parallel ecosystem.
- **No workflow engine.** The agent decides its own steps; for deterministic multi-step orchestration, call `invoke` from your own queue or workflow.
- **No model or cloud lock-in.** The Agent Handler contract is harness-neutral (the [SPEC](https://fastagent.sh/docs/spec/) says *engine* — same seam), with [pi](https://pi.dev) as the built-in harness; bring your own harness and every channel keeps working unchanged.

## Install

For agents — paste this into Claude Code, Codex, Cursor, or any coding agent that reads the web:

> Read https://fastagent.sh/start.md and build an agent in this project.

For humans:

```bash
npm i -g @fastagent-sh/fastagent   # CLI: fastagent init/dev/start/...
npm i @fastagent-sh/fastagent      # library API for embedding or code tools
```

Requires **Node >= 22.19** (the floor is inherited from the pi harness and `undici`), and also runs under **Bun** (smoke-tested in CI on Bun 1.3; its native fetch replaces the undici path). The npm package ships compiled JavaScript and type declarations.

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
import { createInvokeHandler, createPiAgentFromDefinition } from "@fastagent-sh/fastagent";

const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

export const POST = createInvokeHandler(agent); // Fetch-shaped handler
```

No directory? Assemble from typed parts:

```ts
import { createPiAgent, defineTool, z } from "@fastagent-sh/fastagent";

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
| [Documentation index](https://fastagent.sh/docs/) | Documentation map |
| [Quickstart](https://fastagent.sh/docs/quickstart/) | Scaffold, run, add a tool, and start |
| [Configuration](https://fastagent.sh/docs/configuration/) | Configure model, auth, ports, sessions, tools, and channels |
| [Design principles](https://fastagent.sh/docs/principles/) | Design choices, core primitives, and non-goals |
| [CLI reference](https://fastagent.sh/docs/cli/) | CLI commands and flags |
| [Embedding](https://fastagent.sh/docs/embedding/) | Use FastAgent as a library inside your own app |
| [Channels](https://fastagent.sh/docs/channels/) | Add webhook/bot channels |
| [Deploy](https://fastagent.sh/docs/deploy/) | Ship the directory to Fly, Railway, or any Docker host |
| [GitHub](https://fastagent.sh/docs/github/) / [Telegram](https://fastagent.sh/docs/telegram/) / [Feishu and Lark](https://fastagent.sh/docs/feishu/) | First-party channel guides |
| [Channel development](https://fastagent.sh/docs/channel-development/) | Build custom channel adapters |
| [API reference](https://fastagent.sh/docs/api-reference/) | Public TypeScript API reference |
| [Troubleshooting](https://fastagent.sh/docs/troubleshooting/) | Common setup/runtime issues |
| [Agent Handler SPEC](https://fastagent.sh/docs/spec/) | Agent Handler protocol v0.1 |
| [Core design](https://fastagent.sh/docs/design/core/) | Maintainer architecture notes |

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

Subpath exports:

- `@fastagent-sh/fastagent/core` — engine-neutral contract, consumption helpers, channel/host kit, schedules;
- `@fastagent-sh/fastagent/pi` — the pi reference implementation;
- `@fastagent-sh/fastagent/github` — GitHub webhook channel;
- `@fastagent-sh/fastagent/telegram` — Telegram bot channel;
- `@fastagent-sh/fastagent/feishu` — canonical Feishu bot channel (飞书, open.feishu.cn);
- `@fastagent-sh/fastagent/lark` — Lark-international compatibility profile over the Feishu engine.

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

FastAgent is pre-1.0. The stable design center is the Agent Handler contract in `docs/SPEC.md`; the package API may still tighten before 1.0. Notable changes are recorded in the [GitHub Releases](https://github.com/fastagent-sh/fastagent/releases).

## Designed for more

The neutral contract leaves room for capabilities that are not complete product features yet:

- **Durable execution** — Telegram accepted turns replay at least once today; general durability and exactly-once execution remain future backend work.
- **Sandboxed execution** — `ExecutionEnv` is an assembly seam, but the pi coding tools and project-context loader are still local; a complete sandbox adapter is future work.
- **Observability export** — leveled logs and per-turn traces exist today; an OpenTelemetry exporter does not.
- **More harness bindings and channels** — pi is the built-in harness; another harness can implement the Agent contract, and community channels can use the channel kit.
- **More deploy targets** — local Docker, Fly, and Railway ship today; the generated container is the portable path for other hosts.

See [Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md) if one of these is the problem you want to work on.

## Project

- [Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md)
- [Security policy](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md)

## Acknowledgements

FastAgent stands on open source. The built-in harness is **[pi](https://github.com/earendil-works/pi)** ([pi.dev](https://pi.dev)) — its agent loop, multi-provider LLM API, and the interactive TUI that `fastagent chat` drives.

It also depends on, and is grateful to, [zod](https://github.com/colinhacks/zod), [undici](https://github.com/nodejs/undici), [chokidar](https://github.com/paulmillr/chokidar), [giget](https://github.com/unjs/giget), [@clack/prompts](https://github.com/bombshell-dev/clack), [ignore](https://github.com/kaelzhang/node-ignore), and [octokit/webhooks](https://github.com/octokit/webhooks).

The scaffolded `writing-great-skills` skill is vendored from [mattpocock/skills](https://github.com/mattpocock/skills), with its license included.

## License

[MIT](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE). Runtime dependencies use permissive open-source licenses and are installed as separate npm packages; the vendored `writing-great-skills` scaffold includes its own license.
