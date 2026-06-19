---
title: fastagent — Competitive comparisons
type: competitive-analysis
status: design
updated: 2026-06-18
---

# Competitive comparisons

FastAgent sits in the serving/embedding layer for existing markdown-native agents. The closest neighbors split into two camps: **full agent frameworks/platforms** (Eve, Flue) that you build an agent *product* in, and **adjacent layers** (engines, products, vendor hosting) around the same job.

## The framing that matters: agent-as-a-feature vs agent-as-the-product

The sharpest distinction is not feature count or neutrality — it is *what you are building*:

| | Eve / Flue | FastAgent |
|---|---|---|
| Assumes you are building | an agent **product/platform** (the agent is the thing) | a product with an agent **feature** (the agent is one capability) |
| Posture | **move into their world** (their routing, db, project layout, deploy) | **compose into your world** (one contract + injected ports, either in your app or as a thin service/channel) |
| Integration surface | full project/framework/platform | library API, route handler, webhook/channel adapter, or standalone service |

Most teams that need an agent are not building an agent platform; they are adding an agent feature to a SaaS/web/app or channel. That **agent-as-a-feature** majority is where FastAgent fits and where full frameworks create friction.

## Overview

| Project | What it is | Engine | Neutrality | Web analogy |
|---|---|---|---|---|
| **Eve** (Vercel) | Vertically-integrated agent platform | own harness | Vercel-locked (Sandbox/Workflows/Connect) | agent's **Next.js** |
| **Flue** (Astro team) | Open full-framework for agentic software | **pi** | Open by default (any model/sandbox/deploy), but full-framework-shaped | agent's **Django** |
| **FastAgent** | Serving/embedding contract + reference impl + deploy toolchain | **pi** | Engine/model/host neutral; **library, not framework** | agent's **Flask/WSGI** |
| OpenClaw | Self-hosted personal-assistant product | pi | Product-shaped, not a neutral layer | WordPress-like product |
| Claude Agent SDK hosting | SDK + hosting guidance | Claude | Claude-locked | Vendor SDK hosting |
| OpenCode `serve` | Headless server for OpenCode | OpenCode | OpenCode-locked | Product server |
| pi | Harness engine and coding agent | — | The reference engine FastAgent (and Flue) build on | Werkzeug-like substrate |

**Flue and FastAgent build on the same engine (pi).** Neither has a durable-execution capability the other technically cannot reach — both checkpoint at turn/operation boundaries because pi's turn loop is the shared black box. The difference is product shape, not engine power.

## Eve (Vercel)

Eve is the vertically-integrated bet: an agent is a directory (`instructions.md` + `tools/` + `skills/` + `channels/` + `subagents/` + `schedules/`), and the Vercel platform supplies everything else — AI Gateway, Sandbox, Workflows (durable), Connect (MCP/auth), Chat SDK (channels). Batteries-included, one-click, and locked to Vercel.

FastAgent differs on lock-in and posture: Eve makes you write an *eve agent* and run it on *Vercel*; FastAgent serves/embeds an agent you already have, on any host. Eve is a real competitor only when the user is already all-in on Vercel and wants the platform to do everything.

## Flue (the most direct competitor)

Flue is **not** a code-first workflow tool (an earlier version of this doc was wrong). It is an **open full-framework for agentic software**, built by the Astro team, **on the same pi engine FastAgent uses**. Its stated design principles are: harness-first, **open by default (no lock-in)**, and **AI-first** (built to be used alongside Claude Code/Codex). It ships markdown skills + TypeScript tools + a thin `createAgent`, plus a complete platform: agents (continuing) vs workflows (finite durable runs), sandboxes, subagents, channels (Slack/Teams/Discord/GitHub), MCP, observability, routing (Hono `app.ts`), and a `PersistenceAdapter` database port.

So FastAgent's old differentiators mostly collapse against Flue:

