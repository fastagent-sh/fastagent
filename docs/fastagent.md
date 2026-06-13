---
title: FastAgent
type: product-overview
status: design
updated: 2026-06-11
domain: https://fastagent.sh
---

# FastAgent

FastAgent is WSGI for agent serving: it turns an existing agent definition — `AGENTS.md` plus `skills/` — into a production service without rewriting the agent.

The product has three pieces:

1. **Contract** — the [Agent Handler SPEC](SPEC.md): `invoke(scope, prompt) => AsyncIterable<AgentEvent>`.
2. **Reference implementation** — a pi-based engine binding that fans pi's harness events into the SPEC stream.
3. **Deployment toolchain** — point at a folder, build an artifact, and run it on a target runtime.

FastAgent is not an agent-writing framework. The agent already exists as markdown-native definition files created in tools such as pi, Claude Code, or Codex. FastAgent serves and deploys that artifact.

## Why this product exists

The trigger moment is simple: a developer has a local agent they like, then wants it to work while they are not watching — receive webhooks, run on a schedule, answer from Telegram/Slack, or live behind an API endpoint.

Local interactive tools do not solve that serving problem. Cloud/platform offerings increasingly do, but they usually lock one engine, one model provider, or one host. FastAgent's durable bet is neutrality across:

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
| [comparisons](comparisons.md) | Comparison with Flue, OpenClaw, Claude Agent SDK, OpenCode, and pi |
| [session](session.md) | Draft session-admin model for fork/navigation beyond linear invoke |

## Current status

Core v0.1 local development is closed:

- SPEC reference implementation over pi,
- L0–L3 assembly ladder,
- HTTP/SSE channel,
- `fastagent dev`,
- persistent jsonl sessions under `.fastagent/sessions`,
- executable SPEC conformance tests.

Next product step: `fastagent build` and `fastagent start`, then an AgentCore target adapter.
