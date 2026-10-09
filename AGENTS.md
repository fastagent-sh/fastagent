# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent directories: it turns a file-defined agent (`SYSTEM.md` / `APPEND_SYSTEM.md` prompt, `skills/`, tools, and existing `AGENTS.md` project context) into a live service inside an app, in Telegram, Slack or Feishu, or behind a custom channel without a new authoring DSL.

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
├── once.ts                 # work that runs once per process, its outcome shared (shutdown, AgentCore activation)
├── collect.ts              # caller-side stream helpers: collect + the SPEC cancellation protocol (abortFirstIterator)
├── core.ts, node.ts, pi.ts # the three public layers, by what each costs to import: neutral + zero packages /
│                           # engine-neutral but needs Node / names the engine. Asserted in package-boundary.test.ts
├── index.ts                # supported all-in-one entry (re-exports core + node + session + pi)
├── cli.ts                  # the THIN entry (import-free; lazy-loads cli/program.ts)
├── cli/                    # the CLI, built on clig.dev
│   ├── kernel.ts           # CommandSpec-as-data + the commander adapter (commander appears ONLY here); exit 0/1/2
│   ├── program.ts          # the spec registry — the CLI surface's source of truth; lazy per-command imports
│   ├── invoke-stream.ts    # `invoke`: stream → exit code
│   ├── models-view.ts, auth-view.ts, contexts-view.ts # `models` / auth-report / contexts output
│   ├── add-feishu.ts, add-slack.ts # `add feishu|lark` / `add slack` onboarding
│   ├── shared.ts, serve.ts # cross-command helpers: serve/bind reporting, tunnel (the ASSEMBLY is service.ts)
│   ├── fail.ts             # the process-exiting failure boundary
│   ├── login-relay.ts      # `login` split across a process boundary: LoginIO as JSON lines, box half + terminal half
│   ├── box-login.ts        # `login --deployment`: the login runs ON the deployed box, through the host's own shell
│   └── commands/           # one module per command; `deploy` dispatches to one commands/deploy/<host>.ts each
├── telegram.ts, slack.ts,  # subpath-export shims (@fastagent-sh/fastagent/telegram etc.)
│   feishu.ts, lark.ts
├── bind.ts                 # the ONE reading of a bind address, as the six different questions it is
├── log.ts                  # leveled logging singleton (dev=debug, start=info)
├── session-remote.ts       # remote clients over /control/*: connectSessionControl + connectAgent
├── observe.ts              # turn-trace logging around an Agent
├── tunnel.ts               # `--tunnel`: cloudflared + per-channel webhook dispatch
├── dev-supervisor.ts       # `dev` supervisor: restart on code-input edits (definition is live-read per invoke)
├── proxy.ts                # the process's outbound-fetch policy: the declared proxy, loopback exempt by default
├── open-url.ts             # best-effort "open this in a browser" (callers still print the URL); only https or
│                           # loopback http reaches the opener, because some URLs come from a deployed box
├── env.ts                  # ENTERING an agent's environment: its `.env` → process.env, and the egress that follows
├── serving-command.ts      # which command serves this process (`dev` marks it): the default a channel's ingress
│                           # setting falls back to, read through the process environment the CLI and the agent share
├── runtime.ts              # agent runtime/package-manager detection (node vs bun) + readPackageJson
├── loader.ts               # neutral ESM discovery/loading + failure reporting for tools/ channels/ config
├── paths.ts                # ADDRESSING (which directory is the agent: the one named, never searched for) + the
│                           # shared path predicates and the machinery paths that follow (.secrets/.state/.contexts)
├── contexts/               # what an agent works on and knows — engine-neutral
│   ├── declare.ts          # the `contexts` declaration read and refused in ONE place (names, nesting)
│   ├── resolve.ts          # where each context is for THIS instance: the one answer every reader uses
│   ├── git.ts              # a GitHub context's git: which repository a checkout is of, its ref, a fresh clone
│   ├── source.ts           # what a command's <source> declares (github:owner/repo, a checkout, a directory)
│   └── config-text.ts      # the literal `contexts: [...]` block `fastagent context` rewrites
├── declared-secrets.ts     # WHICH env vars this agent needs, in ONE shape, wherever it was declared
│                           # (defineTool/defineChannel): the ONE read of
│                           # an authored `secrets:`, the values handed back to the code that declared
│                           # them, and what "has no value" means
├── secrets-gate.ts         # THE refusal: which declarations gate THIS run (all vs one owner), load
│                           # failures reported before it throws, and the shape of that throw
├── atomic-write.ts         # writeFileAtomic: the ONE "whole file or none of it" write
├── version.ts              # package version (deploy pins it into the image)
├── scaffold/               # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── serve.ts            # how route tables become a running server, split by WHO AUTHENTICATES THE CALLER:
│   │                       # ours (nobody) vs the channels' (their platform's signature), one table each so the
│   │                       # answer cannot drift. Both guards on the first table live here — the JSON body gate
│   │                       # and the one CORS decision (`*`, narrowed only by http.cors) — plus literal-path
│   │                       # dispatch, prefix mounts, the totality boundary, the node:http binding
│   ├── agentcore-service.ts # the AgentCore serving assembly (same product as service.ts, built for that
│                           # host): channels discovered on trusted ingress, the whole definition opened
│                           # on the first envelope, an external clock, no resident connections
│   ├── agentcore.ts        # the AgentCore Runtime adapter: POST /invocations + GET /ping, the envelope kinds,
│   │                       # and the shared-secret boundary that separates a forwarder call from any IAM one
│   ├── agentcore-protocol.ts # THE WIRE between the forwarder Lambda and the container (types + constants)
│   ├── agentcore-limits.ts # the host's body ceilings, computed once
│   ├── busy.ts             # the process's work in flight (every leased session, channel work not yet at one),
│                           # read by /ping (HealthyBusy) and by `dev` before it restarts: an ACK is not the end
│                           # of a turn
│   ├── http.ts             # the DATA plane: POST /invoke, HTTP/SSE (consumes only the Agent contract)
│   ├── control.ts          # session-control transport: the /control/* route table + SSE events. PURE control —
│   │                       # running a turn is http.ts's, and NOTHING fastagent serves authenticates
│   ├── sse.ts              # Fetch-only response lifecycle shared by invoke and observation
│   ├── discover.ts         # channels/ filesystem discovery (ChannelModule → Routes), engine-neutral
│   ├── define-channel.ts   # the channel file's authoring surface: declare secrets, receive their values
│   │                       # (the only way a CUSTOM channel's credentials can reach a deploy)
│   ├── body.ts, respond.ts # channel-authoring kit (body cap, the JSON content-type gate serve.ts applies, responses)
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
│   │   ├── transport.ts    # whether a call is worth waiting out a rate limit for (DROPPABLE_FRAME, CONTEXT_READ)
│   │   ├── turn-runner.ts  # accept → dequeue → execute → settle over the queue + store + discussion source
│   │   ├── turn-queue.ts   # per-session FIFO root fibers; queued work counts busy and survives ingress ACK
│   │   ├── turn-store.ts   # generic durable turn intent + the answer owed to it (record shape/validator/order injected)
│   │   ├── room-threads.ts # what a thread-reading tool may read: its turn's room (registered by the turn runner),
│   │   │                   # never one it is told; the thread list's format and bound
│   │   ├── place-history.ts # the DiscussionSource a turn folds + the place-history fold (budget, labels) + what a
│   │   │                   # place remembers between platform reads (cursor, the turns' own outputs)
│   │   ├── context-buffer.ts # generic durable un-summoned-discussion buffer (peek→completed→commit)
│   │   ├── thread-participants.ts # who the agent has HEARD in a thread (the summon rule)
│   │   ├── state.ts, seen.ts # atomic channel state + bounded durable delivery dedup
│   │   ├── signature.ts    # replay window for a signed webhook ingress
│   │   ├── tasks.ts        # side-task tracking (ACK-independent work); drain is observation only
│   │   ├── text.ts         # Unicode-safe code-point slicing
│   │   ├── attachment-path.ts # where an attachment lands (the conversation id encoded into a directory)
│   │   └── stop-command.ts # the shared /stop parsing every chat channel accepts
│   ├── telegram/           # telegram channel: see docs/design/core.md §7
│   │   ├── telegram.ts     # ingress + per-turn lifecycle + composition
│   │   ├── parse.ts        # pure protocol parsing: fields, prompt envelope, summon/route policy
│   │   ├── invoke-turn.ts  # resolve this platform's attachments for one turn
│   │   ├── turn-store.ts   # telegram's record + update_id arrival order over the generic store
│   │   ├── context-buffer.ts # telegram's entry shape + attachment selection over the generic buffer
│   │   ├── preview.ts      # live-preview pump + terminal-write policy
│   │   ├── telegram-api.ts # the single Bot API pipeline + HTML-aware split
│   │   ├── shared-api.ts   # the ONE transport per state root the channel and the send tool share; records what
│   │   │                   # the agent sends itself into that chat's discussion (no update ever echoes it)
│   │   ├── register-webhook.ts # --tunnel setWebhook registration
│   │   └── scaffold/       # `add telegram` bundle (channel.ts + send tool)
│   ├── slack/              # Slack Agent: native streams + inline tool traces, signed Events API ingress
│   │   ├── slack.ts        # ingress + per-turn lifecycle + composition
│   │   ├── parse.ts, model.ts, reaction.ts # pure protocol parsing/shapes + the reaction vocabulary
│   │   ├── invoke-turn.ts, preview.ts # turn IO + BOTH renderers (native Agent stream, classic edits)
│   │   ├── history.ts      # a place's history: conversations.history (top level) / .replies (a thread)
│   │   ├── slack-api.ts    # the Bot API pipeline (retry, markdown/text splitting, files, history reads)
│   │   ├── shared-api.ts   # the ONE transport per state root the channel and the send tool share
│   │   ├── onboard.ts, setup-server.ts, manifest.ts, config-api.ts, onboarding-state.ts, welcomed.ts,
│   │   │                   # register-webhook.ts # `add slack`: the app-creation flow and what it remembers
│   │   └── scaffold/       # `add slack` bundle (channel.ts + slack-send + slack-threads)
│   ├── feishu/             # CANONICAL Feishu channel engine — see docs/design/core.md
│   │   ├── feishu.ts       # ingress + per-turn lifecycle + composition; Lark binds this engine via a profile
│   │   ├── cloud.ts        # explicit Feishu-reference / Lark-compatibility capability profiles
│   │   ├── model.ts, normalize.ts, parse.ts, crypto.ts, card.ts # protocol/content/policy + security/card
│   │   ├── invoke-turn.ts, preview.ts # turn IO + streaming-card delivery
│   │   ├── history.ts      # a place's history read from the platform (cursor, own-output exclusion, names)
│   │   ├── feishu-api.ts   # canonical Open API pipeline (token cache, retry, cardkit)
│   │   ├── ws-ingress.ts   # the long-connection ingress (the WebSocket form of the same engine)
│   │   ├── setup-mode.ts   # the onboarding choice (webhook vs websocket) + the scopes every agent app asks for
│   │   ├── shared-api.ts   # channel/send-tool transport sharing per cloud and state root
│   │   ├── register-app.ts # `add feishu`: scan-to-create device flow
│   │   ├── register-webhook.ts, bootstrap-token.ts # event URL + token automation
│   │   └── scaffold/       # `add feishu` bundle (channel + feishu-send + feishu-threads)
│   └── lark/               # Lark compatibility/degraded edges over the Feishu engine
│       ├── lark.ts         # thin branded adapter bound to LARK_COMPAT_CLOUD
│       ├── onboard.ts      # unbound launcher + credentials + manual config fallback
│       └── scaffold/       # `add lark` bundle
├── deploy/                 # `deploy docker|fly|railway|agentcore` (core.md §9). Neutral kernel at top, one
│   │                       # directory per host. ADDING A HOST: deploy/hosts.ts says what to write and what
│   │                       # to read first
│   ├── hosts.ts            # DEPLOY_HOSTS, the targets as a value + the add-a-host guide
│   ├── residency.ts        # what forbids scaling to zero: ONE rule every host that can scale reads
│   ├── channel-ingress.ts  # HOW A RUNNING CHANNEL IS REACHED: default route, who can set that URL, the
│   │                       # words when nobody can (or when a box's login stopped registration). Consumed by
│   │                       # every host AND by the serving path
│   ├── registration-gate.ts # host-neutral step-7 gate policy over the registrars' facts
│   ├── preflight.ts        # host-neutral pre-flight: model-travel gate, channel discovery, auth probe, warnings
│   ├── build-context.ts    # what the build context holds that must not ship, and what a KEPT ignore file lets through
│   ├── container.ts        # portable image + ignore files + release manifest (host-neutral), and the one command
│   │                       # that runs `login --stdio` inside that image where its server runs
│   ├── workspace.ts        # the deployed lifecycle every host shares: assert the storage is MOUNTED, one
│                           # process lease, recoverable definition replacement (definition/ is cwd; .state/
│                           # and .secrets/ stay beside it)
│   ├── secrets.ts          # both directions of the value carry: the NAMES a runbook lists, the VALUES
│   │                       # `--run` sends, and the FASTAGENT_ENV the container expands back
│   ├── runner.ts           # the shared host-CLI dispatcher seam (CliRunner + spawnRunner; faked in tests)
│   ├── box-shell.ts        # a running box's owner-authenticated shell as a byte channel (`login --deployment`)
│   ├── docker/    { plan.ts, run.ts } # Compose topology (agent + optional Quick Tunnel) + the compose driver
│   ├── fly/       { plan.ts, run.ts } # artifacts + runbook (pure) + the flyctl driver
│   ├── railway/   { plan.ts, run.ts } # same two roles — NOT a copy of Fly (thin config, minted URL)
│   └── agentcore/ { plan.ts, run.ts, destroy.ts, aws-cli.ts, logs.ts, shell.ts, zip.ts, forwarder.js } # ONE stack:
│                             # runtime + forwarder Lambda (webhooks, and the alarms the container sets). No public
│                             # URL, no resident process, no volume — the facts every difference follows from.
│                             # destroy.ts is the other direction, and it exists because three of the four
│                             # resources cannot be stack resources. aws-cli.ts owns what ONE AWS CLI result
│                             # MEANS — there / gone / could not find out — because eleven call sites each
│                             # deciding that produced the same defect five review rounds running. Every AWS
│                             # read that asks "is it there, and could I tell" goes through it. shell.ts is the
│                             # command-shell WebSocket `login --deployment` speaks (SigV4 presigned, AWS CLI creds)
├── schedule/               # the N axis: prompts on a cron and the clock that fires them
│   ├── schedule.ts         # a schedule as loaded ({ name, cron, tz?, prompt }) + its one session, schedule:<name>
│   ├── cron.ts             # the one place touching `croner`: nextRun + cronError
│   ├── discover.ts         # schedules/<name>.md discovery: a strict cron/tz frontmatter over the prompt
│   ├── scheduler.ts        # the resident clock loops + claim/run/settle; stop cancels waits, claimed turns finish
│   ├── wakeups.ts          # the agent's self-scheduled wake-ups: neutral store + guardrails
│   ├── wake-alarm.ts       # the EXTERNAL-clock form of both: schedules as recurring EventBridge schedules,
│   │                       # wake-ups as one-shots
│   ├── eventbridge-cron.ts # a cron in EventBridge's dialect; discovery refuses what it cannot express
│   └── state.ts            # schedule state under <stateRoot>/schedule/, incl. THE claim: the decision to fire,
│                           # the outcome written back into it, and therefore the whole (bounded) fire history
└── engines/pi/             # the pi reference implementation
    ├── service.ts          # createAgentService: this engine's opener + the neutral mountAgentService
    ├── create.ts           # the assembly ladder L1–L2 as a VALUE (lease, store, session factory, engine thunk)
    ├── turn-kit.ts         # the turn mechanism's pi-class-neutral half: lease, terminals, image prep,
    │                       # the SPEC projection, the observation seam (RunControls + SessionObserver)
    ├── invoke-session.ts   # THE L0: one pi AgentSession per invoke, one settlement, the rich event vocabulary
    ├── session-effects.ts  # scoped lease/session acquisition (SessionBusy is its own tag: control flow, not IO)
    ├── agent-session-factory.ts # the engine binding: assembly → one record per invoke (bindPiSession)
    ├── session-store.ts    # session records on pi's SessionManager: id encoding, publish-on-create
    ├── session-inheritance.ts # where a NEW thread starts from when it names a parent (participant-model.md §5)
    ├── session-control.ts  # the pi control hub: observation projections + dispatch
    ├── retry-event.ts      # pi's two retry events → the plane's retry_scheduled (run-scoped or not)
    ├── session-markers.ts  # which journal entries are POSITIONS, which are the plane's own bookkeeping, and
    │                       # which are conversation turns (vs the engine's own `system` entries)
    ├── entry-images.ts     # which images an entry publishes, their refs, and the read back from a ref
    ├── session-settings.ts # what a session is SET TO and may be set to (model + thinking level are ONE setting)
    ├── session-builder.ts  # definition-aware builder: assembly → resident pi AgentSessionRuntime (chat's TUI)
    ├── open.ts             # shared opener: directory → agent for dev/start/invoke
    ├── chat.ts             # `chat` channel: drive pi's interactive TUI with the assembled agent (its own records,
    │                       # in pi's per-directory location — a SERVED record belongs to the process serving it)
    ├── tool.ts             # defineTool (Zod input/output + native exposure) + tools/ filesystem discovery
    ├── tool-context.ts     # ToolContext.session + the tool-activation bridge (AsyncLocalStorage)
    ├── wake-tool.ts        # the built-in `wake` tool; withWakeTool mounts it (serving path only)
    ├── definition.ts       # AGENTS.md + skills loading and bundling
    ├── machine.ts          # the machine an agent inherits: its skills, prompt templates (installed pi packages
    │                       # included — never installed by us), engine settings and which Pi built-in extensions
    │                       # (codemode, tool-search; never mcp) stay enabled, read once per process
    ├── config.ts           # fastagent.config.ts loading + model/precedence
    ├── authoring.ts        # creating an agent + editing its contexts as an API; `init`/`context` are thin wrappers
    ├── auth.ts, login.ts   # the credentials file store + which files an agent reads; the `login` flow
    ├── locked-file.ts      # the cross-process locked read-modify-write that REPLACES a file (credentials, model
    │                       # catalogs), pi's lock included, so every reader of those files reads without one
    ├── models.ts           # the registry: the agent's OWN models.json and models-store.json (definition-local,
    │                       # so they travel), layered over the machine's ~/.fastagent/ pair (environment, never
    │                       # shipped); the explicit model-catalog refresh
    ├── openai-account-models.ts # a ChatGPT sign-in lists its ACCOUNT's models: catalog read at login/refresh,
    │                       # kept on the credential, applied by wrapping pi's `openai` provider in every registry
    ├── live-extensions.ts  # whether pi's cached extension code is current: per process and directory, dropped before
    │                       # any load when extensions/ changed, so every reader loads the code on disk
    ├── agent-models.ts     # an agent's model environment as ONE value (credential store + registry + auth
    │                       # status): every reader builds it through `agentModels`, never from the parts
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
- **The artifact carries the agent; the machine lends it an environment.** What a definition declares — its prompt files, `AGENTS.md`, `tools/`, `channels/`, `schedules/`, its own `skills/` — is the artifact and must come from the bundle, never from the builder's global state. What the box supplies is inherited, the way `bash` already inherits the `PATH`: pi's skills, prompt templates and engine settings (retry budget, compaction thresholds, cache warming) come from `~/.pi/agent` in every posture, including a container, whose environment is whatever its image was built with. The line is not "definition vs machine" but IDENTITY vs ENVIRONMENT — a system prompt from someone's laptop would make the agent theirs, so that one is overridden. Deploying ships the project scope; the environment is not compared against a deployment, the same way nobody is told their local `ffmpeg` is not in the image.
- **A session id belongs to the Caller.** `scope.session` is opaque and arbitrary — a telegram group is `-1001234567890`, a feishu thread carries `:` and `/`. What an engine needs to store it (pi rejects all of those as record names, so they are encoded) is storage detail and must not leak back out: a tool asking which conversation it is in gets the id the channel minted, not the record's name.
- **The run plane and the observation plane read the same state, through the same function.** They answer different questions about one session — what will execute, and what to report — so deriving them separately is how they come to disagree. The concrete failures this rule is made of: a turn running on assembly defaults while `state()` reported the recorded override, and one plane refusing a record with a cut parent chain while the other silently ran on the truncated path.
- **A convention with four enforcers has none.** When several call sites must each remember to do a thing, the thing belongs in a function they all call, and that function must REPAIR rather than trust the first writer. `writeFileAtomic` and `sessionToolActivation` are that shape.
- **A shared rule is tested once, where it lives; a caller's test proves only its own wiring.** Four hosts calling one `registerWebhooks` do not each owe a "long-connection is not registered" test — that belongs to `deploy-channel-ingress.test.ts`, and a host test owes the URL it hands over and what it does with the gate. Same for the two SSE routes over one `sseResponse`, the Lark scaffold that is the Feishu one with the cloud swapped, and a chat channel over `channels/kit/turn-*` (its own tests cover the record shape, the ACK boundary, and how a dropped or deferred turn reaches the asker — not the ceiling arithmetic). A list-driven structural guard is likewise ONE test whose assertion names the offending file, not one `it` per file: `package-boundary.test.ts` shed 40 cases that way without losing a line of coverage.

