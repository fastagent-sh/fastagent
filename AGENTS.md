# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent folders: it turns an existing agent definition (`AGENTS.md` + `skills/`) into a running agent service inside an app, reviewing GitHub PRs, helping users in Telegram, or running behind a custom channel without rewriting it. Engine-neutral, model-neutral, cloud-neutral.

The stable design center is the Agent Handler contract (`docs/SPEC.md`). The reference implementation is built on pi (`@earendil-works/pi-*`).

## Source of truth

| Document | Purpose |
|---|---|
| `docs/SPEC.md` | The locked v0.1 Agent Handler contract. Do not change its semantics without an explicit decision. |
| `docs/design/core.md` | The pi reference implementation and current architecture. |
| `docs/overview.md`, `docs/README.md` | Product overview and documentation index. |
| `CONTRIBUTING.md` | The full GitHub workflow (branch model, PR loop, merge strategy, review tiers). |

Code truth is `core/`.

## Repo map

```
core/
├── src/
│   ├── agent.ts                 # the Agent Handler contract (pure types, no engine import)
│   ├── collect.ts               # buffered consumption helper
│   ├── channels/http.ts         # HTTP/SSE channel (consumes only the Agent contract)
│   ├── cli.ts                   # `fastagent dev` entry point (process side effects live here)
│   ├── index.ts                 # the public API surface (see README "API stability")
│   └── engines/pi/              # the pi reference implementation
│       ├── create.ts            # reusable assembly ladder L1–L2 + engine assets/prompt
│       ├── invoke.ts            # L0 + the request-time turn mechanism (lease, translate, queue)
│       ├── workspace.ts         # shared opener: workspace → agent for dev/start/invoke
│       ├── chat.ts              # `chat` channel: drive pi's interactive TUI with the assembled agent
│       ├── scaffold/            # `init`, `add <channel>`, `add skill`, and scaffold templates
│       ├── tool.ts              # defineTool (Zod) + tools/ filesystem discovery
│       ├── channel.ts           # channels/ filesystem discovery (ChannelModule → Routes)
│       ├── harness.ts           # pi harness wiring (factory)
│       ├── definition.ts        # AGENTS.md + skills loading and bundling
│       ├── config.ts            # fastagent.config.ts loading + model/precedence
│       ├── auth.ts              # pi OAuth / env auth resolution
│       └── sessions.ts          # PiSessionStore port + in-memory/jsonl backends
├── test/                        # vitest; faux models by default
docs/                            # SPEC, design, positioning
```

## DevX Principle Stack

fastagent *is* a developer-experience product: its whole promise is turning an existing agent definition into a service **without rewriting it**. The user is an agent author, and the artifact is their tool. These principles (adapted from [cpojer's Principles of DevX](https://cpojer.net/posts/principles-of-devx)) are a **stack ordered by priority**: the lowest is the foundation we least violate. When two principles conflict, keep the lower one. Violating a principle is sometimes correct — the point is to *name the trade-off* when you do.

1. **Focus on the user (foundation).** The author already has `AGENTS.md` + `skills/`; our job is velocity, not ceremony. Optimize, in order: workflow performance (`dev`/`build`/`start` must be fast), **actionable signal** (every failure surfaces as a `failed` event with a diagnosable message — never a silent fallback or a swallowed throw), reliability, documentation (`init` is complete-by-default so authors self-unblock), and scalability. Do the boring author-facing win over the shiny internal rewrite. Serve tomorrow's author too: prefer changes that keep large/growing definitions maintainable.
2. **Incremental migration.** Both directions. For users: adoption is incremental (existing definition → service, a few rough edges acceptable if the path forward is viable). For us: migrate systems in place; a full rewrite pauses maintenance and usually loses. If you *must* rewrite, say so explicitly and own the risk.
3. **Clarity.** Surface the *right* level of complexity at the best interaction point — do not mask it in the name of "getting out of the way." The `docs/SPEC.md` contract is the narrative; keep plans, APIs, and names plain. It's never too early to share a draft (this is what the PR loop is for) — test changes with whoever has the most context before building.
4. **Re-evaluate assumptions, constraints, trade-offs.** Engine-/model-/cloud-neutrality exists *because* these change. Old code wasn't bad — its constraints differed; gain that context before reshaping it. Be honest that most solutions carry negative trade-offs; refuse the ones that put us in a worse future position, and don't stack complex abstractions on complex systems.
5. **Maximize option value.** Every change should unlock more future options, not fewer. This is the architecture's design center: a neutral contract, clear API boundaries, swappable implementations (the `PiSessionStore` port, `engines/pi/`), and carefully chosen dependencies. Prefer modular seams that let a piece be replaced over monoliths that must move as one.

## Working rules specific to this repo

- **The contract is engine-neutral.** `core/src/agent.ts` must not import any engine (`@earendil-works/pi-*` only under `core/src/engines/`).
- **Fail visibly.** Errors must surface; no swallowed exceptions, no silent fallbacks. On the invoke path, failures become `failed` events (SPEC MUST 2), never thrown iteration errors.
- **Stateless invoke.** Each invoke builds a fresh harness and discards it; durable state lives behind `PiSessionStore`. Do not introduce in-process session state.
- **Public surface is scoped on purpose.** `core/src/index.ts` exports only the supported surface. pi-coupled internals (L0 `createPiAgentFromHarness`, `piHarnessFactory`, assembly helpers) are intentionally not exported — import them from their modules for tests/custom wiring, do not re-export them.
- **The artifact is the truth.** Deployment behavior must come from the bundled definition, not the builder machine's global state.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** Verify locally before opening a PR; do not push to discover bugs in CI.
   ```bash
   cd core && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.
3. **Rebase merge by default** (preserve curated commits); squash only to clean up a WIP branch. Merge commits are disabled. `main` enforces linear history; force-push is forbidden.
4. **Review tiers.** Docs/refactor/tests self-merge after green CI; SPEC, the `Agent` contract, and public API surface wait for review.
5. **After merge:**
   ```bash
   git checkout main && git pull --ff-only && git branch -d <branch> && git fetch --prune origin
   ```

## Communication

The reader is a senior engineer with full project context. Lead with the conclusion, use tables for structured comparisons, skip obvious reasoning, do not restate, and do not add decorative formatting or meta-narration. Density check: if cutting half the text loses no information, cut it.

优先使用中文回答；面向仓库的产物（代码、注释、文档、commit/PR）一律英文。
