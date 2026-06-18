---
title: FastAgent
type: product-overview
status: design
updated: 2026-06-18
domain: https://fastagent.sh
---

# FastAgent

FastAgent is **Flask/WSGI for agents**: it turns an existing agent definition — `AGENTS.md` plus `skills/` — into a running capability without rewriting it, in either posture:

- **Embed into an existing product**: the agent is one capability inside a product you already have — `createPiAgent(...).invoke(...)` in your own route, wired to your session store, your auth, your host. Library, not framework: it composes into your stack instead of owning the application.
- **Serve as a standalone agent service**: the agent runs while you are away — webhook handler, scheduled worker, Slack/Telegram bot, API endpoint, or cloud-hosted agent.

The product has three pieces:

1. **Contract** — the [Agent Handler SPEC](SPEC.md): `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
2. **Reference implementation** — a pi-based engine binding that fans pi's harness events into the SPEC stream.
3. **Deployment toolchain** — point at a folder, build an artifact, and run it on a target runtime.

FastAgent is not an agent-writing framework. The agent already exists as markdown-native definition files created in tools such as pi, Claude Code, or Codex. FastAgent serves and deploys that artifact.

## Why this product exists

There are two trigger moments. **Embed:** a developer is building a product (often vibe-coded: their own auth/DB/host) and needs to add an agent *feature* — without adopting a second framework's routing/db/project layout. **Deploy:** a developer has a local agent they like and wants it to work while they are not watching — webhooks, schedules, Telegram/Slack, an API endpoint.

Local interactive tools do not solve either problem. Full frameworks (Flue, Eve) solve them by making you build an agent *product* in their world. FastAgent's bet is the opposite posture — a neutral contract you embed into *your* world or run as a thin service/channel — plus neutrality across:

- agent definitions (`AGENTS.md`, Agent Skills, future MCP support),
- engines (pi first; other engines later),
- channels/triggers,
- deployment targets.

## Product boundary

FastAgent owns the serving layer:

- **In scope:** the Agent Handler contract, the pi reference implementation, local dev, build/start, and target adapters.
- **Out of scope:** inventing a new agent definition format, replacing the harness engine, building a full workflow/task orchestration product, or becoming a code-first agent framework.

You can build products such as multi-channel assistants or A2A task systems on top of FastAgent, but those products are not FastAgent itself.

## Documentation

| Document | Purpose |
|---|---|
| [SPEC](SPEC.md) | Locked v0.1 Agent Handler contract |
| [core-design](core-design.md) | The pi reference implementation and current core architecture |
| [positioning](positioning.md) | Product strategy, wedge, risks, and boundaries |
| [comparisons](comparisons.md) | Comparison with Eve, Flue, OpenClaw, Claude Agent SDK, OpenCode, and pi |
| [session](session.md) | Draft session-admin model for fork/navigation beyond linear invoke |

## Current status

Core v0.1 local development is closed:

- SPEC reference implementation over pi,
- L0–L2 assembly ladder + dev/build/start command openers,
- HTTP/SSE channel,
- `fastagent dev`,
- persistent jsonl sessions under `.fastagent/sessions`,
- executable SPEC conformance tests.

Next product step: `fastagent build` and `fastagent start`, then an AgentCore target adapter.