- **A test that asserts "X must not happen" is unproven until X has happened.** Run the mutation that makes it happen and watch the test fail; a green suite says nothing about a claim the test cannot observe. The failure mode is specific: a test DOUBLE that omits part of the contract it stands in for. Two fake `fetch`es here ignored `init.signal`, so "the client does not kill a healthy connection" stayed green under a change that killed every one of them — the doubles reported on bytes and could not see teardown at all. Hence one `fakeSse` in `control-http.test.ts` rather than a fake per case: a clause several hand-written doubles must each remember is a clause some of them will not.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** While iterating, run the test files for the code you changed (`npx vitest run test/<file>.test.ts`); run the full gate once before pushing. Do not push to discover bugs in CI.
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`. The prefix is also what labels the PR (`.github/labeler.yml`), and CODEOWNERS requests the reviewer — so `gh pr create --base main --assignee @me` is enough. `gh issue create` is the exception: it cannot read the issue forms (`--template` only sees Markdown templates), so pass the fields it would have set — `--type Bug --label bug` (or `Feature`/`enhancement`, `Task`/`chore`).
3. **Squash merge through the merge queue** (repo settings enforce both): one PR = one commit on `main`; curate the PR title/body — they become the commit message. Branch commits are working state, the PR is the design asset: put the durable *why* there, not in per-commit narration. `main` enforces linear history; force-push is forbidden.
4. **Review policy.** Merging is a maintainer's decision, never an agent's. After opening a PR, report it with the local gate result and stop; do not wait for CI. When told to merge, run `gh pr merge <N>` and return without waiting. It does one of two things, and the report names which one its output shows: it enqueues the PR (its own checks have passed; the queue reruns them on top of the latest `main` and merges only if they pass), or it enables auto-merge (its checks are still running; it enqueues itself once they pass, and stays open if they fail). External-contributor PRs are reviewed and merged by a maintainer.
5. **After merge.** The queue merges later, so clean up only once `gh pr view <N> --json state -q .state` prints `MERGED`. A deleted remote branch is not that proof: a closed PR's branch can be deleted too. Use `-D`, because a squashed branch is never an ancestor of `main`:
   ```bash
   git checkout main && git pull --ff-only && git fetch --prune origin && git branch -D <branch>
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
