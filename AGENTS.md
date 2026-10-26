# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent directories: it turns a file-defined agent (`SYSTEM.md` / `APPEND_SYSTEM.md` prompt, `skills/`, tools, and existing `AGENTS.md` project context) into a live service inside an app, in Telegram, Slack or Feishu, or behind a custom channel without a new authoring DSL.

The design center is decided in `docs/design/architecture.md`: an agent is a definition assembled onto one harness, pi-durable, and served through one API of our own, the consumer Agent API of `docs/design/agent-api.md`; everything else is pi-durable's own API. The code runs that design; the documents that still describe the SPEC v1 stack it replaced (`docs/SPEC.md`, the user guides) are rewritten in #788's docs step.

## Source of truth

| Document | Purpose |
|---|---|
| `docs/design/agent-api.md` | The consumer Agent API, which the code implements. Do not change its semantics without an explicit decision. It replaces `docs/SPEC.md` (v1, retired) in #788's docs step. |
| `docs/design/architecture.md` | The decided architecture: what FastAgent is for, one harness (pi-durable), one API, the artifact, context packages, hosts. |
| `docs/design/core.md` | The SPEC v1 reference implementation; rewritten in #788's docs step. |
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
├── agent-api.ts            # the Agent API (docs/design/agent-api.md) as types, plus its limits and error values;
│                           # imports nothing
├── agent-api-stream.ts     # stream(agent, request): send a message and read its answer as written, over any Agent
├── answer-text.ts          # a message's answer text as it streams: its deltas, plus entry text no delta carried
├── channel.ts              # the Channel contract: ChannelModule / Routes / ChannelHandler / LongConnection*
├── conversation-sessions.ts # which Agent session each of a Caller's conversations talks in (a channel's chats and
│                           # threads, a schedule's runs), and the order a new one is created in
├── service.ts              # THE PRODUCT AS ONE CALL — an opened agent becomes a live service (mountAgentService),
│                           # plus the assembly parts dev/start share: routesFor / startSchedules
├── effect-port.ts          # the ONE crossing from a Promise-shaped port into Effect: port / portJoin / portAbort /
│                           # portRequest / portCleanup / PortFailure
├── once.ts                 # work that runs once per process, its outcome shared (shutdown, AgentCore activation)
├── core.ts, node.ts, pi.ts # the three public layers, by what each costs to import: neutral + Effect only, no Node /
│                           # harness-neutral but needs Node / names the harness. Asserted in package-boundary.test.ts
├── index.ts                # supported all-in-one entry (re-exports core + node + pi)
├── cli.ts                  # the THIN entry (import-free; lazy-loads cli/program.ts)
├── cli/                    # the CLI, built on clig.dev
│   ├── kernel.ts           # CommandSpec-as-data + the commander adapter (commander appears ONLY here); exit 0/1/2
│   ├── program.ts          # the spec registry — the CLI surface's source of truth; lazy per-command imports
│   ├── invoke-stream.ts    # `invoke`: one message's answer, as stream() reads it → exit code
│   ├── models-view.ts, auth-view.ts, content-view.ts # `models` / auth-report / content output
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
├── tunnel.ts               # `--tunnel`: cloudflared + per-channel webhook dispatch
├── dev-supervisor.ts       # `dev` supervisor: restart on code edits (src/, config, package.json, .env); the
│                           # prompt files and skills are read per message
├── proxy.ts                # the process's outbound-fetch policy: the declared proxy, loopback exempt by default
├── open-url.ts             # best-effort "open this in a browser" (callers still print the URL); only https or
│                           # loopback http reaches the opener, because some URLs come from a deployed box
├── env.ts                  # ENTERING the selected environment: dev `.secrets/.env` or production
│                           # `.secrets/production/.env` → process.env, then the egress that follows
├── serving-command.ts      # which command serves this process (`dev` marks it): the default a channel's ingress
│                           # setting falls back to, read through the process environment the CLI and the agent share
├── runtime.ts              # agent runtime/package-manager detection (node vs bun) + readPackageJson
├── paths.ts                # ADDRESSING (which directory is the agent: the one named, never searched for) + the
│                           # shared path predicates and the machinery paths that follow (.secrets/.state/content)
├── git.ts                  # running git, and what ONE result means (an answer, a "no", or no git at all)
├── content/                # what an agent works on and knows — harness-neutral
│   ├── declare.ts          # a shared entry and a machine's binding, read and refused in ONE place (names, keys)
│   ├── file.ts             # `context.json` + `context.local.json` read (a reader its part, an edit the whole) and written
│   ├── mount.ts            # content/, where the clones go: the dir with its own .gitignore
│   ├── resolve.ts          # where each entry is for THIS instance (a clone, a bound dir): the one answer every reader uses
│   ├── git.ts              # a GitHub entry's git: which repository a checkout is of, its ref, a fresh clone
│   └── source.ts           # what a command's <source> adds (github:owner/repo, a checkout, a directory)
├── environment/            # the commands an agent runs, declared in context.json — harness-neutral
│   ├── declare.ts          # the `environment` declaration, read and refused in ONE place; the backend allowlist
│   ├── mise.ts             # the agent's OWN mise (an npm dep per platform), packages as arguments: install, enter
│   └── apt.ts              # which declared apt packages THIS machine lacks (dpkg; Debian and Ubuntu only)
├── authoring.ts            # creating an agent + editing its content as an API; `init`/`content` are thin wrappers
├── declared-secrets.ts     # WHICH env vars this agent needs, in ONE shape (`needs()` in code, context.json's
│                           # variables), and what "has no value" means
├── atomic-write.ts         # writeFileAtomic: the ONE "whole file or none of it" write
├── locked-file.ts          # the cross-process locked read-modify-write that REPLACES a file (credentials,
│                           # context.json), pi's lock included, so every reader of those files reads without one
├── state-file.ts           # a Caller's durable JSON state under the state root (channels, schedules), read and
│                           # written whole
├── version.ts              # package version + the pi-durable and pi-ai ranges a scaffolded agent depends on
├── scaffold/               # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── router.ts           # how route tables become ONE Fetch handler: the path rule and dispatch, no guard of its
│   │                       # own (every route verifies its caller). Fetch-only: /core serves through it
│   ├── serve.ts            # the node:http binding of a Fetch handler, behind the totality boundary
│   ├── agentcore-service.ts # the AgentCore serving assembly (same product as service.ts, built for that
│   │                       # host): channels discovered on trusted ingress, the whole definition opened
│   │                       # on the first envelope, an external clock, no resident connections
│   ├── agentcore.ts        # the AgentCore Runtime adapter: POST /invocations + GET /ping, the envelope kinds,
│   │                       # and the shared-secret boundary that separates a forwarder call from any IAM one
│   ├── agentcore-protocol.ts # THE WIRE between the forwarder Lambda and the container (types + constants)
│   ├── agentcore-limits.ts # the host's body ceilings, computed once
│   ├── busy.ts             # the process's work in flight (every unsettled message, channel and schedule work not
│   │                       # yet at one), read by /ping (HealthyBusy) and by `dev` before it restarts
│   ├── discover.ts         # a definition's built channels, mounted: route channels' routes, long connections bound
│   ├── body.ts, respond.ts # channel-authoring kit (body cap, responses)
│   ├── secret.ts           # the ONE constant-time comparison every shared-secret gate reads through
│   ├── wait-health.ts      # readiness probe for a server THIS process reaches directly (not a public URL)
│   ├── registration.ts     # the shared registrar outcome (registered|manual|failed) + the ONE retry loop
│   ├── kit/                # WRITING a channel. Its defining property is an import fact, asserted in
│   │   │                   # package-boundary.test.ts: everything here has consumers only under
│   │   │                   # channels/<platform>/, and serve/router/discover have none there
│   │   ├── preview-kit.ts  # pure turn-view reducer, line renderers, preview policies
│   │   ├── delivery.ts     # scoped coalescing previews, ordered native writes, terminal settlement
│   │   ├── event-stream.ts # typed, demand-driven Agent iterator acquisition and scoped cleanup
│   │   ├── invoke-turn-kit.ts # prepare inputs → one keyed, queued message; the prompt manifest wording
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
│   │   ├── seen.ts         # bounded durable delivery dedup
│   │   ├── signature.ts    # replay window for a signed webhook ingress
│   │   ├── tasks.ts        # side-task tracking (ACK-independent work); drain is observation only
│   │   ├── text.ts         # Unicode-safe code-point slicing
│   │   ├── attachment-path.ts # where an attachment lands (the conversation id encoded into a directory)
│   │   ├── stop-command.ts # the shared /stop parsing every chat channel accepts, and the abort it dispatches
│   │   └── thread-fork.ts  # a new thread starts as a fork of its room at the message its reply chain names (by key)
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
│   │   └── scaffold/       # `add telegram` bundle (channel + send tool)
│   ├── slack/              # Slack Agent: native streams + inline tool traces, signed Events API ingress
│   │   ├── slack.ts        # ingress + per-turn lifecycle + composition
│   │   ├── parse.ts, model.ts, reaction.ts # pure protocol parsing/shapes + the reaction vocabulary
│   │   ├── invoke-turn.ts, preview.ts # turn IO + BOTH renderers (native Agent stream, classic edits)
│   │   ├── history.ts      # a place's history: conversations.history (top level) / .replies (a thread)
│   │   ├── slack-api.ts    # the Bot API pipeline (retry, markdown/text splitting, files, history reads)
│   │   ├── shared-api.ts   # the ONE transport per state root the channel and the send tool share
│   │   ├── onboard.ts, setup-server.ts, manifest.ts, config-api.ts, onboarding-state.ts, welcomed.ts,
│   │   │                   # register-webhook.ts # `add slack`: the app-creation flow and what it remembers
│   │   └── scaffold/       # `add slack` bundle (channel + slack-send + slack-threads)
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
│   ├── preflight.ts        # host-neutral pre-flight: the definition builds, its model exists and authenticates
│   │                       # where it runs, channel discovery, warnings
│   ├── build-context.ts    # what the build context holds that must not ship, and what a KEPT ignore file lets through
│   ├── container.ts        # portable image + ignore files + release manifest (host-neutral), and the one command
│   │                       # that runs `login --stdio` inside that image where its server runs
│   ├── workspace.ts        # the deployed lifecycle every host shares: assert the storage is MOUNTED, one
│   │                       # process lease, recoverable definition replacement (definition/ is cwd; .state/
│   │                       # and .secrets/ stay beside it)
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
│   ├── schedule.ts         # a schedule as built ({ name, cron, tz?, prompt }) from `defineSchedule` in src/schedules/
│   ├── cron.ts             # the one place touching `croner`: nextRun + cronError
│   ├── scheduler.ts        # the resident clock loops + claim/run/settle over the Agent API: a schedule is refused
│   │                       # by a busy session (skipped), a wake-up queues; stop cancels waits, runs go on
│   ├── wakeups.ts          # the agent's self-scheduled wake-ups: neutral store + guardrails
│   ├── wake-alarm.ts       # the EXTERNAL-clock form of both: schedules as recurring EventBridge schedules,
│   │                       # wake-ups as one-shots
│   ├── eventbridge-cron.ts # a cron in EventBridge's dialect; the build refuses what it cannot express
│   └── state.ts            # schedule state under <stateRoot>/schedule/, incl. THE claim: the decision to fire,
│                           # the outcome written back into it, and therefore the whole (bounded) fire history
└── harnesses/              # the only directory that imports @earendil-works/pi-*
    ├── pi-durable/         # the Agent API on pi-durable, in process
    │   ├── open.ts         # a definition (config + generated registry) assembled into an Agent; the secrets
    │   │                   # gate and manifest; pi-ai's built-in models with the definition's providers
    │   ├── serve.ts        # openServing: a directory opened to be served (definition, code, models, content,
    │   │                   # storage, Agent) — what dev, start, AgentCore and an embedder open through
    │   ├── storage.ts      # the instance's one SQLite database, and its lock where SQLite's own locks fail
    │   ├── define.ts       # what an author writes: defineAgent, needs (secrets beside the code that reads them),
    │   │                   # defineSchedule
    │   ├── registry.ts     # the generated `.fastagent/registry.ts`: one default import per module of src/
    │   ├── text.ts         # SYSTEM.md, AGENTS.md, skills (loaded as pi loads them) and prompt templates, read per
    │   │                   # message; the deployed agent's self-change section
    │   ├── agent.ts        # openDurableAgent: a Harness on the instance's storage, and the ten operations over it
    │   ├── reads.ts        # what the operations and resume read: a session's conversation, its published entries,
    │   │                   # a message's status and end, the session's state
    │   ├── resume.ts       # resume: the replay, the `state` snapshot, then what each commit adds
    │   ├── sessions.ts     # which conversations are sessions (a subagent's is not) and each one's latest activity,
    │   │                   # its newest own id: a cache read at open and moved by every commit, which every
    │   │                   # operation and listSessions read
    │   ├── entries.ts      # pi-durable's entries as published entries, and the entry kinds FastAgent writes
    │   ├── messages.ts     # input submissions as messages: request ids, statuses, outcomes, the session's state
    │   ├── ids.ts          # every id as the storage's incarnation plus pi-durable's id, so none is ever reused;
    │   │                   # listSessions' cursors, which no id reads as; the session id a tool runs in
    │   ├── wake.ts         # `wake` and `unwake` as pi-durable tools, installed when a serve gives the state root
    │   ├── defaults.ts     # the deployment's default model and thinking level, for a conversation that names none
    │   └── release.ts      # temporary: places the messages a run that did not answer left waiting
    └── models/             # the model environment: pi-ai's models, credentials and sign-in
        ├── models.ts       # pi-ai's model collection as FastAgent composes it (built-ins over a credential store,
        │                   # the definition's providers), and the reads a report, a login or a picker make of it
        ├── credentials.ts  # the credentials file store + which files (layers) an agent reads
        ├── environment.ts  # an agent's model environment as ONE value (credential store + models + auth status):
        │                   # every reader builds it here, never from the parts
        └── login.ts        # signing in to a model provider, for any front end; `fastagent login` is one
