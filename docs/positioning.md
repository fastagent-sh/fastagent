---
title: fastagent — Positioning
type: product-positioning
status: design
updated: 2026-06-18
---

# fastagent positioning

## North star

You already have an agent: a folder with `AGENTS.md`, `skills/`, and standard markdown assets. FastAgent turns it into a running capability **without rewriting it**, in either of two equally valid postures:

- **Embed into an existing product**: the agent is one capability inside a product you already have. `createPiAgent(...).invoke(...)` lives in your own route (Astro/Next/Hono endpoint), wired to *your* session store, *your* auth, *your* host. No second framework.
- **Serve as a standalone agent service**: the agent runs while you are away — webhook handler, scheduled worker, Slack/Telegram bot, API endpoint, or cloud-hosted agent.

FastAgent is **Flask/WSGI for agents**: a neutral `invoke` contract + injected ports (session/auth/env/lease) + a pi-based reference implementation + a deployment toolchain. Library, not framework — it composes into the user's stack **or** runs as a thin standalone service without owning the whole application. The bigger, under-served job is **agent-as-a-feature** (add an agent to a product or channel), not agent-as-a-platform (adopt a full framework to build the whole agent product).

It is **not**:

- a code-first agent SDK,
- a new agent definition format,
- a batteries-included assistant product,
- a replacement for the harness engine.

## Primary user wedge

The sharpest segment is someone who **already has a stack** (their own auth/DB/host) and wants to add an agent **feature** without adopting a second framework. In the vibe-coding era this is no longer enterprise-only — every solo dev has an AI-assembled stack (Supabase + Clerk + Next/Astro + Vercel), so "has a stack, wants to embed" is the default state.

| Segment | Fit | Risk |
|---|---|---|
| **Vibe-coded product needing an agent feature** (esp. TS/Astro/Next, existing stack) | **Highest fit**: embed one endpoint, inject existing session/auth, one deploy unit | Heavy agent needs (long autonomy/swarm/sandbox) tilt back to Flue's batteries-included path |
| Individual/power user with useful local agent definitions | High fit: markdown-native, zero rewrite | Standalone-deploy need may be shallower than the number of people creating folders |
| Teams building an agent *product/platform* | Real need, budget | This is Flue/Eve's home turf; FastAgent should not chase it |

The story must focus on **"add an agent to the product I already have, on the stack I already chose"** (embed) and **"make this agent act while I am away"** (deploy). Generic “productionize your agent” is weaker, and “build an agent platform” is the wrong fight.

## Market read

Two product shapes now own the markdown-native agent space:

- **Eve** (Vercel): a vertically-integrated platform, batteries-included, locked to Vercel.
- **Flue** (Astro team): an open full-framework **on the same pi engine FastAgent uses** — markdown-native, neutral (any model/sandbox/deploy), AI-first. Flue is the most direct competitor; it is **not** a code-first workflow tool (an earlier read was wrong). See [comparisons](comparisons.md).

The remaining code-first orchestration layers (LangGraph, Vercel AI SDK, Mastra, CrewAI, OpenAI Agents SDK, Cloudflare Agents) sit in a different lane: you script the agent, you don't point at a folder.

Because Flue already occupies "markdown-native + neutral + deploy-anywhere full framework," the open gap narrows to:

> serving an existing agent definition as one capability — either embedded inside a product's own stack or deployed as a thin standalone service/channel — with no second framework, no imposed routing/db/project layout, and a transport-neutral contract underneath.

ACP and A2A are important standards, but they sit next to this gap:

- ACP assumes an editor/client environment and human-in-the-loop interaction.
- A2A assumes an already-running agent endpoint.
- Neither specifies how a trigger invokes an arbitrary local agent definition as a deployable service.

## Competitive moat

The moat is not code volume (the engine is pi, which Flue also uses). The durable value:

