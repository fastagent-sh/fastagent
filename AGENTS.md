# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent directories: it turns a file-defined agent (`persona.md` identity, `skills/`, tools, and existing `AGENTS.md` project context) into a running service inside an app, on GitHub, in Telegram, or behind a custom channel without a new authoring DSL.

The stable design center is the engine-neutral Agent Handler contract (`docs/SPEC.md`); pi (`@earendil-works/pi-*`) is the reference implementation.

## Source of truth

| Document | Purpose |
|---|---|
| `docs/SPEC.md` | The locked v0.1 Agent Handler contract. Do not change its semantics without an explicit decision. |
| `docs/design/core.md` | The pi reference implementation and current architecture. |
| `docs/overview.md`, `docs/README.md` | Product overview and documentation index. |
| `CONTRIBUTING.md` | The full GitHub workflow (branch model, PR loop, merge strategy, review tiers). |

Code truth is `src/`.

## Repo map

```
src/
├── agent.ts                 # the Agent Handler contract (pure types, no engine import)
├── collect.ts               # buffered consumption helper
├── core.ts, pi.ts           # lightweight neutral subpath + pi reference-implementation subpath
├── index.ts                 # supported all-in-one public surface (re-exports core + pi)
├── cli.ts                   # command entry points (process side effects live here)
├── invoke-stream.ts, cli-models.ts, cli-auth.ts # command rendering layers (`invoke` stream → exit code, `models`/auth-report output)
├── telegram.ts, github.ts   # subpath-export shims (@fastagent-sh/fastagent/telegram etc. — the supported surface)
├── log.ts                   # leveled logging singleton (dev=debug, start=info)
├── observe.ts               # turn-trace logging around an Agent
├── tunnel.ts                # `--tunnel`: cloudflared + per-channel webhook dispatch
├── dev-supervisor.ts        # `dev` supervisor: restart on code-input edits (definition is live-read per invoke)
├── proxy.ts                 # HTTPS_PROXY wiring
├── env.ts                   # `.env` → process.env loading (missing file is normal; anything else surfaces)
├── runtime.ts               # workspace runtime/package-manager detection (node vs bun) + readPackageJson
├── loader.ts                # neutral ESM module discovery/loading for tools/ channels/ schedules/ config
├── workspace.ts, version.ts # neutral helpers (in-workspace guard, ignore files, version)
├── host/node.ts             # Node HTTP host: Routes/ChannelHandler/serveNode/router (public surface)
├── scaffold/                # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── http.ts              # HTTP/SSE channel (consumes only the Agent contract)
│   ├── body.ts, respond.ts  # channel-authoring kit (body cap, responses)
│   ├── github/              # github channel (+ scaffold/ bundle)
│   └── telegram/            # telegram channel — see docs/design/core.md §9.2
│       ├── telegram.ts      # Telegram wiring: ingress + per-turn lifecycle + composition (pure parsing → parse.ts, run one turn → invoke-turn.ts)
│       ├── parse.ts         # pure protocol parsing: field extraction, prompt envelope, summon/route policy (no state/IO)
│       ├── invoke-turn.ts   # run one turn: assemble inputs (resolve attachments: download/vision) + stream agent.invoke
│       ├── turn-queue.ts    # in-memory per-session serial turns (FIFO; durability layered by turn-store.ts)
│       ├── turn-store.ts    # durable turn intent (L1): persist pre-ACK, replay a crash-surviving turn on next start
│       ├── context-buffer.ts# un-summoned group discussion (durable, commit-on-completed)
│       ├── preview.ts       # live-preview pump + terminal-write policy
│       ├── telegram-api.ts  # the single Bot API pipeline + HTML-aware split
│       ├── state.ts         # atomic state files under .fastagent/channels/telegram/
│       ├── register-webhook.ts # --tunnel setWebhook registration
│       └── scaffold/        # `add telegram` bundle (channel.ts + send tool)
├── deploy/                  # `deploy fly|railway`: host artifacts + runbook + `--run` CLI drive (docs/design/core.md §10.5)
│   │                        # LAYOUT: neutral kernel at top (horizontal) + one dir per host (vertical) — new host = new dir, copy fly/
│   ├── preflight.ts         # host-NEUTRAL pre-flight: model-travel gate (modelTravelIssue), channel discovery, auth probe, container facts + warnings
│   ├── container.ts         # portable Dockerfile + .dockerignore (host-neutral) + the generated-marker predicate
│   ├── secrets.ts           # required-secret NAMES (runbook) + assembleSecrets VALUES (--run credential carry)
│   ├── runner.ts            # the shared host-CLI dispatcher seam (CliRunner + spawnRunner; faked in tests)
│   ├── fly/     { plan.ts, run.ts }  # Fly: PLAN (artifacts + runbook, pure) + `--run` driver (drives flyctl behind the runner seam)
│   └── railway/ { plan.ts, run.ts }  # Railway: same two roles — NOT a copy of Fly (thin config, minted URL, no scriptable scale-to-zero)
├── schedule/               # the N axis, clock form: a time-trigger firing the agent on a cron (schedules/<name>.ts)
│   ├── schedule.ts         # defineSchedule({ cron, tz?, prompt }) authoring surface + types (no session field — it's runtime-derived)
│   ├── cron.ts             # the one place touching `croner` (zero-dep, IANA tz/DST): nextRun + cronError
│   ├── discover.ts         # schedules/ filesystem discovery (loadSchedules/discoverScheduleFiles), isolates a bad file (G2)
│   ├── scheduler.ts        # lifecycle + fire algorithm (overdue catch-up ONCE, claim-before-invoke) + stable per-schedule session + wake-up poll
│   ├── wakeups.ts          # the agent's self-scheduled wake-ups, one-shot + recurring (2nd producer): engine-neutral store + guardrails (min delay/gap, cap, claim/defer)
│   ├── audit.ts            # runs.jsonl append-only run audit (full reply) + `schedule history` reader — "did last night's run silently fail?"
│   └── state.ts            # atomic schedule state under <stateRoot>/schedule/ (fires.json + wakeups.json)
└── engines/pi/              # the pi reference implementation
    ├── create.ts            # reusable assembly ladder L1–L2 + engine assets/prompt
    ├── invoke.ts            # L0 + the request-time turn mechanism (lease, translate, queue)
    ├── workspace.ts         # shared opener: workspace → agent for dev/start/invoke
    ├── chat.ts              # `chat` channel: drive pi's interactive TUI with the assembled agent
    ├── tool.ts              # defineTool (Zod) + tools/ filesystem discovery
    ├── tool-context.ts      # ToolContext.session via AsyncLocalStorage (set around the turn; read in execute — the wake tool's seam)
    ├── wake-tool.ts         # the built-in `wake` tool (pi-coupled: defineTool): writes a wake-up into ToolContext.session; withWakeTool mounts it (serving path only)
    ├── channel.ts           # channels/ filesystem discovery (ChannelModule → Routes)
    ├── harness.ts           # pi harness wiring (factory)
    ├── definition.ts        # AGENTS.md + skills loading and bundling
    ├── config.ts            # fastagent.config.ts loading + model/precedence
    ├── auth.ts, login.ts    # credential store/resolution (project-level auth.json default) + `login` flow
    ├── models.ts            # Models collection wiring
    ├── report.ts            # startup report (auth/model/skills/tools surface)
    └── sessions.ts          # PiSessionStore port + in-memory/jsonl backends
test/                        # vitest; faux models by default + reusable SPEC conformance
docs/                        # SPEC, guides, and maintainer design notes (design/core.md = architecture)
```

