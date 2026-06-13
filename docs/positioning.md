---
title: fastagent — Positioning
type: product-positioning
status: design
updated: 2026-06-11
---

# fastagent positioning

## North star

You already have an agent: a folder with `AGENTS.md`, `skills/`, and standard markdown assets. FastAgent should let you point at that folder and turn it into a production service — webhook handler, scheduled worker, Slack/Telegram bot, API endpoint, or cloud-hosted agent — without rewriting the agent.

FastAgent is WSGI for agent serving: a neutral `invoke` contract plus a pi-based reference implementation plus a deployment toolchain.

It is **not**:

- a code-first agent SDK,
- a new agent definition format,
- a batteries-included assistant product,
- a replacement for the harness engine.

## Primary user wedge

The sharpest user segment is the developer or power user who already has useful agent definition folders and wants them to run when they are not present.

| Segment | Fit | Risk |
|---|---|---|
| Individual/power user with useful local agent definitions | Highest fit: markdown-native, zero rewrite | Deployment need may be shallower than the number of people creating agent folders |
| Teams building agents into products | Real need, budget, infra expectations | They can write code and may prefer SDKs/frameworks |
| Indie hackers building agent products | Strong deployment/DX need | Directly overlaps more with code-first frameworks such as Flue |

The story must focus on the moment where local tooling breaks: “I need this agent to act while I am away.” Generic “productionize your agent” is weaker.

## Market read

Most agent frameworks are code-first orchestration layers: LangGraph, Vercel AI SDK, Mastra, CrewAI, OpenAI Agents SDK, Cloudflare Agents, and similar systems.

Most “agent serving” offerings are owned by infrastructure or platform vendors and naturally pull users into that platform.

The open gap is:

> markdown-native + engine-neutral + target-neutral serving for existing agent definitions.

ACP and A2A are important standards, but they sit next to this gap:

- ACP assumes an editor/client environment and human-in-the-loop interaction.
- A2A assumes an already-running agent endpoint.
- Neither specifies how a trigger invokes an arbitrary local agent definition as a deployable service.

## Competitive moat

The moat is not code volume. The engine is pi. The durable value is:

1. a small, engine-neutral serving contract,
2. stateless multi-session execution that can move across hosts,
3. target adapters that encode hard runtime differences,
4. deployment DX good enough to feel obvious.

The technical proof point is AgentCore: if an existing `AGENTS.md` + `skills/` folder can be deployed to AgentCore and handle one invocation with external session state, the stateless design is real.

## Threats

1. **Thin-layer perception.** Users may ask why this is more than “pi plus a few scripts.” The answer must be visceral DX: point at a folder, get a running service.
2. **Platform absorption.** Claude Agent SDK hosting and OpenCode serve already show that platforms will absorb “run my agent as a service.” FastAgent wins only if its neutrality across engines/models/hosts matters enough.
3. **Standards fragmentation.** FastAgent consumes standards rather than inventing new ones, but the ecosystem may still fragment across several incompatible standards.

## Boundaries

| Boundary | Why |
|---|---|
| Do not compete with OpenClaw on channels/product UX | FastAgent is a layer for building OpenClaw-like products, not the product itself |
| Do not become a code-first SDK | The wedge is “your folder is the agent” |
| Do not invent a parallel agent definition format | Consume `AGENTS.md`, Agent Skills, and MCP rather than competing with them |
| Do not own Task orchestration in core | A2A Tasks/workflows belong above the Agent Handler contract |
| Do not rebuild the harness engine | pi owns the turn loop; FastAgent serves and deploys it |
| Do not weld channels or targets into core | Core owns the contract; adapters own external wires and host-specific deployment |

## One-line summary

FastAgent bets that agent serving needs a WSGI-like neutral layer: small enough to implement everywhere, useful enough to make “deploy this existing agent folder anywhere” feel like the default path.
