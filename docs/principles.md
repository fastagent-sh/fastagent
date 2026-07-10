---
title: FastAgent design principles
status: current
---

# Design principles

FastAgent is shaped by a simple product moment: a directory works locally as an agent, and now it needs to become a real service — inside your app, on GitHub, in Telegram, or behind another channel.

The design center is **point at directory → live agent capability**. FastAgent is not trying to be the place where you author every agent from scratch. It is the serving layer that takes a local agent directory out of the terminal. `persona.md` is the optional identity slot; `AGENTS.md` remains project context, not a mandatory rewrite format.

The design choices are deliberate:

- **Small callable contract** — an internal boundary that decouples callers, agents, engines, and hosts.
- **Application composition** — compose with the user's application instead of owning routes, database, auth, deployment, and project layout.
- **Typed edges** — typed tools, explicit events, and validation at the places where outside input enters the system.

## The short version

| Principle | What it means in FastAgent |
|---|---|
| **Bring your directory** | Start from a local directory; add `persona.md`, `skills/`, `tools/`, and `channels/` as needed. Existing `AGENTS.md` files remain project context. |
| **Concepts before features** | Define the few primitives authors need to understand — definition, invoke, event, tool, skill, channel, session — before adding knobs. |
| **Small core, clear seams** | The stable center is `invoke(scope, prompt) => AsyncIterable<AgentEvent>`, not a dashboard, cloud, or monolithic runtime. |
| **App ownership** | Your app keeps auth, users, database, routes, deployment, and policy. FastAgent composes with it. |
| **Typed edges** | Tools use Zod schemas, events have a closed shape, and invalid inputs fail at the boundary instead of becoming hidden prompt bugs. |
| **Filesystem as source of truth** | The deployable definition is the directory. No ambient global skills, no hidden registry dependency, no builder-machine state. |
| **One path from dev to serve** | `info`, `dev`, `invoke`, and `start` assemble the same directory so local behavior matches served behavior. |
| **Visible failures** | Runtime problems become `failed` events or diagnostics. Silent fallback is worse than a clear error. |
| **Option value** | The contract is engine-, model-, channel-, and host-neutral so future engines and deployment targets can be added without changing agent authorship. |

## Concept → primitive → implementation

A feature is not real product surface until users can name it and reason about it. FastAgent keeps the public concept set small:

| Concept | Meaning |
|---|---|
| **Definition** | The directory that describes the agent: optional `persona.md`, `skills/`, authored context, tools/channels, and config; `AGENTS.md` contributes project context. |
| **Agent Handler** | The callable contract: `invoke(scope, prompt) => AsyncIterable<AgentEvent>`. |
| **Event** | The streamed output shape every channel can consume: text, thinking, tool lifecycle, completion, or failure. |
| **Tool** | A typed action the model can call, validated before execution. |
| **Skill** | Reusable markdown expertise loaded from the definition, not from global machine state. |
| **Channel** | An adapter that turns an external event into one or more invocations. |
| **Session** | Runtime conversation state, owned by the host/session store rather than baked into the definition. |

That concept set is intentionally smaller than the implementation. Sandboxes, durable queues, evals, registries, hosted deployment, and multi-instance backends can be added later, but they should not appear as core concepts until the product can support them honestly.

## Small contract, small core

One small callable contract can collapse an integration matrix. FastAgent uses `invoke` to decouple triggers, agents, engines, and hosts.

The product restraint is intentional:

- **One obvious callable boundary.** FastAgent has the Agent Handler `invoke` boundary.
- **No ownership of your whole application.** FastAgent does not take over auth, database models, queueing, deployment layout, or frontend framework.
- **Extensions by composition.** Channels, tools, session stores, and host adapters plug into clear seams instead of requiring a new platform.
- **Local-first ergonomics.** You should be able to run the thing, inspect the thing, and debug the thing without a hosted control plane.

## Typed boundaries

Typed boundaries are product UX, not ceremony. FastAgent applies them where agents touch real systems:

- **Typed tools.** `defineTool` takes a Zod input schema, turns it into model-facing JSON Schema, and validates model arguments before execution.
- **Documented event contract.** `AgentEvent` is small and explicit, which makes channels, tests, and UI clients easier to build.
- **Fail early at boundaries.** Bad request bodies, bad tool arguments, and same-session concurrency conflicts surface as actionable errors.
- **Types as public API.** The package re-exports the types authors need so integrations can be written without importing engine internals.

## Deliberate product choices

| We choose… | Instead of… | Why |
|---|---|---|
| Existing agent directories | A new framework-only agent format | The fastest path is serving the directory authors already have. |
| Agent-as-a-feature | Agent-as-a-platform | The common job is adding an agent to a product or channel the user already has, not adopting a second framework. |
| `invoke` as the neutral contract | HTTP handlers as the only contract | The same agent can run behind an app route, GitHub, Telegram, tests, or future channels. |
| Channel adapters | One-off webhook/bot implementations | Channel code should translate events, not duplicate the agent loop. |
| The agent's own reasoning as control flow | A bundled workflow/orchestration engine | The agent decides its steps; deterministic multi-step orchestration is the app's job — call `invoke` from your queue or workflow. |
| Definition-local skills | Global or machine-local skills | Deployment behavior must come from the repo, not a developer's home directory. |
| No required build step | Generated runtime artifacts | The directory is already the deployable unit; fewer artifacts means less drift. |
| Host-provided runtime concerns | Framework-owned everything | Secrets, sessions, execution environment, and policy vary by host and app. |
| Consume existing standards | Inventing a parallel ecosystem | FastAgent should meet authors where they already are: `AGENTS.md`, Agent Skills, TypeScript tools, HTTP/SSE, and host adapters. |
| Clear non-goals | Overclaiming batteries-included production | Durability, sandboxing, hosted deployment, and multi-instance backends should be added as real capabilities, not marketing words. |

## The boundary FastAgent wants to preserve

FastAgent owns the **serving shape**:

```ts
agent.invoke(scope, prompt) => AsyncIterable<AgentEvent>
```

Everything else composes around that:

- definitions load from files,
- tools and skills become agent capabilities,
- channels turn external events into invocations,
- hosts provide auth, storage, execution environment, and deployment.

That boundary is why FastAgent can start small without painting itself into a corner.
