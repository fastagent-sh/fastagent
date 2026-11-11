# fastagent — Agent Guide

## What this is

fastagent is "Vibe first. Then FastAgent" for agent directories: it turns a file-defined agent (a `SYSTEM.md` prompt, `skills/`, code under `src/`, and existing `AGENTS.md` project context) into a live service inside an app, in Telegram, Slack or Feishu, or behind a custom channel without a new authoring DSL.

The design center is decided in `docs/design/architecture.md`: an agent is a definition assembled onto one harness, pi-durable, and served through one API of our own, the consumer Agent API of `docs/SPEC.md` (v2, in process and over HTTP); everything else is pi-durable's own API.

## Source of truth

| Document | Purpose |
|---|---|
| `docs/SPEC.md` | The Agent API v2, in process and over HTTP: what `src/agent-api.ts` and `src/http/` implement. Do not change its semantics without an explicit decision. |
| `docs/design/architecture.md` | The architecture: what FastAgent is for, one harness (pi-durable), one API, the artifact, context packages, hosts. |
| `docs/design/agent-artifact.md` | The framework design (#900), built: one immutable built definition assembled deterministically from explicit instance inputs. Program `fastagent.config.ts` (constants, `defaults`, `settings` schema) + `context.json` (its `mcpServers` included); instance `fastagent.json` (its `mcpServers` included), state and workspace; deployment and secrets. |
| `docs/design/core.md` | The code as it is now: the agent directory, the assembly onto pi-durable, channels, schedules, state, deployment. Where it and the artifact design differ, the code is current. |
| `docs/design/participant-model.md` | When a chat channel speaks, where it answers, what it remembers. Authority for Feishu/Lark + Slack routing. |
| `docs/overview.md`, `docs/README.md` | Product overview and documentation index. |
| `CONTRIBUTING.md` | The full GitHub workflow (branch model, PR loop, merge strategy, review policy). |

Code truth is `src/`.

## Repo map

One line per file: **what it owns**. The reason it is that way lives in the file's own header — the
one place that cannot drift away from the code it explains. Directories that have no header file
(`src/deploy`) point at where theirs lives.

```
src/
├── agent-api.ts            # the Agent API (docs/SPEC.md) as Effect Schemas: its objects, requests,
│                           # errors and limits; imports only effect/Schema
├── sign-in-api.ts          # model credentials and sign-in as a host embedding agents sees them: FastAgent's own
│                           # types (CredentialStore, SignInInteraction, …), SignInCancelled; imports nothing
├── mcp-api.ts              # embedding-facing MCP grants, bindings, sign-in interaction and errors; imports nothing
├── mcp/                    # MCP 2026-07-28, independent of the agent harness
│   ├── config.ts           # `mcpServers` validation (context.json's and the instance's), secret references and resolution
│   ├── grants.ts           # grant records and durable writes under a shared storage lock
│   ├── auth.ts             # OAuth discovery, target binding, serialized refresh and safe diagnostics
│   ├── network.ts          # MCP URL policy and instance-owned HTTP transport, with DNS-validated IP pinning
│   ├── client.ts           # instance-owned stdio/HTTP clients, calls and scoped cleanup
│   ├── host.ts             # inspectMcp, default grant storage and instance bindings
│   └── sign-in.ts          # explicit consent, browser callback, PKCE exchange and durable grant creation
├── answer-text.ts          # a message's answer text as it streams: its deltas, plus entry text no delta carried
├── channel.ts              # the Channel contract: ChannelContext (agent, sessionFor, recordedSession, turn, stateDir),
│                           # ChannelModule / Routes / LongConnection*, and defineChannel
├── conversation-sessions.ts # which Agent session each of a Caller's conversations talks in (a channel's chats and
│                           # threads, a schedule's runs), and the order a new one is created in
├── service.ts              # THE PRODUCT AS ONE CALL — an opened agent becomes a live service (serveAgent: what
│                           # `agent.serve()` answers, `Service` with fetch/listen/ready/close), plus the parts
│                           # dev/start/AgentCore share: serviceOver / routesFor / startSchedules
├── effect-port.ts          # the ONE crossing from a Promise-shaped port into Effect: port / portJoin / portAbort /
│                           # portRequest / portCleanup / PortFailure
├── once.ts                 # work that runs once per process, its outcome shared (shutdown, AgentCore activation)
├── index.ts                # the package's one entry: the Agent API, openAgent, what a host embedding agents needs
│                           # (createAgent, credentials, sign-in), what an author writes; every export named.
│                           # Asserted in package-boundary.test.ts
├── client.ts               # the `/client` entry: connectAgent and the Agent API's types, for wherever fetch runs
├── http/                   # the Agent API over HTTP (SPEC.md §9)
│   ├── contract.ts         # THE ONE CONTRACT (effect/http-api) the server answers from, the client calls through
│   │                       # and /v1/openapi.json is made from: routes, refusals and their statuses, server-sent
│   │                       # events; imports nothing that needs Node
│   ├── server.ts           # the contract answered by an in-process Agent, behind the instance's keys
│   │                       # (FASTAGENT_API_KEY): a Fetch handler serveAgent mounts under /v1
│   └── client.ts           # connectAgent: the Agent interface over the contract, waits past a request's 60 s
├── cli.ts                  # the THIN entry (import-free; lazy-loads cli/program.ts)
├── cli/                    # the CLI, built on clig.dev
│   ├── kernel.ts           # CommandSpec-as-data + the commander adapter (commander appears ONLY here); exit 0/1/2
│   ├── program.ts          # the spec registry — the CLI surface's source of truth; lazy per-command imports
│   ├── instance.ts         # where a command's instance is: --root/--state/--workdir/--config over their variables, settled
│   │                       # once at the command's entry into absolute paths in the process environment
│   ├── invoke-stream.ts    # `invoke`: one message's answer, as messages.stream delivers it, as text or JSON lines → exit code
│   ├── models-view.ts, auth-view.ts, content-view.ts # `models` / auth-report / content output
│   ├── first-run-channels.ts # `dev`'s first run: a first-party channel without credentials is set up, in the parent, at a terminal
│   ├── channel-setup.ts    # `channels setup <name>`: ask a person for a channel's credentials, at a terminal or on a page,
│   │                       # check each with the platform, keep them in the instance's value file
│   ├── person.ts           # what an app's setup says to the person for the steps only they can take: printed at a
│   │                       # terminal, a ticket's `need_user_action` / `afterwards` in a coding agent's run
│   ├── shared.ts, serve.ts # cross-command helpers: serve/bind reporting, tunnel (the ASSEMBLY is service.ts)
│   ├── fail.ts             # the process-exiting failure boundary
│   ├── login-relay.ts      # `login` split across a process boundary: LoginIO as JSON lines, box half + terminal half
│   ├── channel-app.ts      # a channel's binding recorded in an instance configuration (channels.<name>.app)
│   ├── ticket.ts           # a step a coding agent starts and a person finishes (a sign-in, an app's setup), outliving
│   │                       # the command: its own process, a ticket under ~/.fastagent/.state/tickets, `--check`
│   ├── box-login.ts        # `login --deployment`: the login runs ON the deployed box, through the host's own shell;
│   │                       # answered at this terminal, or by a ticket's process for a coding agent (ticketLoginIO)
│   └── commands/           # one module per command; `deploy` dispatches to one commands/deploy/<host>.ts each,
│                           # and signs a host's CLI in through whoever answers (commands/deploy/host-login.ts)
├── telegram.ts, slack.ts,  # subpath-export shims (@fastagent-sh/fastagent/telegram etc.)
│   feishu.ts, lark.ts
├── bind.ts                 # the ONE reading of a bind address, as the six different questions it is
├── model-ref.ts            # provider/modelId parsed for definitions and remote callers without loading a harness
├── log.ts                  # leveled logging singleton (dev=debug, start=info)
├── tunnel.ts               # `--tunnel`: cloudflared + per-channel webhook dispatch
├── credentials-page.ts     # the page a person pastes a setup's credentials on when there is no terminal: loopback, one use,
│                           # each value checked as it is pasted and kept before the next
├── channels/setup.ts       # what a channel's setup asks a person for (values, guides, checks); `cli/channel-setup.ts` asks
├── setup-page.ts           # the pages a person pastes a credential on, one design for every channel (Slack, Lark): form
│                           # and status cards, and the headers of a page that takes a secret
├── dev-supervisor.ts       # `dev` supervisor: restart on code edits (src/, config, package.json, .env); the
│                           # prompt files and skills are read per message
├── runtime-websocket.ts    # the runtime's own WebSocket and the pings it can send (undici's, or Bun's own before
│                           # 1.4.4): what Slack's Socket Mode and AgentCore's shell hold a connection open with
├── proxy.ts                # the process's outbound-fetch policy: the declared proxy, loopback exempt by default
├── open-url.ts             # best-effort "open this in a browser" (callers still print the URL); only https or
│                           # loopback http reaches the opener, because some URLs come from a deployed box
├── env.ts                  # ENTERING the selected environment: dev `.secrets/.env` or production
│                           # `.secrets/production/.env` → process.env, then the egress that follows
├── child-env.ts            # the environment of the processes an instance starts (shell tool, stdio MCP servers, skill
│                           # scripts): assembled from inputs, never the host's whole `process.env`
├── instance-name.ts        # an instance's name: one path segment, defaulting to the definition's made into one
├── strip-edges.ts          # trim the ends of a name or a URL by index (a regex backtracks on a long run)
├── serving-command.ts      # which command serves this process (`dev` marks it): the default a channel's ingress
│                           # setting falls back to, read through the process environment the CLI and the agent share
├── runtime.ts              # agent runtime/package-manager detection (node vs bun) + readPackageJson
├── paths.ts                # ADDRESSING (which directory is the agent: the one named, never searched for) + the
│                           # shared path predicates and the machinery paths that follow (.secrets/.state/content)
├── git.ts                  # running git, and what ONE result means (an answer, a "no", or no git at all)
├── content/                # what an agent works on — harness-neutral
│   ├── declare.ts          # a shared entry and a machine's binding, read and refused in ONE place (names, keys)
│   ├── file.ts             # `context.json` and the content an instance's configuration adds, read (a reader its part, an edit the whole)
│   ├── mount.ts            # content/, where the clones go: the dir with its own .gitignore
│   ├── resolve.ts          # where each entry is for THIS instance (a clone, a bound dir): the one answer every reader uses
│   ├── git.ts              # a GitHub entry's git: which repository a checkout is of, its ref, a fresh clone
│   └── source.ts           # what a command's <source> adds (github:owner/repo, a checkout, a directory)
├── environment/            # the commands an agent runs, declared in context.json — harness-neutral
│   ├── declare.ts          # the `environment` declaration, read and refused in ONE place; the backend allowlist
│   ├── mise.ts             # the agent's OWN mise (an npm dep per platform), packages as arguments: install, and the
│                           # PATH that puts them first for the agent's commands (never written into process.env)
│   └── apt.ts              # which declared apt packages THIS machine lacks (dpkg; Debian and Ubuntu only)
├── authoring.ts            # creating an agent (createAgent, exported; initAgent, `init`'s) + editing its content
│                           # as an API; `init`/`content` are thin wrappers
├── declared-secrets.ts     # WHICH env vars this agent needs, in ONE shape (`needs()` in code, context.json's
│                           # variables), and what "has no value" means
├── atomic-write.ts         # writeFileAtomic: the ONE "whole file or none of it" write
├── value-file.ts           # the selected environment's value file, READ as data (never entered: what it declares,
│                           # what it adds to an agent's environment) and WRITTEN (a generated value — a channel's
│                           # secret, the API's key — kept when set, its secrets dir gitignored)
├── locked-file.ts          # the cross-process locked read-modify-write that REPLACES a file (credentials,
│                           # context.json), pi's lock included, so every reader of those files reads without one
├── state-file.ts           # a Caller's durable JSON state under the state root (channels, schedules), read and
│                           # written whole
├── version.ts              # package version + the pi-durable and pi-ai ranges a scaffolded agent depends on
├── scaffold/               # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── router.ts           # how route tables become ONE Fetch handler: the path rule and dispatch, no guard of its
│   │                       # own (every route verifies its caller). Fetch-only
│   ├── serve.ts            # the server a Fetch handler is served on (Effect's, on Node's or Bun's own), behind the
│   │                       # totality boundary every serving path shares
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
│   ├── context.ts          # what a channel is handed: its stateDir, sessionFor over conversation-sessions.ts, turn
│   ├── turn-queue.ts       # per-place FIFO root fibers; queued work counts busy and survives ingress ACK
│   ├── body.ts, respond.ts # channel-authoring kit (body cap, responses)
│   ├── secret.ts           # the ONE constant-time comparison every shared-secret gate reads through
│   ├── wait-health.ts      # readiness probe for a server THIS process reaches directly (not a public URL)
│   ├── registration.ts     # the shared registrar outcome (registered|manual|failed) + the ONE retry loop
│   ├── webhooks.ts         # a serve pointing its platforms at itself: which channels take a webhook, the step a
│   │                       # person takes for each, and the registration the instance's own credentials can make
│   ├── webhook-evidence.ts # what proves a platform reaches the instance at a URL only a person sets: an
│   │                       # authenticated request and the address it was sent to, recorded in the channel's state
│   ├── kit/                # WRITING a channel. Its defining property is an import fact, asserted in
│   │   │                   # package-boundary.test.ts: everything here has consumers only under
│   │   │                   # channels/<platform>/, and serve/router/discover have none there
│   │   ├── preview-kit.ts  # pure turn-view reducer, line renderers, preview policies
│   │   ├── delivery.ts     # scoped coalescing previews, ordered native writes, terminal settlement
│   │   ├── event-stream.ts # typed, demand-driven Agent iterator acquisition and scoped cleanup
│   │   ├── invoke-turn-kit.ts # prepare inputs → one keyed, queued message; the prompt manifest wording
│   │   ├── transport.ts    # whether a call is worth waiting out a rate limit for (DROPPABLE_FRAME, CONTEXT_READ)
│   │   ├── turn-runner.ts  # accept → dequeue → execute → settle over the queue + store; steering and the shared answer
│   │   ├── turn-gate.ts    # whether a steered turn renders live or waits for the answer an earlier turn delivers
│   │   ├── turn-store.ts   # generic durable turn intent + the answer owed to it (record shape/validator/order injected)
│   │   ├── room-threads.ts # what a thread-reading tool may read: its turn's room (registered by the turn runner),
│   │   │                   # never one it is told; the thread list's format and bound
│   │   ├── place-history.ts # the Discussion a turn folds + the place-history fold (budget, labels) + the messages
│   │   │                   # turns posted into a place, which a read leaves out
│   │   ├── sender-conversation.ts # a group's main timeline: one conversation per sender (the one place the rule is written)
│   │   ├── ask-log.ts      # where a conversation's session read to: its recent asks, the Agent saying which it holds
│   │   ├── message-owners.ts # which conversation a platform message belongs to (asks and the agent's posts): a reply to it is steered there
│   │   ├── context-buffer.ts # generic durable un-summoned-discussion buffer, folded by message-id range, never cleared
│   │   ├── thread-participants.ts # who the agent has HEARD in a thread (the summon rule)
│   │   ├── seen.ts         # bounded durable delivery dedup
│   │   ├── signature.ts    # replay window for a signed webhook ingress
│   │   ├── tasks.ts        # side-task tracking (ACK-independent work); drain is observation only
│   │   ├── text.ts         # Unicode-safe code-point slicing
│   │   ├── attachment-path.ts # where an attachment lands (the conversation id encoded into a directory)
│   │   ├── abortable.ts    # waiting that an abort ends, and a listener on a signal that is removed
│   │   ├── stop-command.ts # the shared /stop parsing every chat channel accepts, and the abort it dispatches
│   │   └── thread-fork.ts  # where a new thread forks from: the session holding the exchange it was opened on, at that ask (by key)
│   ├── telegram/           # telegram channel: see docs/design/core.md §7
│   │   ├── telegram.ts     # the runtime (accept an update, run the turn) + its two ways in: webhook route, long polling
│   │   ├── polling.ts      # getUpdates as a LongConnection: webhook taken away first, confirm by offset, what ends it
│   │   ├── setup.ts        # what `channels setup telegram` asks for: the bot token, checked with getMe (and its group privacy flag); a webhook's secret
│   │   ├── privacy.ts      # group privacy mode's cost and its fix, in one wording (setup and the startup warning)
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
│   │   ├── slack.ts        # the runtime (ingest an event, run the turn) + its two ways in: signed webhook, Socket Mode
│   │   ├── socket.ts       # Socket Mode as a LongConnection: hello, ack by envelope id, refresh before the old one goes, pings
│   │   ├── parse.ts, model.ts, reaction.ts # pure protocol parsing/shapes + the reaction vocabulary
│   │   ├── invoke-turn.ts, preview.ts # turn IO + BOTH renderers (native Agent stream, classic edits)
│   │   ├── history.ts      # a place's history: conversations.history (top level) / .replies (a thread)
│   │   ├── slack-api.ts    # the Bot API pipeline (retry, markdown/text splitting, files, history reads)
│   │   ├── shared-api.ts   # the ONE transport per state root the channel and the send tool share
│   │   ├── setup.ts, manifest.ts # what `channels setup slack` asks for (the values, how each is checked) + the app's manifest and its link
│   │   ├── welcomed.ts     # who was greeted
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
│   │   ├── setup.ts        # `channels setup feishu`: scan-to-create, the Verification Token, the permission check; the engine Lark shares
│   │   ├── register-app.ts # scan-to-create device flow
│   │   ├── register-webhook.ts, bootstrap-token.ts # event URL + token automation
│   │   └── scaffold/       # `add feishu` bundle (channel + feishu-send + feishu-threads)
│   └── lark/               # Lark compatibility/degraded edges over the Feishu engine
│       ├── lark.ts         # thin branded adapter bound to LARK_COMPAT_CLOUD
│       ├── setup.ts        # `channels setup lark`: the launcher link, the pasted pair checked together
│       └── scaffold/       # `add lark` bundle
├── deploy/                 # `deploy docker|fly|railway|agentcore` (core.md §9). Neutral kernel at top, one
│   │                       # directory per host. ADDING A HOST: deploy/hosts.ts says what to write and what
│   │                       # to read first
│   ├── hosts.ts            # DEPLOY_HOSTS, the targets as a value + the add-a-host guide
│   ├── residency.ts        # what forbids scaling to zero: ONE rule every host that can scale reads
│   ├── api.ts              # a deployment's Agent API: served or not (http.api, the host), its key written once
│   │                       # nothing refuses the deploy, and the report of where it is reached
│   ├── channel-ingress.ts  # HOW A RUNNING CHANNEL IS REACHED: default route, who can set that URL, the
│   │                       # words when nobody can (or when a box's login stopped registration). Consumed by
│   │                       # every host AND by the serving path
│   ├── registration-gate.ts # host-neutral step-7 gate policy over the registrars' facts
│   ├── preflight.ts        # host-neutral pre-flight: the definition builds, its model exists and authenticates
│   │                       # where it runs, channel discovery, warnings
│   ├── build-context.ts    # what the build context holds that must not ship, and what a KEPT ignore file lets through
│   ├── delivered-text.ts   # the instance text a deploy delivers: the paths the configuration names, copied beside it
│   │                       # into `.fastagent/deploy/` so they resolve the same in the image's `/etc/fastagent/`
│   ├── container.ts        # portable image + ignore files + release manifest (host-neutral), and the one command
│   │                       # that runs `login --stdio` inside that image where its server runs
│   ├── workspace.ts        # the deployed lifecycle every host shares: assert the storage is MOUNTED, one
│   │                       # process lease, the release last started on it (the storage is the instance's root; the
│   │                       # program is the image's)
│   ├── secrets.ts          # the NAMES a deployment needs and declares (secretNeeds, declaredNames, ModelKey)
│   ├── secret-store.ts, file-store.ts # where a deployment's values live and how a deploy fills the gaps; Docker's store
│   ├── runner.ts           # the shared host-CLI dispatcher seam (CliRunner + spawnRunner; faked in tests)
│   ├── box-shell.ts        # a running box's owner-authenticated shell as a byte channel (`login --deployment`)
│   ├── docker/    { plan.ts, run.ts } # Compose topology (agent + state volume, ingress is the operator's) + the compose driver
│   ├── fly/       { plan.ts, run.ts } # artifacts + runbook (pure) + the flyctl driver
│   ├── railway/   { plan.ts, run.ts, ignore.ts } # same two roles — NOT a copy of Fly (thin config, minted URL); ignore.ts is
│   │                       # what `railway up` uploads (`.railwayignore`, since it follows `.gitignore` only inside a repo)
│   └── agentcore/ { plan.ts, run.ts, destroy.ts, aws-cli.ts, logs.ts, shell.ts, zip.ts, forwarder.js, slr.ts,
│                    store.ts, runtime-secrets.ts, sigv4.ts } # ONE stack:
│                             # runtime + forwarder Lambda (webhooks, and the alarms the container sets). No public
│                             # URL, no resident process, no volume — the facts every difference follows from.
│                             # destroy.ts is the other direction, and it exists because most of the
│                             # resources cannot be stack resources. aws-cli.ts owns what ONE AWS CLI result
│                             # MEANS — there / gone / could not find out — because eleven call sites each
│                             # deciding that produced the same defect five review rounds running. Every AWS
│                             # read that asks "is it there, and could I tell" goes through it. shell.ts is the
│                             # command-shell WebSocket `login --deployment` speaks (SigV4 presigned, AWS CLI creds)
│                             # store.ts is the deployment's values as one Secrets Manager secret outside the stack;
│                             # runtime-secrets.ts is the container reading it on its first invocation (IMDSv2 + SigV4)
├── schedule/               # the N axis: prompts on a cron and the clock that fires them
│   ├── schedule.ts         # a schedule as built ({ name, cron, tz?, prompt }) from `defineSchedule` in src/schedules/
│   ├── cron.ts             # the one place touching `croner`: nextRun + cronError
│   ├── scheduler.ts        # the resident clock loops + claim/run/settle over the Agent API: a schedule is refused
│   │                       # by a busy session (skipped), a wake-up queues; stop cancels waits, runs go on;
│   │                       # fireScheduleNow, one fire outside the clock (`schedules run`)
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
    │   ├── serve.ts        # openAgent (an app's: LocalAgent, served with `serve()`) over openServing, a definition
    │   │                   # opened as an instance (code, models, content, storage, Agent), which dev, start,
    │   │                   # AgentCore, invoke and `schedules run` call with their storage; holding the instance for
    │   │                   # a command that writes its state outside a serve
    │   ├── storage.ts      # a SQLite database one process holds (the instance's, `invoke`'s), and its lock
    │   │                   # where SQLite's own locks fail
    │   ├── define.ts       # what an author writes: defineAgent, needs (secrets beside the code that reads them),
    │   │                   # defineSchedule
    │   ├── config.ts       # the instance configuration: one JSON Schema, the program's defaults with an instance's over
    │   │                   # them, each value with its source; `fastagent.schema.json`
    │   ├── definition.ts   # a definition as one frozen value: what dev loads and a build exports, its declared inputs
    │   ├── build.ts        # `fastagent build`: the project's tsc into dist/, the text and resources, the generated entry
    │   ├── built.ts        # what dist/ is: which files go into it, the build record `start` checks the project against,
    │   │                   # and the opener of a built package (`loadProjectBuild`, `loadBuiltDefinition`)
    │   ├── registry.ts     # the modules of src/ by directory, imported in file order
    │   ├── text-sources.ts # where an instance's text is: the program's own, then what the configuration's
    │   │                   # `instructions`, `skills` and `prompts` name, resolved once at open
    │   ├── text.ts         # SYSTEM.md, AGENTS.md, skills (loaded as pi loads them) and prompt templates, read per
    │   │                   # message from exactly those paths; the deployed agent's self-change section
    │   ├── execution-env.ts # pi-durable's local execution environment with the environment of every process given outright
    │   ├── agent.ts        # openDurableAgent: a Harness on the instance's storage, and the operations over it
    │   ├── reads.ts        # what the operations and the event streams read: a session's conversation, its published
    │   │                   # entries, a message as it is now, the session
    │   ├── events.ts       # sessions.events: the replay, the `state` snapshot, then what each commit adds
    │   ├── stream.ts       # messages.stream: a message sent and delivered from wherever it is (new, queued,
    │   │                   # running, ended), over the Agent's own reads
    │   ├── sessions.ts     # which conversations are sessions (a subagent's is not) and each one's latest activity,
    │   │                   # its newest own id: a cache read at open and moved by every commit, which every
    │   │                   # operation and sessions.list read
    │   ├── entries.ts      # pi-durable's entries as published entries, and the entry kinds FastAgent writes
    │   ├── messages.ts     # input submissions as messages: request ids, statuses, ends; the session as the API has it
    │   ├── ids.ts          # every id as the storage's incarnation plus pi-durable's id, so none is ever reused;
    │   │                   # sessions.list's cursors, which no id reads as; the session id a tool runs in
    │   ├── wake.ts         # `wake` and `unwake` as pi-durable tools, installed when a serve gives the state root
    │   ├── mcp.ts          # MCP tools as pi-durable tools, unsafe replay and actionable error details
    │   ├── defaults.ts     # the deployment's default model and thinking level, for a conversation that names none
    │   └── release.ts      # temporary: places the messages a run that did not answer left waiting
    └── models/             # the model environment: pi-ai's models, credentials and sign-in
        ├── catalog.ts      # the model lists a pi-ai release does not carry: pi's published catalog (fetched whatever
        │                   # the machine authenticates) and the providers that fetch their own, kept in the state root
        ├── models.ts       # pi-ai's model collection as FastAgent composes it (built-ins over a credential store,
        │                   # the definition's providers), and the reads a report, a login or a picker make of it
        ├── credentials.ts  # the credentials file store + which files (layers) an agent reads
        ├── environment.ts  # an agent's model environment as ONE value (credential store + models + auth status):
        │                   # every reader builds it here, never from the parts
        ├── login.ts        # signing in to a model provider, for any front end; `fastagent login` is one
        └── host.ts         # what a host calls (credentialFile, signIn, signInOptions, providerAuth): thin over
                            # login.ts and credentials.ts, and the ONE translation of sign-in-api.ts's types to pi-ai's
test/                       # vitest; faux models by default
├── agent-api-conformance.ts # the Agent API's conformance suite (docs/SPEC.md §11), run in process by
│                           # durable-agent.test.ts over durable-subject.ts, and over HTTP by http-api.test.ts
│                           # (http-subject.ts: the same subject served, called through connectAgent)
├── scripted-agent.ts       # an Agent whose answers a test scripts: what channel, schedule and service tests run on
├── probe-package.ts       # a package built and installed under an app's node_modules: what built-package.test.ts and
│                           # bun/built.ts open as instances (a spawned CLI's `@fastagent-sh/fastagent` is fixtures/fastagent-shim)
├── open-source.ts          # `openSource(dir)`: the source project in `dir` opened as an instance rooted there
└── embedding.test.ts       # the docs/embedding.md snippets against REAL express/fastify (why they are devDeps)
docs/                       # SPEC, guides, and maintainer design notes (design/core.md = architecture)
```

## DevX Principle Stack

fastagent *is* a developer-experience product: its whole promise is turning an existing agent definition into a service **without rewriting it**. The user is an agent author, and the artifact is their tool. These principles (adapted from [cpojer's Principles of DevX](https://cpojer.net/posts/principles-of-devx)) are a **stack ordered by priority**: the lowest is the foundation we least violate. When two principles conflict, keep the lower one. Violating a principle is sometimes correct — the point is to *name the trade-off* when you do.

1. **Focus on the user (foundation).** The author already has `AGENTS.md` + `skills/`; our job is velocity, not ceremony. Optimize, in order: workflow performance (`dev`/`start` must be fast), **actionable signal** (every failure surfaces as a `failed` event with a diagnosable message — never a silent fallback or a swallowed throw), reliability, documentation (`init` is complete-by-default so authors self-unblock), and scalability. Do the boring author-facing win over the shiny internal rewrite. Serve tomorrow's author too: prefer changes that keep large/growing definitions maintainable.
2. **Incremental migration.** Both directions. For users: adoption is incremental (existing definition → service, a few rough edges acceptable if the path forward is viable). For us: migrate systems in place; a full rewrite pauses maintenance and usually loses. If you *must* rewrite, say so explicitly and own the risk.
3. **Clarity.** Surface the *right* level of complexity at the best interaction point — do not mask it in the name of "getting out of the way." The Agent API contract (`docs/SPEC.md`) is the narrative; keep plans, APIs, and names plain. It's never too early to share a draft (this is what the PR loop is for) — test changes with whoever has the most context before building.
4. **Re-evaluate assumptions, constraints, trade-offs.** Model- and cloud-neutrality exist *because* these change. Harness neutrality was tried and given up ([architecture.md](docs/design/architecture.md) §1): a neutral layer over the part harnesses differ on most cost more than it bought. Old code wasn't bad — its constraints differed; gain that context before reshaping it. Be honest that most solutions carry negative trade-offs; refuse the ones that put us in a worse future position, and don't stack complex abstractions on complex systems.
5. **Maximize option value.** Every change should unlock more future options, not fewer. Here that means clear API boundaries (the consumer Agent API in front of the harness), FastAgent's own harness code kept in one directory, the definition's text kept to open standards where they exist, and carefully chosen dependencies. An author's tools and extensions are pi-durable code by choice. It does not mean designing for a second implementation before there is one: a port over a single harness is a cost paid in advance ([architecture.md](docs/design/architecture.md) §2). Prefer modular seams that let a piece be replaced over monoliths that must move as one.

## Working rules specific to this repo

- **The API imports no harness.** `src/agent-api.ts` must not import any harness (`@earendil-works/pi-*` only under `src/harnesses/`): the consumer API is the layer that keeps a harness's changes away from clients, and keeping FastAgent's own harness code in one directory bounds what replacing the harness costs FastAgent. It does not bound what it costs an author: an agent's tools and extensions are pi-durable code, an accepted trade-off ([architecture.md](docs/design/architecture.md) §2).
- **Fail visibly.** Errors must surface; no swallowed exceptions, no silent fallbacks. A message that cannot be answered ends `failed` with its `error` saying why, and a refused operation rejects with an `AgentError` (docs/SPEC.md §7). A stream is refused on its first read; once it has delivered anything, a failure ends it with a `stream_error` event, never a rejection a Caller would take for a refusal.
- **One process owns an instance's state.** Durable state is the instance's storage (pi-durable's SQLite: sessions, messages, entries) and each Caller's own files under the state root (a channel's session map and turn records, the schedules' claims, wake-ups). One process opens a storage at a time, so a deployment routes every session of one storage to one process ([architecture.md](docs/design/architecture.md) §4.3). The process holds the open Agent and each Caller's queues; what a caller reads afterwards is durable before it is reported.
- **Public surface is scoped on purpose.** `src/index.ts` is the one entry, one per kind of user beside the channel subpaths (SPEC.md §8): the Agent API, `openAgent`, what a host embedding agents needs beside it (`createAgent`, model credentials and sign-in, in FastAgent's own types: the entry names no pi-ai type), and what an author writes, every export named. The contracts stay neutral: `src/agent-api.ts` imports only `effect/Schema`, and `src/channel.ts`, `src/sign-in-api.ts` and `src/mcp-api.ts` nothing. Internals (`openServing`, `serveAgent`, `openDurableAgent`, content editing, the model environment, the registry generator, the scheduler and router parts) remain unexported — import them from their modules for tests/custom wiring, do not re-export them.
- **The CLI serves a person and a coding agent alike** (docs/cli.md, "Scripts and coding agents"). A coding agent
  works in turns and sees a command's output only once it ends: nothing waits on a terminal, a choice not given exits
  2 naming what to pass, and a step only a person can take returns at once (`need_user_action`, a check command,
  `agent_next_steps`) while a process of the CLI's own finishes it (`src/cli/ticket.ts`). A secret is never
  typed into the agent's conversation. Results on stdout, everything else on stderr; a command whose result is data
  has `--json`.
- **Effect first.** Write with Effect, and with what Effect gives you, rather than hand-rolled async plumbing or a thin wrapper over it.
- **Learn Effect from its source, not from guesses.** The installed `effect@4` ships uncompiled source and its own agent guide: read `node_modules/effect/AGENTS.md` before writing Effect code, and the relevant module under `node_modules/effect/src/` for how an API is actually used ([why](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)). Prefer it over an invented API, a stale memory, or a web search. Read-only reference: never edit it, never import from a path inside it.
- **A finalizer does not fail.** Since effect 4.0.6, a defect in a combined cause turns every typed failure in it into a defect (`causeElectDefects` in `node_modules/effect/src/internal/effect.ts`): a finalizer that dies takes the body's typed failure with it, and the `catchTag("PortFailure")` waiting for that failure never runs. A finalizer says its own failure in the log, or leaves it to an explicit call in the body (`serialWriter`'s `finish`); it dies only where the defect is the point (`service.ts`'s close of a connection that will not stop).
- **The artifact carries the agent; the machine lends it an environment.** What a definition declares — its prompt files, `AGENTS.md`, its code under `src/` (tools, channels, schedules), its own `skills/` — is the artifact and must come from the bundle, never from the builder's global state. What the box supplies is its environment, inherited the way `bash` inherits the `PATH`: the commands `context.json` does not declare, and the process's variables. Nothing of the agent itself comes from the machine: no skill, prompt template or system prompt from `~/.pi/agent`, since a prompt from someone's laptop would make the agent theirs. The line is IDENTITY vs ENVIRONMENT. The environment is not compared against a deployment, the same way nobody is told their local `ffmpeg` is not in the image.
- **A session id belongs to the Agent; a conversation id belongs to the Caller.** The Agent names sessions, and a Caller maps its own conversations onto them (`conversation-sessions.ts`) — a telegram group is `-1001234567890`, a feishu thread carries `:` and `/`, and neither is ever a session id. A tool asking which session it runs in gets the id the Agent handed out (`sessionIdOf`), never pi-durable's own.
- **The run plane and the observation plane read the same state, through the same function.** They answer different questions about one session — what will execute, and what to report — so deriving them separately is how they come to disagree. The concrete failures this rule is made of: a turn running on assembly defaults while `state()` reported the recorded override, and one plane refusing a record with a cut parent chain while the other silently ran on the truncated path.
- **A convention with four enforcers has none.** When several call sites must each remember to do a thing, the thing belongs in a function they all call, and that function must REPAIR rather than trust the first writer. `writeFileAtomic` is that shape.
- **A shared rule is tested once, where it lives; a caller's test proves only its own wiring.** Four hosts calling one `registerWebhooks` do not each owe a "long-connection is not registered" test — that belongs to `deploy-channel-ingress.test.ts`, and a host test owes the URL it hands over and what it does with the gate. Same for the Lark scaffold that is the Feishu one with the cloud swapped, and a chat channel over `channels/kit/turn-*` (its own tests cover the record shape, the ACK boundary, and how a dropped or deferred turn reaches the asker — not the ceiling arithmetic). A list-driven structural guard is likewise ONE test whose assertion names the offending file, not one `it` per file: `package-boundary.test.ts` shed 40 cases that way without losing a line of coverage.

- **A CLI test calls the command in-process unless the test is about the process.** `runInProcess` (`test/cli-run.ts`) answers what a spawned CLI answers — exit code, stdout, stderr, the files it writes — for the cost of the command; `run` cold-starts a whole process, ~0.5–1s of CPU each, and the suite is CPU-bound, so every needless spawn is paid by every CI job. Use `runInProcess` for what a COMMAND decides (a refusal, a usage error, a JSON answer, a write). Use `run` only when the test would be wrong with no process involved: stdout/stderr discipline across a real pipe, a signal or a kill, a command that outlives its caller (a ticket's background process signals its process group on exit, so it must never run in-process). `test/cli-run-parity.test.ts` pins that the two agree; if you find a difference, extend it there.

- **A test that asserts "X must not happen" is unproven until X has happened.** Run the mutation that makes it happen and watch the test fail; a green suite says nothing about a claim the test cannot observe. The failure mode is specific: a test DOUBLE that omits part of the contract it stands in for. Two fake `fetch`es here ignored `init.signal`, so "the client does not kill a healthy connection" stayed green under a change that killed every one of them — the doubles reported on bytes and could not see teardown at all. Hence one shared double per contract (`scripted-agent.ts` for the Agent) rather than a fake per case: a clause several hand-written doubles must each remember is a clause some of them will not.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** While iterating, run the test files for the code you changed (`npx vitest run test/<file>.test.ts`); run the full gate once before pushing. Do not push to discover bugs in CI.
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`. The prefix is also what labels the PR (`.github/labeler.yml`), and CODEOWNERS requests the reviewer — so `gh pr create --base main --assignee @me` is enough. `gh issue create` is the exception: it cannot read the issue forms (`--template` only sees Markdown templates), so pass the fields it would have set — `--type Bug --label bug` (or `Feature`/`enhancement`, `Task`/`chore`).
3. **Squash merge** (repo settings enforce it, and required CI): one PR = one commit on `main`; curate the PR title/body — they become the commit message. Branch commits are working state, the PR is the design asset: put the durable *why* there, not in per-commit narration. `main` enforces linear history; force-push is forbidden.
4. **Review policy.** Merging is a maintainer's decision, never an agent's. After opening a PR, report it with the local gate result and stop; do not wait for CI. When told to merge, run `gh pr merge <N> --squash --auto` and return without waiting. It does one of two things, and the report names which one its output shows: it merges the PR (its required checks have passed), or it enables auto-merge (its checks are still running; it merges once they pass, and stays open if they fail). External-contributor PRs are reviewed and merged by a maintainer.
5. **After merge.** Auto-merge lands later, so clean up only once `gh pr view <N> --json state -q .state` prints `MERGED`. A deleted remote branch is not that proof: a closed PR's branch can be deleted too. Use `-D`, because a squashed branch is never an ancestor of `main`:
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
