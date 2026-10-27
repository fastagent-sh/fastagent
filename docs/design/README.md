---
title: Design notes
description: "What belongs in FastAgent's public design notes, and what is normative: the Agent API SPEC, the code, and the user docs."
status: current
---

# Design notes

This directory contains maintainer-facing design material. It is intentionally kept separate from the user guide so people evaluating or using FastAgent can follow the short path first: [Quickstart](../quickstart.md), [Embedding](../embedding.md), and [Channels](../channels.md).

## What is normative?

| Source | Status |
|---|---|
| [Agent API SPEC](../SPEC.md) | The normative contract, which the code implements: the consumer Agent API, ten operations, in process, with no network binding. Changes require explicit review. |
| Code in `src/` | Implementation source of truth. |
| User docs in `docs/` | Product behavior and supported usage. |
| Documents in `docs/design/` | Explanatory architecture notes. They clarify why the code is shaped the way it is, but they are not a public compatibility promise. |

## What belongs here?

Keep public design notes only when they help contributors make better changes:

- architecture decisions that are visible in the code,
- tradeoffs that are not obvious from implementation alone,
- constraints reviewers should preserve when changing the system.

Do **not** keep private strategy here: market positioning, competitor analysis, pricing, launch plans, partner/customer notes, and internal risk analysis belong in a private workspace. Temporary plans, handoff notes, session logs, and stale debates should be deleted or folded into durable public docs.

## Documents

| Document | Purpose |
|---|---|
| [agent-api.md](agent-api.md) | **Proposed.** The Agent API v2: one model of sessions, messages and entries, bound in process in TypeScript and over HTTP with an API key. Replaces the [SPEC](../SPEC.md) when implemented. |
| [architecture.md](architecture.md) | **Decided; implemented through its §6 step 2.** What FastAgent is for, and the shape that follows: pi-durable as the only harness, the consumer [Agent API](../SPEC.md) as the one API of our own, the definition and its assembly, an npm package as the artifact, context packages, and hosts that keep state off the box. |
| [agent-model.md](agent-model.md) | **Implemented.** What an agent is, as a program: model + harness + context, composed by FastAgent in a definition, the instance that holds its state, the content it works on and knows, its types, and the vocabulary later designs build on. |
| [agent-service.md](agent-service.md) | **Partly implemented.** Agents a team builds, runs and uses together as cloud services: who it is for, the product loop, what an agent works with (content, connectors and environment; the environment under `environment` in `context.json`, installed by mise), and credentials. |
| [agent-cli.md](agent-cli.md) | **Implemented.** The command-line side of the agent model: addressing an Agent, the local instance, what `init` declares, editing content, and what each command shows. |
| [core.md](core.md) | The code as it is now: the agent directory and its content, the assembly onto pi-durable, messages and sessions, channels, schedules, state and deployment. |
| [configuration.md](configuration.md) | **Partially implemented** (day one landed; the env dimension is not scheduled). Where each configuration fact lives: the convention boundary, deployment environments, and credential ownership. |
| [distribution.md](distribution.md) | Why an agent directory has no manifest: what is derivable from the filesystem, what must be recorded, and where that record lives. |
| [participant-model.md](participant-model.md) | How a chat bot behaves in a collaboration tool: the participant axiom and the summon/placement/memory rules derived from it. |
| [place-history.md](place-history.md) | Proposed: a chat place's history read from the platform when a turn needs it, replacing the context buffer (#633, #374). |
| [security-boundary.md](security-boundary.md) | Why FastAgent serves no API and authenticates no caller of its own, what a serve exposes (routes that verify their caller), and why an instance is one trust domain, so people who must be kept apart get an instance each. |
