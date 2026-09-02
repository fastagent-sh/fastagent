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

```
src/
├── agent.ts                 # the Agent Handler contract (pure types, no engine import)
├── service.ts               # THE PRODUCT AS ONE CALL: a directory becomes a live service
│                           # (mountAgentService; engines/pi/service.ts adds the opener in front of it
│                           # as createAgentService). Before it, only the CLI could keep fastagent's
│                           # "into a live service inside an app" promise — everything else was
│                           # parts an embedder had to assemble in the right order, and getting it
│                           # wrong is silent (a plane that 404s while advertising itself). The
│                           # assembly parts (routesFor / mountSessionControl / startSchedules) live
│                           # here rather than in cli/, because a public entry must not reach into a
│                           # directory that calls process.exit — guarded in package-boundary.test.
│                           # dev/start are callers of this, not a second implementation.
├── channel.ts               # the Channel contract — the TRIGGER side of the product boundary
│                           # (core.md §1), beside agent.ts and session.ts: ChannelModule / Routes /
│                           # ChannelHandler / LongConnection*. Pure types, no host, no framework:
│                           # a WebSocket ingress needs LongConnection and has no HTTP in it, and a
│                           # channel author must not pull node:http in behind a type import.
├── collect.ts               # caller-side stream helpers: collect (buffered consumption) + abortFirstIterator (shared cancellation protocol)
├── core.ts, node.ts,        # THE THREE LAYERS, split by what each costs to import: core (+session)
│   pi.ts                    # is engine- AND runtime-neutral with ZERO packages; node adds what needs
│                           # a Node runtime (the assembly, the http binding); pi names an engine.
│                           # Every layer's dependency list is asserted in package-boundary.test.ts.
├── index.ts                 # supported all-in-one entry (re-exports core + node + session + pi)
├── cli.ts                   # the THIN entry (import-free; lazy-loads cli/program.ts)
├── cli/                     # the CLI, built on clig.dev: kernel.ts (CommandSpec-as-data + the commander adapter — commander appears ONLY here; help/suggestions/exit-code policy: 0 ok, 1 runtime, 2 usage), program.ts (the spec registry — the CLI surface's single source of truth; lazy per-command imports), presenters (invoke-stream.ts `invoke` stream → exit code; models-view.ts/auth-view.ts `models`/auth-report output; add-feishu.ts `add feishu|lark` app onboarding), shared.ts/serve.ts (cross-command helpers: serve/bind reporting, tunnel — the ASSEMBLY lives in service.ts and the agentcore one in channels/agentcore-service.ts, since a public entry may not reach into cli/), fail.ts, commands/ (one module per command)
├── telegram.ts, github.ts,  # subpath-export shims (@fastagent-sh/fastagent/telegram etc.)
│   slack.ts, feishu.ts,
│   lark.ts
├── bind.ts                  # THE reading of a bind address, as the six DIFFERENT questions it is:
│                           # bindable (isBindAddress) / an address not a name (bindAddress, applied
│                           # where a value enters) / reach (classifyBind) / dialable by the NAME
│                           # localhost (answersLocalhost — NOT the same as reach: 127.0.0.2 is
│                           # loopback and --tunnel still cannot reach it) / how a message names it
│                           # (bindLabel) / what a client dials (clientHost). The flag, http.host
│                           # validation, serveNode, the ready lines, control.json and the deploy
│                           # pre-flight all read one through this — conflating any two of those
│                           # questions produces a silent failure, which is why they are separate.
├── log.ts                   # leveled logging singleton (dev=debug, start=info)
├── session.ts               # engine-neutral session-control contract (SessionControl: state/entries/events + dispatch, error codes)
├── session-remote.ts        # remote clients over /control/*: connectSessionControl (control plane) + connectAgent (data plane)
├── observe.ts               # turn-trace logging around an Agent
├── tunnel.ts                # `--tunnel`: cloudflared + per-channel webhook dispatch
├── dev-supervisor.ts        # `dev` supervisor: restart on code-input edits (definition is live-read per invoke)
├── proxy.ts                 # HTTPS_PROXY wiring
├── env.ts                   # `.env` → process.env loading (missing file is normal; anything else surfaces)
├── runtime.ts               # agent runtime/package-manager detection (node vs bun) + readPackageJson
├── loader.ts                # neutral ESM module discovery/loading for tools/ channels/ schedules/ config
├── paths.ts                # PLACEMENT + the path predicates everyone shares (isUnderDir):
│                           # resolvePlacement — ONE marker (`fastagent.config.*`, at any
│                           # NAME) and one rule: the workspace is the dir you point at, the agent is the
│                           # single config holder at it or one level inside + the machinery paths that follow
│                           # (.secrets/.state + env overrides), the containment guard, and the neutral
│                           # path helpers the CLI/deploy share (displayPath, exists). Engine-neutral,
│                           # so the scaffold/deploy/watcher/env consume it without touching engines/pi.
├── atomic-write.ts         # writeFileAtomic: the ONE synchronous "whole file or none of it" write
│                           # (temp + rename + mode), after five copies drifted apart. The fixed
│                           # `<path>.tmp` rests on one-writer-per-state-root, with slack onboarding
│                           # state as the documented exception, and is the seam channel tests use to
│                           # inject a write failure.
├── version.ts              # package version (deploy pins it into the image)
├── scaffold/                # `init` / `add <channel>` / `add skill` + templates/ (real files)
├── channels/
│   ├── serve.ts             # HOW a route table becomes a running server. Dispatch is a MAP LOOKUP
│   │                     # on literal paths — a deployment mounts a handful (one per channel, plus
│   │                     # health, plus the plane's prefix), and a routing library would answer the
│   │                     # same question through a pattern language we do not use, whose extra
│   │                     # semantics every collision check would then have to PREDICT. Prefix
│   │                     # owners are a separate mount argument, not a key spelling. Plus the
│   │                     # totality boundary and the node:http binding. Shared ground, NOT a
│   │                     # deployment target: every host in deploy/ runs this same process. Hono
│   │                     # lives INSIDE this file (overrideGlobalObjects: false keeps it there — an
│   │                     # embedder's globals are not ours to swap); the types stay pure Fetch.
│   ├── agentcore-service.ts # the AgentCore SERVING assembly — same product as service.ts, built
│   │                     # differently because the host is: the adapter is the surface, channels are
│   │                     # discovered LAZILY (the state mount at boot is pre-restore, so eager
│   │                     # discovery would cache that emptiness and clobber the restore), the clock
│   │                     # is external, resident connections cannot survive scale-to-zero. Returns an
│   │                     # AgentService, so `start` picks an assembly once and everything after is
│   │                     # common. Owns nothing process-global: the wake sink stays with the entry.
│   ├── agentcore.ts          # the RUNTIME adapter that assembly serves: AgentCore gives a container two
│   │                     # paths (POST /invocations, GET /ping) and no public URL, so every trigger arrives
│   │                     # as an ENVELOPE (webhook | schedule-fire | invoke | wake-poke | checkpoint | probe)
│   │                     # and the channel's real HTTP status rides INSIDE a transport-200 reply. The
│   │                     # authentication boundary is here: InvokeAgentRuntime is an ordinary IAM action, so
│   │                     # only a shared-secret envelope is the forwarder's; a public one runs `invoke` alone.
│   ├── agentcore-state.ts    # cross-deploy durability: the platform wipes the state mount on every version
│   │                     # update, so the root is restored from / pushed to an S3 snapshot via presigned URLs
│   │                     # the forwarder mints per envelope
│   ├── agentcore-limits.ts   # the HOST's body ceilings, computed once (a Function URL caps at 6 MB, and the
│   │                     # body rides base64 inside a JSON envelope) — deploy states it at plan time
│   ├── busy.ts               # process-wide in-flight work counter + the 0-in-flight EDGE. Webhook channels ACK
│   │                     # fast and finish the turn in the background, so "is this process busy?" is NOT
│   │                     # derivable from open requests — /ping (HealthyBusy) and the state snapshot both read it
│   ├── http.ts              # HTTP/SSE channel (consumes only the Agent contract). Serving it is
│   │                     # serve.ts's job — this file knows only the contract and one stream's shape
│   ├── control.ts           # session-control transport: bearer-token /control/* routes (dispatch + SSE events with wire envelope + /control/invoke)
│   ├── discover.ts          # channels/ filesystem discovery (ChannelModule → Routes) — engine-neutral,
│   │                     # so it lives here and not under engines/ (#365)
│   ├── body.ts, respond.ts  # channel-authoring kit (body cap, responses)
│   ├── wait-health.ts       # SHARED readiness probe — channels AND deploy use it, so NOT in kit/
│   ├── registration.ts      # SHARED registrar outcome (registered|manual|failed) — same reason
│   ├── kit/                 # WRITING a channel — the parts every chat platform needs and none should
│   │   │                     # reinvent. The split from the mechanism beside it is a FACT about
│   │   │                     # imports, asserted in package-boundary.test.ts: every file here has
│   │   │                     # consumers only under channels/<platform>/, and serve/http/control/
│   │   │                     # discover have none there. Neither side may reach for the other.
│   │   ├── preview-kit.ts   # turn-view reducer (event → view state + line renderers) + preview policies
│   │   ├── invoke-turn-kit.ts # busy-retry stream loop around agent.invoke (onCompleted commit point)
│   │   ├── turn-queue.ts    # in-memory per-session serial turns (FIFO; telegram + slack + feishu)
│   │   ├── turn-store.ts    # generic durable turn intent (L1) — record shape/validator/order injected
│   │   ├── context-buffer.ts# generic durable un-summoned-discussion buffer (peek→completed→commit)
│   │   ├── thread-participants.ts # who the agent has HEARD in a thread (the summon rule)
│   │   ├── state.ts, seen.ts# atomic channel state + bounded durable delivery dedup
│   │   ├── signature.ts     # replay window for a signed webhook ingress (the LENGTH is the platform's)
│   │   ├── tasks.ts         # fire-and-forget side-task tracking — channels drain it in turnsIdle
│   │   ├── text.ts          # Unicode-safe code-point slicing (cards, preview kit)
│   │   ├── attachment-path.ts # where an attachment lands: the conversation id is ENCODED into a
│   │   │                     # directory (like piSessionId — an id belongs to the caller, so it is
│   │   │                     # never rejected), the file name is only reduced, since the model reads it
│   │   └── stop-command.ts  # the shared /stop parsing every chat channel accepts
│   ├── github/              # github channel (+ scaffold/ bundle)
│   ├── telegram/            # telegram channel: see docs/design/core.md §7
│   │   ├── telegram.ts      # Telegram wiring: ingress + per-turn lifecycle + composition (pure parsing → parse.ts, run one turn → invoke-turn.ts)
│   │   ├── parse.ts         # pure protocol parsing: field extraction, prompt envelope, summon/route policy (no state/IO)
│   │   ├── invoke-turn.ts   # run one turn: assemble inputs (resolve attachments: download/vision) + stream agent.invoke
│   │   ├── turn-store.ts    # telegram's record + update_id arrival order over the shared generic store
│   │   ├── context-buffer.ts# telegram's entry shape + attachment selection over the shared generic buffer
│   │   ├── preview.ts       # live-preview pump + terminal-write policy
│   │   ├── telegram-api.ts  # the single Bot API pipeline + HTML-aware split
│   │   ├── register-webhook.ts # --tunnel setWebhook registration
│   │   └── scaffold/        # `add telegram` bundle (channel.ts + send tool)
│   ├── slack/               # Slack Agent: native streams + inline tool traces, rotating bot auth, signed Events API ingress, durable threads/context, files + onboarding/scaffold
│   ├── feishu/              # CANONICAL Feishu channel engine — see docs/design/core.md
│   │   ├── feishu.ts        # ingress + per-turn lifecycle + composition; Lark binds this engine via a profile
│   │   ├── cloud.ts         # explicit Feishu-reference / Lark-compatibility capability profiles
│   │   ├── model.ts, normalize.ts, parse.ts, crypto.ts, card.ts # protocol model/content normalization/policy + security/card
│   │   ├── invoke-turn.ts, preview.ts # turn IO + streaming-card delivery
│   │   ├── context-buffer.ts# feishu's entry shape + resource selection over the shared generic buffer
│   │   ├── feishu-api.ts    # canonical Open API pipeline (token cache, retry, cardkit)
│   │   ├── register-app.ts  # `add feishu`: scan-to-create device flow
│   │   ├── register-webhook.ts, bootstrap-token.ts # event URL + token automation
│   │   └── scaffold/        # `add feishu` bundle
│   └── lark/                # Lark compatibility/degraded edges over the Feishu engine
│       ├── lark.ts          # thin branded adapter bound to LARK_COMPAT_CLOUD
│       ├── onboard.ts       # unbound launcher + credentials + manual config fallback
│       └── scaffold/        # `add lark` bundle
├── deploy/                  # `deploy docker|fly|railway|agentcore`: host artifacts + runbook + `--run` CLI drive (docs/design/core.md §9)
│   │                        # LAYOUT: neutral kernel at top (horizontal) + one dir per host (vertical) — new host = new dir, copy fly/.
│   │                        # The CLI branch that picks between them is cli/commands/deploy.ts; what it may NOT
│   │                        # hold is a fact about ANOTHER host ("--into-linked is railway's" lived in three
│   │                        # branches and drifted) — that is HOST_ONLY_FLAGS, one row per host-only flag
│   │                        # that only WARNS elsewhere. `--tunnel` is host-only too and stays a usage GATE
│   │                        # in runDeploy (exit 2): a refusal is not a row, and tabling it would make it advice.
│   ├── channel-ingress.ts   # HOW A RUNNING CHANNEL IS REACHED: default route, who can set that URL
│   │                     # end-to-end, the words when nobody can. The ONE answer to "which channels
│   │                     # have a webhook" — it was written per host (3 runbooks, 3 --run drivers, a
│   │                     # docker path table, the tunnel announcer) and the long-connection exception
│   │                     # reached only the feishu/lark branches, so a long-connection Telegram deploy
│   │                     # printed setWebhook and 409'd the channel it just deployed. Every function
│   │                     # filters the DeclaredChannel list ITSELF — a pre-filtered argument is how it
│   │                     # drifted. Consumed by every host AND by the serving path (src/tunnel.ts)
│   ├── registration-gate.ts # host-NEUTRAL step-7 gate policy: registrars report facts (registered|manual|failed), this owns gate-or-not
│   ├── preflight.ts         # host-NEUTRAL pre-flight: model-travel gate (modelTravelIssue), channel discovery, auth probe, container facts + warnings
│   ├── container.ts         # portable Dockerfile + .dockerignore (host-neutral) + the generated-marker predicate
│   ├── secrets.ts           # BOTH directions of the credential carry: required-secret NAMES (runbook),
│   │                     # assembleSecrets VALUES (--run), and the boot-side authSeedBytes/collectAuthSeed
│   │                     # the container reads them back with. The read side lived in fly/run.ts, which
│   │                     # `start` had to reach into to deploy nothing on Fly.
│   ├── runner.ts            # the shared host-CLI dispatcher seam (CliRunner + spawnRunner; faked in tests)
│   ├── docker/    { plan.ts, run.ts }  # Local Docker: Compose topology (agent + optional Quick Tunnel) + `--run` compose driver
│   ├── fly/       { plan.ts, run.ts }  # Fly: PLAN (artifacts + runbook, pure) + `--run` driver (drives flyctl behind the runner seam)
│   ├── railway/   { plan.ts, run.ts }  # Railway: same two roles — NOT a copy of Fly (thin config, minted URL, no scriptable scale-to-zero)
│   └── agentcore/ { plan.ts, run.ts, logs.ts, zip.ts }  # AWS Bedrock AgentCore: ONE CloudFormation stack (runtime +
│                         # forwarder Lambda for webhooks + EventBridge rules for schedules). No public URL and no
│                         # resident process — the two facts every difference in channels/agentcore*.ts follows from.
├── schedule/               # the N axis, clock form: a time-trigger firing the agent on a cron (schedules/<name>.ts)
│   ├── schedule.ts         # defineSchedule({ cron, tz?, prompt }) authoring surface + types (no session field — it's runtime-derived)
│   ├── cron.ts             # the one place touching `croner` (zero-dep, IANA tz/DST): nextRun + cronError
│   ├── discover.ts         # schedules/ filesystem discovery (loadSchedules/discoverScheduleFiles), isolates a bad file (G2)
│   ├── scheduler.ts        # lifecycle + fire algorithm (overdue catch-up ONCE, claim-before-invoke) + stable per-schedule session + wake-up poll
│   ├── wakeups.ts          # the agent's self-scheduled wake-ups, one-shot + recurring (2nd producer): engine-neutral store + guardrails (min delay/gap, cap, claim/defer)
│   ├── audit.ts            # runs.jsonl append-only run audit (full reply) + `schedule history` reader — "did last night's run silently fail?"
│   ├── wake-alarm.ts       # the wake-up's EXTERNAL-clock form: on a scale-to-zero host nothing is resident to
│   │                     # poll, so each pending wake-up is mirrored into a one-shot EventBridge schedule
│   │                     # through the forwarder, plus the boot reconcile that re-arms alarms a deploy lost
│   └── state.ts            # atomic schedule state under <stateRoot>/schedule/ (fires.json + wakeups.json)
└── engines/pi/              # the pi reference implementation
    ├── service.ts           # createAgentService: the public one-call shortcut = this engine's opener +
    │                         # the neutral mountAgentService. Here, not in src/service.ts, because
    │                         # opening a DIRECTORY is the only pi-specific part of it
    ├── create.ts            # reusable assembly ladder L1–L2 + engine assets/prompt
    ├── turn-kit.ts          # the turn mechanism's pi-CLASS-neutral half: lease (single-writer
    │                         # floor), terminals (settled message/thrown error → SPEC terminal +
    │                         # retryable), EventQueue (push→pull), prompt image prep, the SPEC
    │                         # projection, and the observation seam (RunControls + SessionObserver)
    ├── invoke-session.ts    # THE L0: pi's AgentSession, one per invoke, over the same durable
    │                         # record. Events translate ONCE into the rich SessionEvent vocabulary;
    │                         # the SPEC stream is its projection. Owns the run's identity, its
    │                         # controls, and exactly one settlement
    ├── agent-session-factory.ts # the engine binding: the assembly (model/prompt/skills/tools) bound
    │                         # to one record per invoke. services shared, session per turn. Carries
    │                         # the adaptations pi's TUI origins require — see its header
    ├── session-store.ts     # session records on pi's SessionManager: Caller ids encoded into names
    │                         # pi accepts, a record published on create (pi buffers until the first
    │                         # assistant message), crash reconciliation for interrupted tool calls
    ├── session-inheritance.ts # where a NEW thread starts from when it names a parent
    │                         # (participant-model.md §5): fork the parent's active path to the branch
    │                         # point, then bound the model's view with one mechanical compaction mark
    ├── session-control.ts   # the pi session-control hub: observation projections + dispatch (run modulation, boundary mutations, abortable compaction)
    ├── session-markers.ts   # which journal entries are POSITIONS and which are the plane's own bookkeeping.
    │                         # One module because the record store and the history copier must agree, and a
    │                         # disagreement is invisible until a fork comes back missing something
    ├── session-settings.ts  # what a session is SET TO, and what it may be set to. Model and thinking level
    │                         # are ONE setting (which levels exist is a property of the model), so `state()`,
    │                         # the update() gate and the per-invoke binding resolve them HERE rather than
    │                         # each deriving its own — the run plane and the observation plane, one function
    ├── session-builder.ts   # definition-aware session builder: agent assembly → resident pi AgentSessionRuntime (chat TUI consumes it)
    ├── open.ts              # shared opener: directory → agent for dev/start/invoke
    ├── chat.ts              # `chat` channel: drive pi's interactive TUI with the assembled agent
    ├── tool.ts              # defineTool (Zod, incl. deferred: true) + tools/ filesystem discovery
    ├── tool-context.ts      # ToolContext.session + tool-activation bridge via AsyncLocalStorage (set around the turn; read in execute — the wake/search_tools seam)
    ├── search-tools.ts      # built-in search_tools loader for deferred tools (auto-mounted when any tool is deferred; author's wins)
    ├── wake-tool.ts         # the built-in `wake` tool (pi-coupled: defineTool): writes a wake-up into ToolContext.session; withWakeTool mounts it (serving path only)
    ├── definition.ts        # AGENTS.md + skills loading and bundling
    ├── config.ts            # fastagent.config.ts loading + model/precedence (placement lives in paths.ts)
    ├── auth.ts, login.ts    # credential store/resolution (project-level auth.json default) + `login` flow
    ├── models.ts            # Models collection wiring + the agent's OWN models.json (custom endpoints:
    │                         # definition-local so it travels; the machine-global ~/.pi one stays unread)
    └── report.ts            # startup report (auth/model/skills/tools surface)
test/                        # vitest; faux models by default + reusable SPEC conformance.
├── embedding.test.ts       # the docs/embedding.md snippets, run against REAL express/fastify (the
│                            # only reason they are devDeps): that path crosses the Node/Fetch seam
│                            # through code we do not own, so a swap underneath can keep every unit
│                            # test green while breaking the paste-this-in promise
└── live/                   # the probes for what the offline suite FAKES — every file here exists to
                             # check an assumption about a system we do not own, never to re-run logic:
                             # the published tarball (registry), a real provider's stream and errors
                             # (model), a real container build + boot + state volume (docker), a real
                             # Quick Tunnel carrying a request home (tunnel), a cron on disk firing a
                             # real turn into the audit log (schedule), Telegram VERIFYING a webhook URL
                             # it was handed and Feishu CALLING one with a challenge (telegram/feishu —
                             # registration only; delivery needs a human to type), and Slack's Bot API
                             # answering our pipeline (slack — OUTBOUND only: its inbound half needs a
                             # 12h App Configuration Token, which no nightly can hold), `flyctl` still
                             # printing what the Fly driver reads (fly — read-only), and a REAL Fly app
                             # provisioned then destroyed (fly-deploy — which is how #425 was found: a
                             # deploy whose every step succeeded, serving on a URL that had no IP).
                             # Each one drives a PRODUCT ENTRY (`createPiAgentFromDir`,
                             # `deploy docker --run`, `deploy fly --run`, `npm install`,
                             # `startCloudflareTunnel`, `startSchedules`, `registerTelegramWebhook`,
                             # `registerFeishuWebhook`, `createSlackApi`) and observes from OUTSIDE it
                             # — except the read-only fly probe, which checks a real `flyctl`'s output
                             # against the driver's PARSING assumptions about it (`listHasName`,
                             # `ingressAddresses`): the belief a faked CliRunner cannot test
                             # — a probe that rebuilds the assembly to get a better observation point
                             # measures the rebuild, and the entry's own steps (installProxyFetch,
                             # credential resolution, pinning pi's agent dir) go missing one at a time.
                             # Unit tests below DO reach into that layer, correctly — the rule is this
                             # directory's, because only these files claim to report on the real thing.
                             # Excluded from `npm test`; `npm run test:live` (vitest.live.config.ts)
                             # opts in, and a missing credential FAILS rather than skips — you asked
                             # for them. Credentials arrive the PRODUCT's way (FASTAGENT_AUTH_PATH → an
                             # auth.json), which is what lets an OAuth-only provider be the model.
docs/                        # SPEC, guides, and maintainer design notes (design/core.md = architecture)
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
- **The artifact is the truth.** Deployment behavior must come from the bundled definition, not the builder machine's global state. Engines have their own opinion about this: pi reads its settings (retry budget, compaction thresholds, default thinking level) from `~/.pi/agent` unless pointed elsewhere, so the binding points it at a definition-scoped path. Any new engine surface that reads "the user's config" gets the same treatment.
- **A session id belongs to the Caller.** `scope.session` is opaque and arbitrary — a telegram group is `-1001234567890`, a feishu thread carries `:` and `/`. What an engine needs to store it (pi rejects all of those as record names, so they are encoded) is storage detail and must not leak back out: a tool asking which conversation it is in gets the id the channel minted, not the record's name.
- **The run plane and the observation plane read the same state, through the same function.** They answer different questions about one session — what will execute, and what to report — so deriving them separately is how they come to disagree. The concrete failures this rule is made of: a turn running on assembly defaults while `state()` reported the recorded override, and one plane refusing a record with a cut parent chain while the other silently ran on the truncated path.
- **A convention with four enforcers has none.** When several call sites must each remember to do a thing, the thing belongs in a function they all call, and that function must REPAIR rather than trust the first writer. `.secrets/` was created by four paths and only one passed `0700` — and `mkdir`'s mode is a no-op on an existing directory, so the careful one (login, which runs last) never applied it: every scaffolded agent held its credentials in a 0755 directory. `ensureSecretsDir` (paths.ts) is that function; `writeFileAtomic` and `sessionToolActivation` are the same lesson from the same review.

### Reviewing this repo

Read by RISK SHAPE, not by directory. A five-round sweep of `engines/pi/` → `deploy/agentcore/` → `channels/` in listed order produced three bugs, then one, then zero, while missing `auth.ts`, `start.ts` and `scaffold/` entirely — the mode bug above sat in two of them. The shapes that actually carried defects here, all greppable in minutes across the whole tree:

1. **One concept, several implementations.** Two copies that differ by a line (`sessionToolActivation`), N gates where one is careful and the rest are not (the forwarder's three secrets), a convention every caller re-states (the secrets mode). Same-named functions across `channels/*/` are usually NOT this — those are per-platform protocol differences.
2. **Secret comparison and secret writing.** Every inbound check constant-time; every credential written whole-file with its mode applied before the content is reachable.
3. **Assumptions about a dependency's undocumented behaviour.** Read the dependency's implementation, not its types or its docs — `firstKeptEntryId` pointing at a metadata entry and pi's setters being synchronous were both found that way, and both had been guessed wrong from the docs.
4. **A comment that describes code that no longer exists.** The dangerous ones assert a constraint (`MUST stay under 4096 bytes`) or a mechanism (`filters the log stream prefix`) — they argue the next person into the wrong change.

## GitHub workflow (summary)

Full version: `CONTRIBUTING.md`. The essentials:

1. **Local-first.** Verify locally before opening a PR; do not push to discover bugs in CI.
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
2. **Branch → PR → CI → merge.** Never commit directly to `main`. Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.
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