| FastAgent thought its moat was | Against Flue |
|---|---|
| Neutral (engine/model/host) | Flue is also open by default — neutrality is **not** exclusive |
| Built on open pi | Flue is also built on pi |
| Markdown-native, serve coding-agent artifacts | Flue is too, with more mature AI-first DX |
| **Zero-rewrite, just point at a folder** | Only this remains — but the delta is thin: Flue needs a ~10-line `createAgent` + project layout; FastAgent needs a config |
| **Library/thin service, not framework** (transport-neutral `invoke`, no imposed structure) | The one structural difference: Flue is a full framework (imposes routing/db/project layout); FastAgent is a contract + injected ports you compose into your stack or run as a thin channel/service |

The honest difference is **agent-as-a-feature vs agent-as-the-product**: Flue wants to be your app framework; FastAgent wants to be one capability inside your app or channel. Even pairing Flue with Astro — same team, same Vite — still yields *two frameworks to stitch*, because Flue's value is owning the application, not serving one capability with minimal surface area. That is the structural seam FastAgent owns; resource parity (a funded Astro team vs a small project) means FastAgent cannot win on framework breadth, only on this posture.

## OpenClaw

OpenClaw validates a related need: markdown-native, multi-channel, self-hosted assistants are useful. But OpenClaw is a product; the product is the assistant.

FastAgent should not compete on being the best personal assistant. It is the serving/embedding layer someone could use to build OpenClaw-like products for arbitrary definitions and targets.

## Claude Agent SDK hosting and OpenCode serve

These are the platform-absorption examples:

- Claude Agent SDK hosting runs Claude Code programmatically or as a hosted service, but it locks the Claude engine/model path.
- OpenCode `serve` exposes OpenCode as a headless HTTP server, but it locks the OpenCode product.

FastAgent only exists if neutrality matters: the same serving/embedding path should work across different coding-agent artifacts, engines, models, and hosts.

## pi

pi is not the competitor; it is the first engine substrate — and the one **Flue also builds on**. FastAgent's serving/embedding path uses `pi-agent-core`'s `AgentHarness`, adapting pi's two ports (`prompt()` final value + `subscribe()` events) into the single Agent Handler event stream. The `fastagent chat` dev command is intentionally pi-specific and uses pi's interactive session lifecycle for TUI fidelity; it does not change the serving contract. FastAgent should avoid rebuilding pi's harness; its value is the contract, the embed/assembly shape, and host portability around the harness.

## Worked example: an agent feature in an Astro product

A product team is building a SaaS in Astro (with their own auth and Postgres) and wants to add an agent feature.

**With Flue (or Eve):** the agent is a separate framework/service. You run a Flue project (its `src/agents`, `db.ts`, Hono `app.ts`, build, deploy) alongside the Astro app, and stitch two worlds — Flue's db vs your Postgres, Flue's routing/auth vs Astro's, two deploy units.

**With FastAgent:** the agent is one Astro endpoint.

```ts
// src/pages/api/agent.ts (Astro SSR endpoint)
import type { APIRoute } from "astro";
import { agent } from "../../lib/agent.ts"; // createPiAgentFromDefinition('./agent', { sessions: yourPostgres })

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 }); // your auth
  const { session, text } = await request.json();
  const iterator = agent.invoke({ session: `${locals.user.id}:${session}` }, { text })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { value, done } = await iterator.next();
      if (done) return c.close();
      c.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    },
    async cancel() {
      await iterator.return?.(); // client disconnect/cancel → SPEC MUST 3 cleanup
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
};
```

One build, one deploy, one auth, your database. The transport-neutral `invoke` contract (no bundled HTTP framework) is what lets the agent live inside the host's own route. This is the demo that makes the abstract positioning concrete — and the sweet spot is explicit: a relatively *light* agent feature (interactive/generation/trigger-response) in a *TS/Node* product with an *existing stack*. A *heavy* agent (long autonomy, swarm, sandbox isolation, many channels) tilts back toward Flue's batteries-included path even as a feature.

## Summary

FastAgent wins where the job is **"turn an existing agent folder into an agent capability — inside my product, or as Slack/webhook/API infrastructure — without adopting a second framework."** If the user is building an agent *product/platform* — or needs heavyweight durable/swarm/sandbox out of the box — Flue (open) or Eve (Vercel) is the better fit. FastAgent's defensible position is the Flask/WSGI one: a minimal, transport-neutral serving contract plus injected ports (session/auth/env/lease), composed into the user's own stack or deployed as a thin service — promising less, but not annexing the user's architecture.
