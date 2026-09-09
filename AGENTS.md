# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent directories: it turns a file-defined agent (`persona.md` identity, `skills/`, tools, and existing `AGENTS.md` project context) into a live service inside an app, on GitHub, in Telegram, or behind a custom channel without a new authoring DSL.

The stable design center is the engine-neutral Agent Handler contract (`docs/SPEC.md`); pi (`@earendil-works/pi-*`) is the reference implementation.

## Source of truth

| Document | Purpose |
|---|---|
| `docs/SPEC.md` | The locked v0.1 Agent Handler contract. Do not change its semantics without an explicit decision. |
| `docs/design/core.md` | The pi reference implementation and current architecture. |
| `docs/design/participant-model.md` | When a chat channel speaks, where it answers, what it remembers. Authority for Feishu/Lark + Slack routing. |
| `docs/overview.md`, `docs/README.md` | Product overview and documentation index. |
| `CONTRIBUTING.md` | The full GitHub workflow (branch model, PR loop, merge strategy, review policy). |

Code truth is `src/`.

## Repo map

One line per file: **what it owns**. The reason it is that way lives in the file's own header — the
one place that cannot drift away from the code it explains. Directories that have no header file
(`src/deploy`, `test/live`) point at where theirs lives.

```
src/
├── agent.ts                # the Agent Handler contract (pure types, no engine import)
├── channel.ts              # the Channel contract: ChannelModule / Routes / ChannelHandler / LongConnection*
├── session.ts              # the session-control contract: state/entries/events + dispatch, error codes
├── service.ts              # THE PRODUCT AS ONE CALL — a directory becomes a live service (mountAgentService),
│                           # plus the assembly parts dev/start share: routesFor / mountSessionControl / startSchedules
├── effect-port.ts          # the ONE crossing from a Promise-shaped port into Effect: port / portJoin / portAbort /
│                           # portRequest / portCleanup / PortFailure
├── collect.ts              # caller-side stream helpers: collect + the SPEC cancellation protocol (abortFirstIterator)
├── core.ts, node.ts, pi.ts # the three public layers, by what each costs to import: neutral + zero packages /
│                           # engine-neutral but needs Node / names the engine. Asserted in package-boundary.test.ts
├── index.ts                # supported all-in-one entry (re-exports core + node + session + pi)
├── cli.ts                  # the THIN entry (import-free; lazy-loads cli/program.ts)
├── cli/                    # the CLI, built on clig.dev
│   ├── kernel.ts           # CommandSpec-as-data + the commander adapter (commander appears ONLY here); exit 0/1/2
│   ├── program.ts          # the spec registry — the CLI surface's source of truth; lazy per-command imports
│   ├── invoke-stream.ts    # `invoke`: stream → exit code
│   ├── models-view.ts, auth-view.ts, add-feishu.ts # `models` / auth-report output; `add feishu|lark` onboarding
│   ├── shared.ts, serve.ts # cross-command helpers: serve/bind reporting, tunnel (the ASSEMBLY is service.ts)
│   ├── fail.ts             # the process-exiting failure boundary
│   └── commands/           # one module per command; `deploy` dispatches to one commands/deploy/<host>.ts each
├── telegram.ts, github.ts, # subpath-export shims (@fastagent-sh/fastagent/telegram etc.)
│   slack.ts, feishu.ts,
│   lark.ts
├── bind.ts                 # the ONE reading of a bind address, as the six different questions it is
├── log.ts                  # leveled logging singleton (dev=debug, start=info)
├── session-remote.ts       # remote clients over /control/*: connectSessionControl + connectAgent
├── observe.ts              # turn-trace logging around an Agent
├── tunnel.ts               # `--tunnel`: cloudflared + per-channel webhook dispatch
├── dev-supervisor.ts       # `dev` supervisor: restart on code-input edits (definition is live-read per invoke)
├── proxy.ts                # HTTPS_PROXY wiring
├── open-url.ts             # best-effort "open this in a browser" (callers still print the URL)
├── env.ts                  # `.env` → process.env loading
├── runtime.ts              # agent runtime/package-manager detection (node vs bun) + readPackageJson
├── loader.ts               # neutral ESM discovery/loading + failure reporting for tools/ channels/ schedules/ config
├── paths.ts                # PLACEMENT (which directory is the agent, which is the workspace) + the shared
│                           # path predicates and the machinery paths that follow (.secrets/.state)
├── declared-secrets.ts     # WHICH env vars this agent needs, in ONE shape, wherever it was declared
│                           # (defineTool/defineChannel/defineSchedule + deploy.secrets): the ONE read of
│                           # an authored `secrets:`, the values handed back to the code that declared
│                           # them, and what "has no value" means
├── secrets-gate.ts         # THE refusal: which declarations gate THIS run (all vs one owner), load
│                           # failures reported before it throws, and the shape of that throw
├── atomic-write.ts         # writeFileAtomic: the ONE "whole file or none of it" write
├── version.ts              # package version (deploy pins it into the image)
├── scaffold/               # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── serve.ts            # how a route table becomes a running server: literal-path dispatch, prefix mounts,
│   │                       # the totality boundary, the node:http binding. Shared ground, not a deploy target
│   ├── agentcore-service.ts # the AgentCore serving assembly (same product as service.ts, built for that
│                           # host): channels discovered on trusted ingress, the whole definition opened
│                           # on the first envelope, an external clock, no resident connections
│   ├── agentcore.ts        # the AgentCore Runtime adapter: POST /invocations + GET /ping, the envelope kinds,
│   │                       # and the shared-secret boundary that separates a forwarder call from any IAM one
│   ├── agentcore-protocol.ts # THE WIRE between the forwarder Lambda and the container (types + constants)
│   ├── agentcore-limits.ts # the host's body ceilings, computed once
│   ├── busy.ts             # process-wide background work counter read by /ping (HealthyBusy): a webhook
│                           # ACK does not mean the turn has finished
│   ├── http.ts             # HTTP/SSE channel (consumes only the Agent contract)
│   ├── control.ts          # session-control transport: bearer-token /control/* routes + SSE events + /control/invoke
│   ├── sse.ts              # Fetch-only response lifecycle shared by invoke and observation
│   ├── discover.ts         # channels/ filesystem discovery (ChannelModule → Routes), engine-neutral
│   ├── define-channel.ts   # the channel file's authoring surface: declare secrets, receive their values
│   │                       # (the only way a CUSTOM channel's credentials can reach a deploy)
│   ├── body.ts, respond.ts # channel-authoring kit (body cap, responses)
│   ├── secret.ts           # the ONE constant-time comparison every shared-secret gate reads through
│   ├── wait-health.ts      # readiness probe for a server THIS process reaches directly (not a public URL)
│   ├── registration.ts     # the shared registrar outcome (registered|manual|failed) + the ONE retry loop
│   ├── kit/                # WRITING a channel. Its defining property is an import fact, asserted in
│   │   │                   # package-boundary.test.ts: everything here has consumers only under
│   │   │                   # channels/<platform>/, and serve/http/control/discover have none there
│   │   ├── preview-kit.ts  # pure turn-view reducer, line renderers, preview policies
│   │   ├── delivery.ts     # scoped coalescing previews, ordered native writes, terminal settlement
│   │   ├── event-stream.ts # typed, demand-driven Agent iterator acquisition and scoped cleanup
│   │   ├── invoke-turn-kit.ts # resolve inputs → ask the agent; the background tier's degradation; busy wait;
│   │   │                   # the prompt manifest wording
│   │   ├── transport.ts    # whether a write is worth waiting out a rate limit for (DROPPABLE_FRAME)
│   │   ├── turn-runner.ts  # accept → dequeue → execute → settle over the queue + store + buffer
│   │   ├── turn-queue.ts   # per-session FIFO root fibers; queued work counts busy and survives ingress ACK
│   │   ├── turn-store.ts   # generic durable turn intent (record shape/validator/order injected)
│   │   ├── context-buffer.ts # generic durable un-summoned-discussion buffer (peek→completed→commit)
│   │   ├── thread-participants.ts # who the agent has HEARD in a thread (the summon rule)
│   │   ├── state.ts, seen.ts # atomic channel state + bounded durable delivery dedup
│   │   ├── signature.ts    # replay window for a signed webhook ingress
│   │   ├── tasks.ts        # side-task tracking (ACK-independent work); drain is observation only
│   │   ├── text.ts         # Unicode-safe code-point slicing
│   │   ├── attachment-path.ts # where an attachment lands (the conversation id encoded into a directory)
│   │   └── stop-command.ts # the shared /stop parsing every chat channel accepts
│   ├── github/             # github channel (+ scaffold/ bundle)
│   ├── telegram/           # telegram channel: see docs/design/core.md §7
│   │   ├── telegram.ts     # ingress + per-turn lifecycle + composition
│   │   ├── parse.ts        # pure protocol parsing: fields, prompt envelope, summon/route policy
│   │   ├── invoke-turn.ts  # resolve this platform's attachments for one turn
│   │   ├── turn-store.ts   # telegram's record + update_id arrival order over the generic store
│   │   ├── context-buffer.ts # telegram's entry shape + attachment selection over the generic buffer
│   │   ├── preview.ts      # live-preview pump + terminal-write policy
│   │   ├── telegram-api.ts # the single Bot API pipeline + HTML-aware split
│   │   ├── register-webhook.ts # --tunnel setWebhook registration
│   │   └── scaffold/       # `add telegram` bundle (channel.ts + send tool)
│   ├── slack/              # Slack Agent: native streams + inline tool traces, signed Events API ingress
│   │   ├── slack.ts        # ingress + per-turn lifecycle + composition
│   │   ├── parse.ts, model.ts, reaction.ts # pure protocol parsing/shapes + the reaction vocabulary
│   │   ├── invoke-turn.ts, preview.ts # turn IO + BOTH renderers (native Agent stream, classic edits)
│   │   ├── context-buffer.ts # slack's entry shape + file selection over the generic buffer
│   │   ├── slack-api.ts    # the Bot API pipeline (retry, markdown/text splitting, files)
│   │   ├── shared-api.ts   # the ONE transport per state root the channel and the send tool share
│   │   ├── onboard.ts, setup-server.ts, manifest.ts, config-api.ts, onboarding-state.ts, welcomed.ts,
│   │   │                   # register-webhook.ts # `add slack`: the app-creation flow and what it remembers
│   │   └── scaffold/       # `add slack` bundle
│   ├── feishu/             # CANONICAL Feishu channel engine — see docs/design/core.md
│   │   ├── feishu.ts       # ingress + per-turn lifecycle + composition; Lark binds this engine via a profile
│   │   ├── cloud.ts        # explicit Feishu-reference / Lark-compatibility capability profiles
│   │   ├── model.ts, normalize.ts, parse.ts, crypto.ts, card.ts # protocol/content/policy + security/card
│   │   ├── invoke-turn.ts, preview.ts # turn IO + streaming-card delivery
│   │   ├── context-buffer.ts # feishu's entry shape + resource selection over the generic buffer
│   │   ├── feishu-api.ts   # canonical Open API pipeline (token cache, retry, cardkit)
│   │   ├── ws-ingress.ts   # the long-connection ingress (the WebSocket form of the same engine)
│   │   ├── setup-mode.ts   # the onboarding choices (webhook vs websocket, group visibility)
│   │   ├── shared-api.ts   # channel/send-tool transport sharing per cloud and state root
│   │   ├── register-app.ts # `add feishu`: scan-to-create device flow
│   │   ├── register-webhook.ts, bootstrap-token.ts # event URL + token automation
│   │   └── scaffold/       # `add feishu` bundle
│   └── lark/               # Lark compatibility/degraded edges over the Feishu engine
│       ├── lark.ts         # thin branded adapter bound to LARK_COMPAT_CLOUD
│       ├── onboard.ts      # unbound launcher + credentials + manual config fallback
│       └── scaffold/       # `add lark` bundle
├── deploy/                 # `deploy docker|fly|railway|agentcore` (core.md §9). Neutral kernel at top, one
│   │                       # directory per host. ADDING A HOST: deploy/hosts.ts says what to write and what
│   │                       # to read first
│   ├── hosts.ts            # DEPLOY_HOSTS, the targets as a value + the add-a-host guide
│   ├── channel-ingress.ts  # HOW A RUNNING CHANNEL IS REACHED: default route, who can set that URL, the
│   │                       # words when nobody can. Consumed by every host AND by the serving path
│   ├── registration-gate.ts # host-neutral step-7 gate policy over the registrars' facts
│   ├── preflight.ts        # host-neutral pre-flight: model-travel gate, channel discovery, auth probe, warnings
│   ├── container.ts        # portable image + ignore files + release manifest (host-neutral)
│   ├── workspace.ts        # the deployed lifecycle every host shares: assert the storage is MOUNTED, one
│                           # process lease, recoverable definition replacement (base/ is cwd; .state/ and
│                           # .secrets/ stay outside the definition)
│   ├── secrets.ts          # both directions of the credential carry: the NAMES a runbook lists, the VALUES
│   │                       # `--run` sends, and the seed the container reads back
│   ├── runner.ts           # the shared host-CLI dispatcher seam (CliRunner + spawnRunner; faked in tests)
│   ├── docker/    { plan.ts, run.ts } # Compose topology (agent + optional Quick Tunnel) + the compose driver
│   ├── fly/       { plan.ts, run.ts } # artifacts + runbook (pure) + the flyctl driver
│   ├── railway/   { plan.ts, run.ts } # same two roles — NOT a copy of Fly (thin config, minted URL)
│   └── agentcore/ { plan.ts, run.ts, logs.ts, zip.ts, forwarder.js } # ONE CloudFormation stack: runtime +
│                             # forwarder Lambda (webhooks) + EventBridge rules (schedules). No public URL,
│                             # no resident process, no volume — the facts every difference follows from
├── schedule/               # the N axis, clock form: a time-trigger firing the agent on a cron
│   ├── schedule.ts         # defineSchedule({ cron, tz?, prompt }) authoring surface + types
│   ├── cron.ts             # the one place touching `croner`: nextRun + cronError
│   ├── discover.ts         # schedules/ filesystem discovery; a bad file is isolated
│   ├── scheduler.ts        # the resident clock loops + claim/run/audit; stop cancels waits, claimed turns finish
│   ├── wakeups.ts          # the agent's self-scheduled wake-ups: neutral store + guardrails
│   ├── audit.ts            # runs.jsonl append-only run audit + the `schedule history` reader
│   ├── wake-alarm.ts       # the wake-up's EXTERNAL-clock form: mirrored into one-shot EventBridge schedules
│   └── state.ts            # atomic schedule state under <stateRoot>/schedule/
└── engines/pi/             # the pi reference implementation
    ├── service.ts          # createAgentService: this engine's opener + the neutral mountAgentService
    ├── create.ts           # the assembly ladder L1–L2 as a VALUE (lease, store, session factory, engine thunk)
    ├── turn-kit.ts         # the turn mechanism's pi-class-neutral half: lease, terminals, image prep,
    │                       # the SPEC projection, the observation seam (RunControls + SessionObserver)
    ├── invoke-session.ts   # THE L0: one pi AgentSession per invoke, one settlement, the rich event vocabulary
    ├── session-effects.ts  # scoped lease/session acquisition (SessionBusy is its own tag: control flow, not IO)
    ├── agent-session-factory.ts # the engine binding: assembly → one record per invoke (bindPiSession)
    ├── session-store.ts    # session records on pi's SessionManager: id encoding, publish-on-create, crash repair
    ├── session-inheritance.ts # where a NEW thread starts from when it names a parent (participant-model.md §5)
    ├── session-control.ts  # the pi control hub: observation projections + dispatch
    ├── retry-event.ts      # pi's two retry events → the plane's retry_scheduled (run-scoped or not)
    ├── session-markers.ts  # which journal entries are POSITIONS and which are the plane's own bookkeeping
    ├── session-settings.ts # what a session is SET TO and may be set to (model + thinking level are ONE setting)
    ├── session-builder.ts  # definition-aware builder: assembly → resident pi AgentSessionRuntime (chat's TUI)
    ├── open.ts             # shared opener: directory → agent for dev/start/invoke
    ├── chat.ts             # `chat` channel: drive pi's interactive TUI with the assembled agent
    ├── tool.ts             # defineTool (Zod, incl. deferred: true) + tools/ filesystem discovery
    ├── tool-context.ts     # ToolContext.session + the tool-activation bridge (AsyncLocalStorage)
    ├── search-tools.ts     # built-in search_tools loader for deferred tools
    ├── wake-tool.ts        # the built-in `wake` tool; withWakeTool mounts it (serving path only)
    ├── definition.ts       # AGENTS.md + skills loading and bundling
    ├── config.ts           # fastagent.config.ts loading + model/precedence
    ├── auth.ts, login.ts   # credential store/resolution + the `login` flow
    ├── models.ts           # Models wiring + the agent's OWN models.json (definition-local, so it travels)
    └── report.ts           # startup report (auth/model/skills/tools surface)
test/                       # vitest; faux models by default + reusable SPEC conformance
├── embedding.test.ts       # the docs/embedding.md snippets against REAL express/fastify (why they are devDeps)
└── live/                   # probes for what the offline suite FAKES — see test/live/README.md
docs/                       # SPEC, guides, and maintainer design notes (design/core.md = architecture)
```