test/                       # vitest; faux models by default
├── agent-api-conformance.ts # the Agent API's conformance suite (agent-api.md §9), run in process by
│                           # durable-agent.test.ts over durable-subject.ts
├── scripted-agent.ts       # an Agent whose answers a test scripts: what channel, schedule and service tests run on
├── embedding.test.ts       # the docs/embedding.md snippets against REAL express/fastify (why they are devDeps)
└── live/                   # probes for what the offline suite FAKES — see test/live/README.md
docs/                       # SPEC, guides, and maintainer design notes (design/core.md = architecture)
```

## DevX Principle Stack

fastagent *is* a developer-experience product: its whole promise is turning an existing agent definition into a service **without rewriting it**. The user is an agent author, and the artifact is their tool. These principles (adapted from [cpojer's Principles of DevX](https://cpojer.net/posts/principles-of-devx)) are a **stack ordered by priority**: the lowest is the foundation we least violate. When two principles conflict, keep the lower one. Violating a principle is sometimes correct — the point is to *name the trade-off* when you do.

1. **Focus on the user (foundation).** The author already has `AGENTS.md` + `skills/`; our job is velocity, not ceremony. Optimize, in order: workflow performance (`dev`/`start` must be fast), **actionable signal** (every failure surfaces as a `failed` event with a diagnosable message — never a silent fallback or a swallowed throw), reliability, documentation (`init` is complete-by-default so authors self-unblock), and scalability. Do the boring author-facing win over the shiny internal rewrite. Serve tomorrow's author too: prefer changes that keep large/growing definitions maintainable.
2. **Incremental migration.** Both directions. For users: adoption is incremental (existing definition → service, a few rough edges acceptable if the path forward is viable). For us: migrate systems in place; a full rewrite pauses maintenance and usually loses. If you *must* rewrite, say so explicitly and own the risk.
3. **Clarity.** Surface the *right* level of complexity at the best interaction point — do not mask it in the name of "getting out of the way." The `docs/SPEC.md` contract is the narrative; keep plans, APIs, and names plain. It's never too early to share a draft (this is what the PR loop is for) — test changes with whoever has the most context before building.
4. **Re-evaluate assumptions, constraints, trade-offs.** Model- and cloud-neutrality exist *because* these change. Harness neutrality was tried and given up ([architecture.md](docs/design/architecture.md) §1): a neutral layer over the part harnesses differ on most cost more than it bought. Old code wasn't bad — its constraints differed; gain that context before reshaping it. Be honest that most solutions carry negative trade-offs; refuse the ones that put us in a worse future position, and don't stack complex abstractions on complex systems.
5. **Maximize option value.** Every change should unlock more future options, not fewer. Here that means clear API boundaries (the consumer Agent API in front of the harness), FastAgent's own harness code kept in one directory, the definition's text kept to open standards where they exist, and carefully chosen dependencies. An author's tools and extensions are pi-durable code by choice. It does not mean designing for a second implementation before there is one: a port over a single harness is a cost paid in advance ([architecture.md](docs/design/architecture.md) §2). Prefer modular seams that let a piece be replaced over monoliths that must move as one.

## Working rules specific to this repo

- **The API imports no harness.** `src/agent-api.ts` must not import any harness (`@earendil-works/pi-*` only under `src/harnesses/`): the consumer API is the layer that keeps a harness's changes away from clients, and keeping FastAgent's own harness code in one directory bounds what replacing the harness costs FastAgent. It does not bound what it costs an author: an agent's tools and extensions are pi-durable code, an accepted trade-off ([architecture.md](docs/design/architecture.md) §2).
- **Fail visibly.** Errors must surface; no swallowed exceptions, no silent fallbacks. A message that cannot be answered ends with its outcome saying why, and a refused operation returns an `AgentError` value (agent-api.md); neither throws through a Caller's iteration.
- **One process owns an instance's state.** Durable state is the instance's storage (pi-durable's SQLite: sessions, messages, entries) and each Caller's own files under the state root (a channel's session map and turn records, the schedules' claims, wake-ups). One process opens a storage at a time, so a deployment routes every session of one storage to one process ([architecture.md](docs/design/architecture.md) §4.3). The process holds the open Agent and each Caller's queues; what a caller reads afterwards is durable before it is reported.
- **Public surface is scoped on purpose.** `src/core.ts` is harness- and runtime-neutral (no package but `effect`, no Node built-in; `src/agent-api.ts` and `src/channel.ts` themselves import nothing), `src/node.ts` is harness-neutral but needs a Node runtime, `src/pi.ts` names the harness, and `src/index.ts` combines all of them. Internals (`openDurableAgent`, the registry generator, the scheduler and router parts) remain unexported — import them from their modules for tests/custom wiring, do not re-export them.
- **Effect first.** Write with Effect, and with what Effect gives you, rather than hand-rolled async plumbing or a thin wrapper over it.
- **Learn Effect from its source, not from guesses.** The installed `effect@4` ships uncompiled source and its own agent guide: read `node_modules/effect/AGENTS.md` before writing Effect code, and the relevant module under `node_modules/effect/src/` for how an API is actually used ([why](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)). Prefer it over an invented API, a stale memory, or a web search. Read-only reference: never edit it, never import from a path inside it.
- **The artifact carries the agent; the machine lends it an environment.** What a definition declares — its prompt files, `AGENTS.md`, its code under `src/` (tools, channels, schedules), its own `skills/` — is the artifact and must come from the bundle, never from the builder's global state. What the box supplies is inherited, the way `bash` already inherits the `PATH`: pi's skills, prompt templates and harness settings (retry budget, compaction thresholds, cache warming) come from `~/.pi/agent` in every posture, including a container, whose environment is whatever its image was built with. The line is not "definition vs machine" but IDENTITY vs ENVIRONMENT — a system prompt from someone's laptop would make the agent theirs, so that one is overridden. Deploying ships the project scope; the environment is not compared against a deployment, the same way nobody is told their local `ffmpeg` is not in the image.
- **A session id belongs to the Agent; a conversation id belongs to the Caller.** The Agent names sessions, and a Caller maps its own conversations onto them (`conversation-sessions.ts`) — a telegram group is `-1001234567890`, a feishu thread carries `:` and `/`, and neither is ever a session id. A tool asking which session it runs in gets the id the Agent handed out (`sessionIdOf`), never pi-durable's own.
- **The run plane and the observation plane read the same state, through the same function.** They answer different questions about one session — what will execute, and what to report — so deriving them separately is how they come to disagree. The concrete failures this rule is made of: a turn running on assembly defaults while `state()` reported the recorded override, and one plane refusing a record with a cut parent chain while the other silently ran on the truncated path.
- **A convention with four enforcers has none.** When several call sites must each remember to do a thing, the thing belongs in a function they all call, and that function must REPAIR rather than trust the first writer. `writeFileAtomic` is that shape.
- **A shared rule is tested once, where it lives; a caller's test proves only its own wiring.** Four hosts calling one `registerWebhooks` do not each owe a "long-connection is not registered" test — that belongs to `deploy-channel-ingress.test.ts`, and a host test owes the URL it hands over and what it does with the gate. Same for the Lark scaffold that is the Feishu one with the cloud swapped, and a chat channel over `channels/kit/turn-*` (its own tests cover the record shape, the ACK boundary, and how a dropped or deferred turn reaches the asker — not the ceiling arithmetic). A list-driven structural guard is likewise ONE test whose assertion names the offending file, not one `it` per file: `package-boundary.test.ts` shed 40 cases that way without losing a line of coverage.

- **A test that asserts "X must not happen" is unproven until X has happened.** Run the mutation that makes it happen and watch the test fail; a green suite says nothing about a claim the test cannot observe. The failure mode is specific: a test DOUBLE that omits part of the contract it stands in for. Two fake `fetch`es here ignored `init.signal`, so "the client does not kill a healthy connection" stayed green under a change that killed every one of them — the doubles reported on bytes and could not see teardown at all. Hence one shared double per contract (`scripted-agent.ts` for the Agent) rather than a fake per case: a clause several hand-written doubles must each remember is a clause some of them will not.

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

Everything that lands in or on the repository is English — code, comments, documentation, commit messages, PR titles and bodies, code reviews and review replies, issue discussion, and release notes. The one exception is `docs/cn/`: Simplified Chinese explanations of English documents for maintainers. They are never normative; where one differs from its English source, the source wins, so a change to the source updates or deletes its explanation.
