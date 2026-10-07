---
title: Design notes
description: "What belongs in FastAgent's public design notes, and what is normative: the Agent Handler SPEC, the code, and the user docs."
status: current
---

# Design notes

This directory contains maintainer-facing design material. It is intentionally kept separate from the user guide so people evaluating or using FastAgent can follow the short path first: [Quickstart](../quickstart.md), [Embedding](../embedding.md), and [Channels](../channels.md).

## What is normative?

| Source | Status |
|---|---|
| [Agent Handler SPEC](../SPEC.md) | Normative protocol contract. Changes require explicit review. |
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
| [agent-model.md](agent-model.md) | **Implemented.** What an agent is, as a program: model + harness + context, the instance that runs it, what it works on and what it knows, the context types, and the vocabulary later designs build on. |
| [agent-service.md](agent-service.md) | **Proposed.** Agents a team builds, runs and uses together as cloud services: the product loop, the world an agent acts in (environment, contexts, connectors), credentials, `invoke` as a durable unit of work, the interfaces, the architecture and deployment. Answers #688. |
| [agent-cli.md](agent-cli.md) | **Implemented.** The command-line side of the agent model: addressing an Agent, the local instance, what `init` declares, editing contexts, and what each command shows. |
| [core.md](core.md) | Current architecture of the pi reference implementation. |
| [configuration.md](configuration.md) | **Partially implemented** (day one landed; the env dimension is not scheduled). Where each configuration fact lives: the convention boundary, deployment environments, and credential ownership. |
| [distribution.md](distribution.md) | Why an agent directory has no manifest: what is derivable from the filesystem, what must be recorded, and where that record lives. |
| [conformance-levels.md](conformance-levels.md) | Where a session's state lives: the deployment axis, the postures that pin it, and what each owes. |
| [participant-model.md](participant-model.md) | How a chat bot behaves in a collaboration tool: the participant axiom and the summon/placement/memory rules derived from it. |
| [place-history.md](place-history.md) | Proposed: a chat place's history read from the platform when a turn needs it, replacing the context buffer (#633, #374). |
| [session-control.md](session-control.md) | Session control plane beside `invoke`: observe a session, act on its run, set its properties, and manage the deployment's sessions. |
