# fastagent — Agent Guide

## What this is

fastagent is WSGI for agent serving: it turns an existing agent definition (`AGENTS.md` + `skills/`) into a production service without rewriting it. Engine-neutral, model-neutral, cloud-neutral.

The stable design center is the Agent Handler contract (`docs/SPEC.md`). The reference implementation is built on pi (`@earendil-works/pi-*`).

## Source of truth

| Document | Purpose |
|---|---|
| `docs/SPEC.md` | The locked v0.1 Agent Handler contract. Do not change its semantics without an explicit decision. |
| `docs/core-design.md` | The pi reference implementation and current architecture. |
| `docs/fastagent.md` | Product overview and documentation index (landing page; `status: design`). |
| `docs/session.md` | Draft session-admin model (not implemented; do not treat as built). |
| `docs/positioning.md`, `docs/comparisons.md` | Strategy and competitive framing. |
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
│       ├── create.ts            # L1–L3 assembly ladder + engine assets/prompt
│       ├── invoke.ts            # L0 + the request-time turn mechanism (lease, translate, queue)
│       ├── harness.ts           # pi harness wiring (factory)
│       ├── definition.ts        # AGENTS.md + skills loading and bundling
│       ├── config.ts            # fastagent.config.ts loading + model/precedence
│       ├── auth.ts              # pi OAuth / env auth resolution
│       └── sessions.ts          # PiSessionStore port + in-memory/jsonl backends
├── test/                        # vitest; faux models by default
└── examples/                    # library + config usage
docs/                            # SPEC, design, positioning
```

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
