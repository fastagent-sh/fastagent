---
title: fastagent — Competitive comparisons
type: competitive-analysis
status: design
updated: 2026-06-11
---

# Competitive comparisons

FastAgent sits in the serving layer for existing markdown-native agents. The closest neighboring projects occupy adjacent layers.

## Overview

| Project | What it is | Agent definition | Neutrality | Web analogy |
|---|---|---|---|---|
| **FastAgent** | Serving contract + reference implementation + deployment toolchain | Existing markdown definition + config | Engine/model/host neutral by design | WSGI + gunicorn + deployment toolchain |
| **Flue** | Code-first agent harness framework | TypeScript workflows | Partly neutral, but framework-shaped | Astro/Next-style framework |
| **OpenClaw** | Self-hosted personal assistant product | Markdown-native assistant config | Product-shaped, not a neutral serving layer | WordPress-like product |
| **Claude Agent SDK hosting** | SDK + hosting guidance | Claude Code projects | Claude-locked | Vendor SDK hosting |
| **OpenCode `serve`** | Headless server for OpenCode | OpenCode projects | OpenCode-locked | Product server |
| **pi** | Harness engine and coding agent | Engine/runtime layer | The reference engine FastAgent builds on | Werkzeug-like engine substrate |

## Flue

Flue is a code-first harness framework. You write workflows in TypeScript, use typed schemas, and select sandbox/connectors as first-class concepts.

FastAgent differs in the entry point:

| Axis | Flue | FastAgent |
|---|---|---|
| Agent authoring | Write TypeScript workflows | Reuse an existing `AGENTS.md` + `skills/` folder |
| Primary user | Engineers writing agents as code | People who already created useful markdown-native agents |
| Contract | Flue runtime API | Agent Handler `invoke(scope, prompt) => AsyncIterable<AgentEvent>` |
| Runtime strategy | Framework/sandbox abstraction | Stateless core + injected env/session + target adapters |
| Deployment | Build/run in supported targets | Build/start/deploy existing definitions across targets |

Flue is a real competitor when the user wants code-first workflow control. FastAgent's wedge is the opposite: do not rewrite the agent.

## OpenClaw

OpenClaw validates a related need: markdown-native, multi-channel, self-hosted assistants are useful. But OpenClaw is a product; the product is the assistant.

FastAgent should not compete on being the best personal assistant. It is the serving layer someone could use to build OpenClaw-like products for arbitrary definitions and targets.

## Claude Agent SDK hosting and OpenCode serve

These are the most important platform-absorption examples:

- Claude Agent SDK hosting shows how to run Claude Code programmatically or as a hosted service, but it locks the Claude engine/model path.
- OpenCode `serve` exposes OpenCode as a headless HTTP server, but it locks the OpenCode product.

FastAgent only exists if neutrality matters: the same serving/deployment path should work across different coding-agent artifacts, engines, models, and hosts.

## pi

pi is not the competitor; it is the first engine substrate.

FastAgent builds on `pi-agent-core`'s `AgentHarness`, not the TUI-oriented `pi-coding-agent` `AgentSession`. The reference implementation adapts pi's two ports — `prompt()` final value plus `subscribe()` event side-channel — into the single Agent Handler event stream.

FastAgent should avoid rebuilding pi's harness. Its value is the contract, assembly/deployment shape, and host portability around the harness.

## Worked example: GitHub issue triage

Imagine an agent definition that triages new GitHub issues by reading issue content, choosing labels, commenting, and assigning an owner. The core agent behavior can live in `AGENTS.md` and a skill either way.

With Flue, the natural wrapper is a TypeScript workflow running in CI or a configured sandbox.

With FastAgent, the natural wrapper is a channel adapter:

```ts
const result = await collect(agent.invoke(
  { session: `gh-${repo}-${issue}` },
  { text: `Triage issue #${issue} in ${repo}.` },
));
```

The same Agent Handler can be exposed through HTTP, a webhook adapter, A2A, a scheduled job, or a target runtime such as AgentCore. The markdown agent stays the same; the serving shell changes.

## Summary

FastAgent wins only where “existing markdown-native agent definition → running service on any target” is the job. If the user wants to write a new agent in code, use a framework. If the user wants a finished assistant product, use a product. If the user wants neutral serving/deployment for agent folders, FastAgent owns that layer.