1. a small, **transport-neutral** serving contract (`invoke`) with no bundled HTTP framework — so it embeds into the host's own route (Astro/Next/Hono/Lambda), where a full framework would impose its world;
2. **composability over batteries** (Flask, lib-not-framework): K-axis ports (session/auth/env/lease) injected, so the user wires *their* stack instead of adopting ours — the value the "already has a stack" segment actually wants;
3. stateless multi-session execution that can move across hosts;
4. target adapters that encode hard runtime differences.

**Proof points today:** embed in an Astro/Next route — one endpoint, injected session/auth, one deploy unit (see [comparisons](comparisons.md)); and `build`/`start` — an `AGENTS.md` + `skills/` folder running as a standalone service with sessions outside the artifact. Both prove the same thing: a small serving contract can either compose into an app or run as its own service.

**Planned target proof:** AgentCore — same artifact shape, external sessions, and distributed locking — remains target-adapter work, not a current capability.

**Direction (a bet, not yet built): the composability flywheel.** Because each port is a small, stable interface with a conformance suite, writing an adapter for a long-tail stack (your Postgres/Supabase/Convex session store, your auth) becomes an AI-fillable, self-verifiable task. The growth model is not "official builds every N×M×K cell" (unwinnable vs a funded team) but "anyone fills their own cell with an AI agent, and conformance proves it correct." This requires per-port conformance suites + seed adapters + a light registry — not yet built; treat as the intended lever, not a current capability.

## Threats

1. **Flue (the head-on threat).** Same engine (pi), also neutral/open, markdown-native, AI-first DX, funded Astro team, 1.0 beta. FastAgent cannot win on framework breadth or neutrality (Flue has both). It can only win on **posture**: library-not-framework, compose-or-serve without owning the app, no imposed structure. If Flue ships a "point at a folder" mode, even the zero-rewrite delta narrows — the defensible line is then thin serving layer vs full framework ownership.
2. **Vibe-coding consumer-side headwind.** When AI selects a framework for a new project, batteries-included (Flue/Eve) generates more deterministically than composition (every injected choice is a decision the AI can get wrong). FastAgent should not fight in the "recommend a framework" lane; its AI-distribution bet is the "embed into the folder/stack I already have" trigger, which originates inside the coding agent — and requires AI-first docs (llms.txt / paste-into-agent) plus a zero-decision default path, both currently missing.
3. **Thin-layer perception.** Users may ask why this is more than “pi plus a few scripts.” The answer is visceral DX: embed one endpoint into your product, or point at a folder and get a running service.
4. **Platform absorption.** Claude Agent SDK hosting and OpenCode serve show platforms will absorb “run my agent as a service.” FastAgent wins only if neutrality across engines/models/hosts matters enough.
5. **Standards fragmentation.** FastAgent consumes standards rather than inventing them, but the ecosystem may still fragment.

## Boundaries

| Boundary | Why |
|---|---|
| Do not compete with OpenClaw on channels/product UX | FastAgent is a layer for building OpenClaw-like products, not the product itself |
| Do not become a code-first SDK | The wedge is “your folder is the agent” |
| Do not become a full framework (own routing/db/project layout) | The wedge is **compose into your stack or serve this folder**, not own-the-app — that is Flue/Eve's lane. Stay library/thin service, not framework |
| Do not invent a parallel agent definition format | Consume `AGENTS.md`, Agent Skills, and MCP rather than competing with them |
| Do not own Task orchestration in core | A2A Tasks/workflows belong above the Agent Handler contract |
| Do not rebuild the harness engine | pi owns the turn loop; FastAgent serves and deploys it |
| Do not weld channels or targets into core | Core owns the contract; adapters own external wires and host-specific deployment |

## One-line summary

FastAgent bets that the bigger, under-served job is turning an existing agent folder into an **agent feature** — a Flask/WSGI-like neutral contract + injected ports, small enough to drop into any route, deployable enough to run as Slack/webhook/API infrastructure, and composable enough that “add an agent to my stack, or deploy this folder anywhere” feels like the default path — without adopting a second framework or annexing the user's architecture.