## DevX Principle Stack

fastagent *is* a developer-experience product: its whole promise is turning an existing agent definition into a service **without rewriting it**. The user is an agent author, and the artifact is their tool. These principles (adapted from [cpojer's Principles of DevX](https://cpojer.net/posts/principles-of-devx)) are a **stack ordered by priority**: the lowest is the foundation we least violate. When two principles conflict, keep the lower one. Violating a principle is sometimes correct — the point is to *name the trade-off* when you do.

1. **Focus on the user (foundation).** The author already has `AGENTS.md` + `skills/`; our job is velocity, not ceremony. Optimize, in order: workflow performance (`dev`/`start` must be fast), **actionable signal** (every failure surfaces as a `failed` event with a diagnosable message — never a silent fallback or a swallowed throw), reliability, documentation (`init` is complete-by-default so authors self-unblock), and scalability. Do the boring author-facing win over the shiny internal rewrite. Serve tomorrow's author too: prefer changes that keep large/growing definitions maintainable.
2. **Incremental migration.** Both directions. For users: adoption is incremental (existing definition → service, a few rough edges acceptable if the path forward is viable). For us: migrate systems in place; a full rewrite pauses maintenance and usually loses. If you *must* rewrite, say so explicitly and own the risk.
3. **Clarity.** Surface the *right* level of complexity at the best interaction point — do not mask it in the name of "getting out of the way." The `docs/SPEC.md` contract is the narrative; keep plans, APIs, and names plain. It's never too early to share a draft (this is what the PR loop is for) — test changes with whoever has the most context before building.
4. **Re-evaluate assumptions, constraints, trade-offs.** Engine-/model-/cloud-neutrality exists *because* these change. Old code wasn't bad — its constraints differed; gain that context before reshaping it. Be honest that most solutions carry negative trade-offs; refuse the ones that put us in a worse future position, and don't stack complex abstractions on complex systems.
5. **Maximize option value.** Every change should unlock more future options, not fewer. This is the architecture's design center: a neutral contract, clear API boundaries, swappable implementations (the `PiSessionStore` port, `engines/pi/`), and carefully chosen dependencies. Prefer modular seams that let a piece be replaced over monoliths that must move as one.

## Working rules specific to this repo

- **The contract is engine-neutral.** `src/agent.ts` must not import any engine (`@earendil-works/pi-*` only under `src/engines/`).
- **Fail visibly.** Errors must surface; no swallowed exceptions, no silent fallbacks. On the invoke path, failures become `failed` events (SPEC MUST 2), never thrown iteration errors.
- **Stateless invoke.** Each invoke builds a fresh harness and discards it; durable state lives behind `PiSessionStore`. Do not introduce in-process session state.
- **Public surface is scoped on purpose.** `src/core.ts` is engine-neutral, `src/pi.ts` is the pi reference surface, and `src/index.ts` combines them. Pi-coupled internals (L0 `createPiAgentFromHarness`, `piHarnessFactory`, assembly helpers) remain unexported — import them from their modules for tests/custom wiring, do not re-export them.
- **The artifact is the truth.** Deployment behavior must come from the bundled definition, not the builder machine's global state.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** Verify locally before opening a PR; do not push to discover bugs in CI.
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.
3. **Rebase merge by default** (preserve curated commits); squash only to clean up a WIP branch. Merge commits are disabled. `main` enforces linear history; force-push is forbidden.
4. **Review tiers.** Docs/refactor/tests self-merge after green CI; SPEC, the `Agent` contract, and public API surface wait for review.
5. **After merge:**
   ```bash
   git checkout main && git pull --ff-only && git branch -d <branch> && git fetch --prune origin
   ```
6. **Releases publish via npm Trusted Publishing (OIDC), never a local `npm publish`.** The npm package
   must keep its `publish` trusted-publisher binding to `fastagent-sh/fastagent` / `publish.yml`. Flow:
   bump `package.json` in a `chore/release-x.y.z` PR → merge → tag `vX.Y.Z` → create the GitHub Release
   (its notes are the changelog) — `.github/workflows/publish.yml` re-verifies (typecheck + test) and
   publishes to npm from CI. There is no NPM_TOKEN anywhere; a local `npm publish` fails with 401 by
   design.

## Communication

The reader is a senior engineer with full project context. Lead with the conclusion, use tables for structured comparisons, skip obvious reasoning, do not restate, and do not add decorative formatting or meta-narration. Density check: if cutting half the text loses no information, cut it.

优先使用中文回答；面向仓库的产物（代码、注释、文档、commit/PR）一律英文。
