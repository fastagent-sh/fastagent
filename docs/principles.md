---
title: Design principles
description: "The design choices behind FastAgent: one API in process, one harness, app-owned runtime, typed edges, and the non-goals that keep the serving layer small."
status: current
---

# Design principles

FastAgent is shaped by a simple product moment: a directory works locally as an agent, and now it needs to become a real service — inside your app, in Telegram or Slack, or behind another channel.

The design center is **point at directory → live agent capability**. FastAgent is not trying to be the place where you author every agent from scratch. It is the serving layer that takes a local agent directory out of the terminal. `SYSTEM.md` is the prompt; a project keeps its own `AGENTS.md`, which the agent reads there as one of the project's files, and is never asked to rewrite it.

The design choices are deliberate:

- **One API, in process**: every Caller (a channel, a schedule, `fastagent invoke`, your app) uses the same Agent API, in the process that runs the agent.
- **One harness**: pi-durable runs the agent and keeps its conversations; FastAgent assembles the definition onto it rather than abstracting over several.
- **Application composition**: compose with the user's application instead of owning routes, database, auth, deployment, and project layout.
- **Typed edges**: typed tools, explicit events, and validation at the places where outside input enters the system.

## The short version

| Principle | What it means in FastAgent |
|---|---|
| **An agent beside your project** | `fastagent init <dir> --content <project>` creates the agent in a directory of its own and declares the project as what it works on; add `SYSTEM.md`, `skills/` and code under `src/` there as needed. The project gets no writes, and its `AGENTS.md` stays one of its files, read by the agent when it works there. |
| **Concepts before features** | Define the few primitives authors need to understand — definition, session, message, entry, tool, skill, channel — before adding knobs. |
| **Small core, clear seams** | The stable center is the [Agent API](SPEC.md): sessions and messages, not a dashboard, cloud, or monolithic runtime. |
| **App ownership** | Your app keeps auth, users, database, routes, deployment, and policy. FastAgent composes with it. |
| **Typed edges** | Tools use TypeBox schemas, events have a closed shape, and invalid inputs fail at the boundary instead of becoming hidden prompt bugs. |
| **Filesystem as source of truth** | The deployable definition is the directory: identity, skills, tools, channels and schedules. No hidden registry dependency, no builder-machine state baked into the artifact. |
| **The machine lends an environment, not an identity** | An agent inherits the box it runs on the way `bash` inherits the `PATH`: the commands its environment does not declare. Its prompt, skills and templates come from the definition alone, since a prompt from someone's machine would make the agent theirs. |
| **One path from dev to serve** | `info`, `dev`, `invoke`, and `start` open the same directory the same way, so local behavior matches served behavior. |
| **Visible failures** | A message that cannot be answered ends with its outcome saying why, and a refusal is a value; silent fallback is worse than a clear error. |
| **Agent-first checks** | An agent is developed in a coding environment, often by a coding agent, so every check is a command it can run and read: `info --json`, `invoke` with an exit code (and `--json` for its events), `schedules run`. |

## Concept → primitive → implementation

A feature is not real product surface until users can name it and reason about it. FastAgent keeps the public concept set small:

| Concept | Meaning |
|---|---|
| **Agent Definition** | The directory that describes the agent: `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `src/`, and config, including the content it declares; nothing a content entry holds is part of it. |
| **Agent** | The [Agent API](SPEC.md): sessions, messages and entries, in process. |
| **Message** | One thing a Caller sends into a session, from its acceptance to its outcome, which outlives whoever sent it. |
| **Entry** | One record in a session's history: a message once taken, the agent's answer, a tool result. |
| **Tool** | A typed action the model can call, validated before execution. |
| **Skill** | Reusable markdown expertise loaded from the definition. |
| **Channel** | An adapter that turns an external event into messages, and verifies the platform it comes from. |
| **Session** | A conversation's continuity, kept in the instance's storage, named by the Agent. |

That concept set is intentionally smaller than the implementation. Sandboxes, evals, registries, hosted deployment, and multi-instance backends can be added later, but they should not appear as core concepts until the product can support them honestly.

## Small API, small core

One API can collapse an integration matrix. FastAgent's channels, schedules and wake-ups, its CLI and an app that embeds the agent all call the same ten operations.

The product restraint is intentional:

- **One obvious boundary.** The Agent API, in process or over HTTP, the same in both; on the network only behind the instance's key.
- **No ownership of your whole application.** FastAgent does not take over auth, database models, queueing, deployment layout, or frontend framework.
- **Extensions by composition.** Channels, tools, extensions and providers plug into clear seams instead of requiring a new platform.
- **Local-first ergonomics.** You should be able to run the thing, inspect the thing, and debug the thing without a hosted control plane.

## Typed boundaries

Typed boundaries are product UX, not ceremony. FastAgent applies them where agents touch real systems:

- **Typed tools.** A tool's TypeBox schema is what the model sees and what its arguments are validated against before execution.
- **Documented event contract.** A session's events are small and explicit, which makes channels, tests, and UI clients easier to build.
- **Fail early at boundaries.** Bad tool arguments, a missing secret, a module that does not load surface as actionable errors.
- **Types as public API.** The package exports the types authors need so integrations can be written without importing harness internals.

## Deliberate product choices

| We choose… | Instead of… | Why |
|---|---|---|
| Existing agent directories | A new framework-only agent format | The fastest path is serving the directory authors already have. |
| Agent-as-a-feature | Agent-as-a-platform | The common job is adding an agent to a product or channel the user already has, not adopting a second framework. |
| One API, in process and over HTTP behind a key | An HTTP API on every serve, or none | A Caller that opens the agent and one that calls a deployed agent use the same interface. An instance is one trust domain, so the API is on the network only when a key is set, a key for the whole instance; an app that serves users from a browser writes its routes, behind its own auth. |
| One harness | A neutral layer over several | The part harnesses differ on most is the part a neutral layer would standardize; one harness's own guarantees (durable messages, continuation after a restart) are worth more. |
| Channel adapters | One-off webhook/bot implementations | Channel code should translate events, not duplicate the agent loop. |
| The agent's own reasoning as control flow | A bundled workflow/orchestration engine | The agent decides its steps; deterministic multi-step orchestration is the app's job — send messages from your queue or workflow. |
| Commands a coding agent reads | An interactive REPL | Agents are built in coding environments; a check is a command with an exit code. |
| Host-provided runtime concerns | Framework-owned everything | Secrets, storage, execution environment, and policy vary by host and app. |
| Consume existing standards | Inventing a parallel ecosystem | FastAgent should meet authors where they already are: `AGENTS.md`, Agent Skills, TypeScript modules, and host adapters. |
| Clear non-goals | Overclaiming batteries-included production | Sandboxing, hosted deployment, and multi-instance backends should be added as real capabilities, not marketing words. |

## The boundary FastAgent wants to preserve

FastAgent owns the **serving shape**: the [Agent API](SPEC.md).

Everything else composes around that:

- definitions load from files,
- tools and skills become agent capabilities,
- channels turn external events into messages,
- hosts provide storage, credentials, execution environment, and deployment.

That boundary is why FastAgent can start small without painting itself into a corner.