## DevX Principle Stack

fastagent *is* a developer-experience product: its whole promise is turning an existing agent definition into a service **without rewriting it**. The user is an agent author, and the artifact is their tool. These principles (adapted from [cpojer's Principles of DevX](https://cpojer.net/posts/principles-of-devx)) are a **stack ordered by priority**: the lowest is the foundation we least violate. When two principles conflict, keep the lower one. Violating a principle is sometimes correct — the point is to *name the trade-off* when you do.

1. **Focus on the user (foundation).** The author already has `AGENTS.md` + `skills/`; our job is velocity, not ceremony. Optimize, in order: workflow performance (`dev`/`start` must be fast), **actionable signal** (every failure surfaces as a `failed` event with a diagnosable message — never a silent fallback or a swallowed throw), reliability, documentation (`init` is complete-by-default so authors self-unblock), and scalability. Do the boring author-facing win over the shiny internal rewrite. Serve tomorrow's author too: prefer changes that keep large/growing definitions maintainable.
2. **Incremental migration.** Both directions. For users: adoption is incremental (existing definition → service, a few rough edges acceptable if the path forward is viable). For us: migrate systems in place; a full rewrite pauses maintenance and usually loses. If you *must* rewrite, say so explicitly and own the risk.
3. **Clarity.** Surface the *right* level of complexity at the best interaction point — do not mask it in the name of "getting out of the way." The `docs/SPEC.md` contract is the narrative; keep plans, APIs, and names plain. It's never too early to share a draft (this is what the PR loop is for) — test changes with whoever has the most context before building.
4. **Re-evaluate assumptions, constraints, trade-offs.** Engine-/model-/cloud-neutrality exists *because* these change. Old code wasn't bad — its constraints differed; gain that context before reshaping it. Be honest that most solutions carry negative trade-offs; refuse the ones that put us in a worse future position, and don't stack complex abstractions on complex systems.
5. **Maximize option value.** Every change should unlock more future options, not fewer. This is the architecture's design center: a neutral contract, clear API boundaries, swappable implementations (the `PiSessionRecordStore` port, `engines/pi/`), and carefully chosen dependencies. Prefer modular seams that let a piece be replaced over monoliths that must move as one.

## Working rules specific to this repo

- **The contract is engine-neutral.** `src/agent.ts` must not import any engine (`@earendil-works/pi-*` only under `src/engines/`).
- **Fail visibly.** Errors must surface; no swallowed exceptions, no silent fallbacks. On the invoke path, failures become `failed` events (SPEC MUST 2), never thrown iteration errors.
- **Per-invoke state is the DEFAULT level, not an axiom.** The serving path binds a fresh `AgentSession` per invoke and disposes it; durable state lives behind `PiSessionRecordStore`. Do not introduce in-process session state *into that path* — it is what satisfies SPEC MUST 6 (no location dependence), which AgentCore and every horizontally-scaled channel host require. The SPEC permits a resident Agent at the cost of portable conformance; if a deployment posture wants one, that is a deliberate level choice with its own bill ([conformance-levels.md](docs/design/conformance-levels.md)), never a quiet drift in this one.
- **Public surface is scoped on purpose.** `src/core.ts` is engine- and runtime-neutral (zero packages), `src/node.ts` is engine-neutral but needs a Node runtime, `src/pi.ts` names the engine, and `src/index.ts` combines all of them. Pi-coupled internals (L0 `createPiAgentFromSession`, `piAgentSessionFactory`, assembly helpers) remain unexported — import them from their modules for tests/custom wiring, do not re-export them.
- **Effect first.** Write with Effect, and with what Effect gives you, rather than hand-rolled async plumbing or a thin wrapper over it.
- **Learn Effect from its source, not from guesses.** The installed `effect@4` ships uncompiled source and its own agent guide: read `node_modules/effect/AGENTS.md` before writing Effect code, and the relevant module under `node_modules/effect/src/` for how an API is actually used ([why](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)). Prefer it over an invented API, a stale memory, or a web search. Read-only reference: never edit it, never import from a path inside it.
- **The artifact is the truth.** Deployment behavior must come from the bundled definition, not the builder machine's global state. Engines have their own opinion about this: pi reads its settings (retry budget, compaction thresholds, default thinking level) from `~/.pi/agent` unless pointed elsewhere, so the binding points it at a definition-scoped path. Any new engine surface that reads "the user's config" gets the same treatment.
- **A session id belongs to the Caller.** `scope.session` is opaque and arbitrary — a telegram group is `-1001234567890`, a feishu thread carries `:` and `/`. What an engine needs to store it (pi rejects all of those as record names, so they are encoded) is storage detail and must not leak back out: a tool asking which conversation it is in gets the id the channel minted, not the record's name.
- **The run plane and the observation plane read the same state, through the same function.** They answer different questions about one session — what will execute, and what to report — so deriving them separately is how they come to disagree. The concrete failures this rule is made of: a turn running on assembly defaults while `state()` reported the recorded override, and one plane refusing a record with a cut parent chain while the other silently ran on the truncated path.
- **A convention with four enforcers has none.** When several call sites must each remember to do a thing, the thing belongs in a function they all call, and that function must REPAIR rather than trust the first writer. `.secrets/` was created by four paths and only one passed `0700` — and `mkdir`'s mode is a no-op on an existing directory, so the careful one (login, which runs last) never applied it: every scaffolded agent held its credentials in a 0755 directory. `ensureSecretsDir` (paths.ts) is that function; `writeFileAtomic` and `sessionToolActivation` are the same lesson from the same review.
- **A shared rule is tested once, where it lives; a caller's test proves only its own wiring.** Four hosts calling one `registerWebhooks` do not each owe a "long-connection is not registered" test — that belongs to `deploy-channel-ingress.test.ts`, and a host test owes the URL it hands over and what it does with the gate. Same for the two SSE routes over one `sseResponse`, the Lark scaffold that is the Feishu one with the cloud swapped, and a chat channel over `channels/kit/turn-*` (its own tests cover the record shape, the ACK boundary, and how a dropped or deferred turn reaches the asker — not the ceiling arithmetic). A list-driven structural guard is likewise ONE test whose assertion names the offending file, not one `it` per file: `package-boundary.test.ts` shed 40 cases that way without losing a line of coverage.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** Verify locally before opening a PR; do not push to discover bugs in CI.
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`. The prefix is also what labels the PR (`.github/labeler.yml`), and CODEOWNERS requests the reviewer — so `gh pr create --base main --assignee @me` is enough. `gh issue create` is the exception: it cannot read the issue forms (`--template` only sees Markdown templates), so pass the fields it would have set — `--type Bug --label bug` (or `Feature`/`enhancement`, `Task`/`chore`).
3. **Squash merge only** (repo settings enforce it): one PR = one commit on `main`; curate the PR title/body — they become the commit message. Branch commits are working state, the PR is the design asset: put the durable *why* there, not in per-commit narration. `main` enforces linear history; force-push is forbidden.
4. **Review policy.** Merging is a maintainer's decision, never an agent's. Green CI makes a PR eligible; report "ready to merge" and stop — merge only when told to. External-contributor PRs are reviewed and merged by a maintainer.
5. **After merge:**
   ```bash
   git checkout main && git pull --ff-only && git branch -d <branch> && git fetch --prune origin
   ```
6. **Releases publish via npm Trusted Publishing (OIDC), never a local `npm publish`.** The npm package
   must keep its `publish` trusted-publisher binding to `fastagent-sh/fastagent` / `publish.yml` /
   environment `npm`. Flow:
   bump `package.json` in a `chore/release-x.y.z` PR → merge → tag `vX.Y.Z` → create the GitHub Release
   (its notes are the changelog) — `.github/workflows/publish.yml` re-verifies (typecheck + test) and
   publishes to npm from CI. There is no NPM_TOKEN anywhere; a local `npm publish` fails with 401 by
   design.

## Communication

The reader is a senior engineer with full project context. Lead with the conclusion, use tables for structured comparisons, skip obvious reasoning, do not restate, and do not add decorative formatting or meta-narration. Density check: if cutting half the text loses no information, cut it.

Everything that lands in or on the repository is English — code, comments, documentation, commit messages, PR titles and bodies, code reviews and review replies, issue discussion, and release notes.
