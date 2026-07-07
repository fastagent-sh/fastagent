---
title: fastagent — Core design
type: design-doc
status: current
updated: 2026-07-03
---

# fastagent core design

This document describes the current pi-based reference implementation of the [Agent Handler SPEC](../SPEC.md). The code source of truth is `src/`.

Technical analogy: FastAgent plays the WSGI-like layer for agent serving — a small internal handler contract plus a reference implementation and deployment tooling around existing agent definitions.

The **scenario grid** below frames *what* fastagent serves (the product surface); the numbered sections (§1 onward) are *how* the current implementation does it. Where a cell's mechanism is not yet built, it is named as direction and tracked in §11 — never described as current.

## Scenario grid: two axes, six cells

An "agent scenario" factors into two orthogonal axes; the six cells are **distinct products**, not one shape with options:

- **Ownership** — *embedded* (a library feature inside your app; your app owns runtime/auth/DB — `createPiAgent` / `createInvokeHandler` mounted in a route) vs *standalone* (a deployed service fastagent runs — CLI `start`, channels, `deploy`).
- **Subject** — what the agent works on: a *code repo* it reads/writes (coding agent), *external systems* via tools (DB/API), or *stateless* reasoning.

| | **Embedded** (library) | **Standalone** (service) |
|---|---|---|
| **Code repo** | in-app code feature (v0/bolt-like) — library + `env` sandbox; niche | **cloud coding agent** — cwd = the repo, writes code; the Devin / Codex-cloud shape |
| **External systems** | **in-product assistant** — tools call your DB/API, your auth | **support / ops bot** — Telegram/GitHub channel + tools |
| **Stateless** | in-app classify/extract/chat — buffered `collect` (SPEC §7) | Q&A bot / webhook classifier |

**Coverage today:** fastagent serves **five of six** out of the box — all three *embedded* cells via the library API (+ the `env` port for a sandboxed code feature), and *standalone × external/stateless* via channels + `deploy`. The gap is the **standalone × code-repo** cell in its *embedded-in-an-existing-host-repo* form: a coding agent whose workspace is a project it does **not** own (a Next/TS repo). Today that only works in the degenerate *dedicated flat repo* case; serving an agent **inside** a host project it doesn't own is direction (§11).

**Design discipline — the hard cell's *namespace + deploy* complexity stays local to it.** Only *standalone × code-repo, embedded form* needs a **definition namespace decoupled from cwd** (`agentDir`) and a **repo-as-workspace deploy model**; the other five cells stay **flat** (`definition = cwd`) and MUST NOT inherit that decoupling. An authored persona (`persona.md` → segment ①, §2) is deliberately **not** part of that machinery — it is a general additive primitive every cell may use (absent it, ① is the engine base). The hard cell's persona wrinkle is only *where* it lives (outside the host repo) and demoting the host's `AGENTS.md` to context — a consequence of the namespace split, not the persona file.

## 1. Layering: N × M × K

FastAgent aims to collapse **N triggers × M agents × K hosts** into additive seams. Those seams live at different layers:

| Axis | What decouples it | Layer |
|---|---|---|
| N × M: trigger ↔ agent | Agent Handler `invoke(scope, prompt) => AsyncIterable<AgentEvent>` | SPEC / core contract |
| M: engine diversity | the Agent is a black box; definitions/config are assembled into an Agent | core dependency inversion |
| K: host diversity | stateless `invoke`, injected `ExecutionEnv`, sessions, and leases | core provides hooks; target adapters do host work |

The SPEC directly owns N × M. K portability is enabled by core invariants, but each host still needs real target-adapter work.

The N axis has two forms, both on the SAME `invoke` contract (neither adds a new one): **inbound triggers** — channels, driven by an incoming request (§9) — and the **clock trigger** — the scheduler, driven by time (§9.3).

## 2. Agent definitions and prompt assembly

FastAgent consumes existing definition artifacts:

```txt
workspace/                    # flat: the run root (cwd) IS the agent dir
├── AGENTS.md                 # ② project context (optional)
├── persona.md                # ① authored identity (optional)
├── skills/  tools/  channels/
├── fastagent.config.mjs      # may set `agentDir: "./agent"` to serve an existing repo (below)
└── .fastagent/               # generated machine state, ignored by git
```

The two roots are `cwd` (the run root the tools operate on; where config lives) and `agentDir` (the
agent's own surface — persona.md/skills/tools/channels). They coincide in the flat layout; `config.agentDir`
decouples them so a coding agent's definition can live in a subdir of a host repo (§11 / scenario grid).

`AGENTS.md` is not the system prompt. The pi reference implementation assembles the final prompt from four segments:

| Segment | Source | Owner |
|---|---|---|
| ① base prompt | pi engine binding (`piBasePrompt`); an authored `persona.md` overrides its identity line, keeping the tool list + guidelines | engine asset / definition |
| ② project context | `AGENTS.md` files via pi's exported `loadProjectContextFiles({ cwd, agentDir })` — the agentDir's own plus every `AGENTS.md` walking `cwd` up to root; each wrapped `<project_instructions>` | project (cwd) + definition |
| ③ skills listing | loaded skills, formatted for progressive disclosure | agent definition |
| ④ environment context | date and cwd | runtime assembly |

`assembleSystemPrompt` is pure (mirrors pi's `buildSystemPrompt`): callers provide the resolved `contextFiles` + date/cwd. L2 uses a factory so long-running processes re-read the definition and re-evaluate context per invocation.

Why two authored slots: `persona.md` is the agent's **identity** (①), `AGENTS.md` is **project context** (②) — conflating them (AGENTS.md-as-system-prompt) was the earlier mistake. **L1 `createPiAgent` is different on purpose**: its `instructions` ARE the system prompt (verbatim, no engine base, no wrapping) — the skills listing is the only thing appended. So a hand-built agent is not forced into the coding persona.

## 3. pi reference implementation

The reference implementation is built on `pi-agent-core` `AgentHarness`, not the TUI-oriented `pi-coding-agent` session wrapper.

pi exposes two useful ports:

- `harness.prompt(...) -> Promise<AssistantMessage>` for the final buffered result,
- `harness.subscribe(...)` for streaming side-channel events.

FastAgent fans those into one SPEC stream:

```ts
async function* invoke(scope, prompt) {
  const release = lease.tryAcquire(scope.session);
  if (!release) { yield busyFailedEvent; return; }
  try {
    const harness = await harnessFactory(scope.session);
    const queue = new EventQueue<AgentEvent>();
    const unsub = harness.subscribe((event) => queue.push(toAgentEvent(event)));
    try {
      const run = harness.prompt(prompt.text, toPiPromptOptions(prompt));
      yield* queue.drainUntil(run);
      yield toTerminal(await run);
    } finally {
      unsub();
      await harness.abort();
    }
  } finally {
    release();
  }
}
```

The real implementation catches setup/runtime errors and converts them to `failed` events so iteration does not throw (SPEC MUST 2). Cleanup errors are intentionally prevented from poisoning an already-terminal stream.

## 4. Assembly ladder

The reusable ladder is three rungs (L0–L2); each upper rung delegates downward.

| Rung | Function | Meaning |
|---|---|---|
| L2 `[LOAD]` | `createPiAgentFromDefinition(dir, options)` | load `AGENTS.md` + skills, assemble prompt, then L1 |
| L1 `[ASSEMBLE]` | `createPiAgent(options)` | assemble from typed parts: `model` (spec string) + `instructions` + tools (+ sessions/env/lease/providers) |
| L0 `[ADAPT]` | `createPiAgentFromHarness({ harnessFactory })` | adapt pi harness wiring into the Agent Handler stream |

Naming rule: `From<source>` means inputs are derived from that source. No suffix (`createPiAgent`) means typed parts are supplied directly.

L0 lives in `invoke.ts` because its body is the request-time turn mechanism; L1–L2 live in `create.ts` because they are configuration-time assembly.

**The workspace opener (above L2).** `dev` and `start` are the SAME thin composition over L2 — open a directory, resolve model/tools, pick session storage, call L2 — living in one workspace module so `create.ts` stays the pure reusable ladder. There is no build/artifact: the directory IS the agent, run directly (see §10).

| Command | Function | Module | Posture |
|---|---|---|---|
| `dev` / `start` | `createPiAgentFromWorkspace(dir, { model?, sessionsDir? })` | `workspace.ts` | one opener; `dev` watches (authoring), `start` runs production posture (no watch) |

## 5. Config v1

`fastagent.config.mjs` currently has three keys:

```ts
export default defineConfig({
  model: "provider/modelId",
  tools: [myTool],
  http: { port: 8787 },
});
```

Semantics:

- `model` is the repo default; precedence is CLI `--model` > `FASTAGENT_MODEL` > config.
- `tools` are custom code tools appended after pi defaults; they never replace defaults.
- `http.port` configures the built-in dev HTTP channel.

Deliberately not in v1: session/env backend selection, auth overrides, base prompt overrides, and skill-path overrides. Those remain library API escape hatches until real hosting backends shape the config surface.

## 6. Tools and skills

Skills are markdown/file assets. Loading is **definition-only, period**: an agent is exactly its directory (`AGENTS.md` + `skills/`). This is the structural form of "your directory is the agent" — the same definition loads the same skills on every machine, and dev behavior equals deployed behavior, with **no exceptions**. There is no global-skill mount and no `skillPaths` escape hatch: skills come ONLY from the definition's own `skills/`.

The `skills/` format is **Agent Skills** ([agentskills.io](https://agentskills.io)) compatible — a `skills/<name>/SKILL.md` with `name`/`description` frontmatter and progressive disclosure (name+description at startup, the body on activation), as implemented by pi's `loadSkills`. Any standard skill (e.g. from [anthropics/skills](https://github.com/anthropics/skills)) works by **vendoring**: copy the directory into `skills/`, git-tracked, and it Just Works — unsupported optional fields (`license`, `metadata`, `compatibility`) are ignored without error. **There is no registry, and none is needed**: the filesystem is the registry, git is the distribution, and the user owns trust (a vendored skill's `scripts/` is code they audit, like an npm dependency). fastagent is the serving layer, not a skill marketplace.

FastAgent deliberately does not load the machine's global skills (`~/.pi/agent/skills`, `~/.agents/skills`): it would make the agent depend on ambient machine state and recreate the "works on my machine, breaks deployed" trap fastagent exists to kill. The principle is general: **the definition directory is the agent's only source of truth; nothing the code can't see is loaded into its behavior** (credentials and env are deployment config, not behavior — they stay outside the directory by design). To ship a skill, put it in `skills/`.

**One deliberate exception — ② project context.** Following pi (`loadProjectContextFiles`), `AGENTS.md` context is sourced by **walking `cwd`'s ancestors to root** plus the `agentDir`, not from a single hermetic dir. This is safe under the same principle *because `cwd` is the deployed run root* (the mounted/COPY'd unit), so the walk is deterministic within it — but on a dev box the walk can also pick up an ancestor `~/AGENTS.md`, so dev context can exceed deploy context. Two further notes: `loadProjectContextFiles` reads via node `fs` directly (not the `ExecutionEnv` port — a deviation from this module's portable-IO policy, deferred with the sandbox work), and unlike a broken skill/persona (which fail visibly), an unreadable context file is skipped — pi warns to stderr on a read error, but is **fully silent** when the path itself is inaccessible (its `existsSync` probe swallows the permission error), so no signal reaches fastagent's diagnostics. Deferred with the ExecutionEnv work; a broken persona.md still fails the turn.

Definition-local skills win name collisions (the deployable unit is authoritative); collisions are surfaced as diagnostics, not swallowed.

Code tools are TypeScript/JavaScript modules. The vibe path is `defineTool` + filesystem discovery: drop a file in `tools/`, default-export `defineTool({ description, input, execute })`, and it is auto-discovered, named from the filename (authoritative), schema-validated, and injected — no `name` field, no manual registration. `defineTool` takes a Zod `input` schema (re-exported as `z` from the package), converts it to JSON Schema for the model, validates the model's arguments before `execute` (a validation failure becomes an error result the model can correct, not a crash), and wraps a plain return value into pi's result shape. (Dependency installation and registration are orthogonal: discovery removes the `name` field and the wiring, and does not require the deps a tool imports to be installed — that is the workspace's `npm install`.)

`config.tools` remains as the programmatic/advanced injection path; discovered tools are merged after pi defaults + `config.tools`, deduped by name (existing win; dropped tools are surfaced, not silent). A code-tool workspace must be ESM (`"type": "module"` in package.json) so a tool's `import` resolves. `fastagent tool <name> '<json>'` runs one tool's body directly — no model, no server, no tokens — the tightest authoring feedback loop. Declarative MCP tool mounting via `.mcp.json` is future support, not implemented today.

## 7. Sessions and statelessness

Each `invoke` creates a fresh harness bound to the requested session and discards it after the turn. Conversation continuity comes from reopening the session from a `PiSessionStore` (pi-coupled: it returns pi's `Session`):

- L1 default: `inMemorySessionStore()` for embedding/tests.
- dev opener default: `jsonlSessionStore()` under `.fastagent/sessions` for restart-surviving local dev.

This gives the reference implementation portable conformance in miniature: two separate instances sharing the same external store can continue the same session.

**Crash-safe reopen.** A turn that dies mid tool-execution leaves the session with an assistant `tool_use` whose result was never persisted (pi writes the assistant message at `message_end`, *before* the tools run). The stateless retry path — reopen the session, re-invoke — depends on that transcript staying valid, but pi reconciles nothing (neither `buildSessionContext` nor `convertToLlm`), so the next provider call rejects the dangling `tool_use` and the retry fails: a mid-turn crash poisons the session. So the store reconciles on every open of an *existing* session, appending an honest error tool result for each unmatched call — mirroring pi's own `createErrorToolResult` for aborted calls, at the recovery boundary pi's inline abort path cannot reach (the process was already dead). This restores transcript *validity* only; tool side-effect idempotency stays the tool's responsibility (SPEC §6 non-guarantee). The synthetic result's `content` is model-facing (neutral, decision-guiding, no "aborted" misread, no infra leak); the operational marker lives in `details`, which is never sent to the provider.

## 8. Same-session concurrency

Core provides only a corruption-prevention floor: one in-flight turn per session.

If a second invocation arrives for the same session while one is already running, it immediately yields:

```ts
{ type: "failed", retryable: true, details: "session busy: ..." }
```

Core does not queue. Dedupe, retry, user-visible “busy” messages, and steering are channel-level decisions because only the channel understands the trigger semantics.

## 9. Triggers: channels and schedules

### 9.1 HTTP channel

`createInvokeHandler(agent)` implements the minimal dev HTTP channel:

- `POST /invoke { session, text }`,
- SSE output with one `data:` line per `AgentEvent`,
- request body cap by real bytes,
- client disconnect calls `iterator.return()` to trigger invoke cleanup.

The HTTP channel consumes only the neutral `Agent` contract.

### 9.2 Telegram channel architecture

The telegram channel is the reference for a **stateful chat channel**: it bridges a streaming,
unbounded, fallible agent turn onto discrete messages, multi-user group chats, and at-least-once
webhook delivery. Its directory (`src/channels/telegram/`) is the future package boundary; each
subsystem owns its invariants in its own module:

| Module | Owns |
|---|---|
| `telegram.ts` | the Telegram WIRING: ingress (secret token, body cap), the per-turn lifecycle (dequeue → ceiling → fold → stream → commit/remove), and composition of the modules below. Pure parsing and turn assembly are split out (next two rows) so the factory holds only stateful wiring |
| `parse.ts` | PURE Telegram→Agent decode: message field extraction, the prompt envelope, and the summon/route policy. Defining invariant is purity — no state, no IO, no Bot API — tested as plain functions. Owns the public `TelegramMessage`/`Update`/`Route` types, `telegramEnvelope`, `defaultTelegramRoute` (re-exported through `telegram.ts`) |
| `invoke-turn.ts` | run one turn (the IO half of Telegram→Agent): assemble its inputs — resolve attachments (download files to disk, load vision images; primary throws, buffered degrades per-attachment) — and stream `agent.invoke` with the assembled prompt. `invokeTurn` is the export |
| `turn-queue.ts` | in-memory per-session serial execution: one turn at a time per session (FIFO chains), different sessions concurrent — the group-UX queue atop the engine lease (a second summon waits instead of colliding as "busy"). Channel-neutral by design (`label` names the consumer). Holds no durability itself; `turn-store.ts` layers it on (see below) |
| `turn-store.ts` | durable turn intent (L1): persists an accepted turn pre-ACK, removes it when the turn ends (the runner's `finally`), and replays a crash-surviving one on the next start. Recovers the ACKed-but-unfinished window the queue drops; at-least-once, with a replay ceiling for poison turns. Exactly-once / step-replay (L2) is still the K-axis backend |
| `context-buffer.ts` | un-summoned group discussion: persisted before each webhook ACK (an ACKed update is never redelivered), folded into the next answered turn, cleared only on that turn's `completed` (only then is it provably in the durable session); carries message ids / reply relations / attachment file_ids so later references ("the file Bob sent") resolve |
| `preview.ts` | the live preview: ONE real message (`sendMessage` → `editMessageText` in place; `sendMessageDraft` is private-only, useless in groups), a single-writer pump (one edit in flight — out-of-order frames are the flicker), and the terminal-write matrix (completed/failed/abnormal × edit/delete+send/suppress) |
| `telegram-api.ts` | ONE transport pipeline (`callApi`) for every Bot API method — per-method wire code does not exist, so the invariants (per-attempt timeout, bounded 429/flood-wait, success gated on the body's own `ok:true`, self-describing typed errors) hold by construction. Plus the HTML-aware split: a tag-stack balancer that closes/reopens tags (attributes kept) across the 4096 boundary |
| `state.ts` | atomic state files (tmp+rename) under the channel-state home; crash-safe, power-loss best-effort (no fsync) |

Durable decisions this architecture encodes:

- **The state root is defined, resolved once, and handed down.** `.fastagent/` is the agent's machine-
  state home: ONE lifecycle (precious, single-process, must survive redeploy) — nothing cache-like or
  runtime-like lives there, so no XDG-style taxonomy inside it. The opener resolves the root
  (`FASTAGENT_STATE_DIR` > `<dir>/.fastagent`, absolute) and hands it to code via `ChannelContext`
  (env/flags are the operator input plane; ctx is the in-process handoff — the systemd
  `StateDirectory=` → `$STATE_DIRECTORY` shape). Engine state lives at the root (auth, sessions);
  channel state under `<root>/channels/<kind>/` (buffers, downloaded files), mirroring
  `src/channels/<kind>/` — anchored on the resolved root, never `process.cwd()`. The in-tree home
  self-ignores (nested `.gitignore`) — it can carry chat content. Single-process semantics; the
  file-backed root is the "local backend", and multi-instance state is the K-axis remote backend, not
  a smarter file layout.
- **Adapters are policy-only factories.** `telegramChannel(opts)` / `githubChannel(opts)` return a
  `ChannelModule` (`(ctx: { agent, stateRoot }) => Routes`), so the scaffolded channel file is one
  policy expression and the framework pipes `agent`/`stateRoot` to the adapter without transiting user
  glue. Custom glue destructures ctx.
- **Turn durability is layered: L1 in the channel (`turn-store.ts`), L2 at the K-axis backend.**
  While the process is DOWN, Telegram retries undelivered (never-ACKed) webhooks, so those are covered
  for free. The remaining window is the ACKed-but-unfinished turn (200 already returned) — Telegram's
  *no-redelivery* case. L1 recovers it: `turn-store.ts` persists an accepted turn's intent pre-ACK
  (like the context buffer) and, on the next start, replays anything an interrupted run left mid-flight.
  "Interrupted" is not just a rare crash: `runStart` has no graceful drain, so a SIGTERM — every rolling
  deploy — exits mid-turn too. This is a per-process WAL: the atomic-rename primitive (`state.ts`)
  already in the channel makes it cheap enough to be worth the ACKed-but-unfinished window that a single
  re-ask otherwise costs. It is **at-least-once, not exactly-once**: replay re-runs the whole turn (re-running
  side-effecting tools — so the idempotency bar is judged against DEPLOY frequency, not rare crashes —
  and possibly orphaning a preview), and the pre-ACK window can overlap Telegram redelivery (same
  update_id, no dedup) — a turn may run twice. An execution ceiling drops a poison turn on its own
  N+1th run (counted per turn at dequeue, so a never-run turn queued behind it keeps its full budget);
  the dropped turn's asker is notified. **Exactly-once delivery (a persisted delivery key) and
  deterministic step-replay are L2 — the K-axis backend's job (§11)**, needing the engine's resume
  hook, not just a store. The un-summoned context buffer is a *separate* durability decision (below): those messages
  are never redelivered as a summon.
- **Summon = consume the platform's structure, not re-parse it:** @mentions from Telegram's
  `mention` entities (never a regex over text — code blocks/URLs can't false-summon); reply-to-bot
  by the bot id parsed synchronously from the token (`<bot_id>:<secret>`, no getMe race); edits
  never summon. Fail closed without an identity.
- **Formatting model:** the agent emits Telegram-HTML strings sent with `parse_mode` (the natural
  fit for LLM output); the entity model is NOT used. **gramIO tripwire** (documented on the `Api`
  table): if the channel ever needs ~10+ methods or entity-based formatting, adopt gramIO instead
  of growing the hand-rolled surface — `callApi<M>` is shape-compatible with `bot.api.*`, so the
  policy layer survives that swap. The transport rewrite itself applied gramIO's architecture
  lesson (one generic call function, policy as its wrapper, typed errors) without the dependency.

### 9.3 Schedules (the clock trigger)

The scheduler is the N axis in **clock form**: a time-trigger that fires the agent on a cron. A workspace
declares one by dropping `schedules/<name>.ts` (`defineSchedule({ cron, tz?, prompt })`), mirroring
`tools/`/`channels/` filesystem discovery — the FILE producer of scheduled invocations (the author's:
declarative, git-tracked, deploy-guaranteed). It borrows the existing `agent.invoke` contract and adds
none; it lives in `src/schedule/` (not `channels/`, because a clock trigger mounts a timer, not a route).

Fire model:

- **Stable per-schedule session**, derived at runtime as `schedule:<name>` (like the telegram channel
  derives one from `chat.id`) — so a schedule's turns share one continuing conversation persisted by the
  core session store. A session id is runtime conversational context (K side, §7/§10.1), never an
  authored field; the definition (`schedules/<name>.ts`) carries only `cron/tz/prompt`.
- **Output is the agent's tools' job.** The scheduler only fires and logs the outcome — it has no reply
  target of its own (unlike a channel's chat/PR). A cron turn's prompt says "send X to Telegram"; the
  agent calls a send tool.
- **Durability = catch up an overdue run ONCE.** `<stateRoot>/schedule/fires.json` (atomic write) records
  the last fire; on start, if the next instant after it is already past (the process was down across it),
  fire once and advance — not once per missed slot. `lastFired` is claimed BEFORE the invoke (at-most-once
  per slot: a crash mid-turn does not re-fire it — "a digest late once" beats "twice"). Strict
  at-least-once (a per-turn WAL, like the telegram L1 turn store) is a later tier.
- **Single-process**, like all state today. Cron has no external wake-up (unlike a webhook), so a
  deployment with schedules must keep one machine running — `deploy` will enforce that (roadmap below).

The cron arithmetic uses `croner` (zero transitive deps + IANA tz/DST — chosen over `cron-parser`, which
pulls luxon, per the dependency philosophy); the scheduler owns fire control, borrowing only croner's
next-instant computation. `fastagent fire <name>` runs one schedule's turn immediately (the authoring
loop, like `invoke`), without advancing fire state.

**Self-scheduling (the SECOND producer).** Opt in with `selfSchedule: true` in `fastagent.config` and, on
the SERVING path (`dev`/`start`, where the poller runs), the opener mounts a built-in `wake` tool that lets
the agent schedule ITSELF: a turn calls `wake({ in, prompt })` and, after the delay, a new turn runs — back
in the **same session**, so the agent resumes the conversation it was in ("check the deploy in 10 minutes").
Off by default — self-scheduling is an autonomy capability (it changes what the agent IS, not just a tool it
has), so it is an explicit choice, not given to every served agent. Never mounted on the one-shot entries
(`invoke`/`fire`), which exit after the turn and never poll — there it would be a promise nothing fulfills. Two producers now feed
the scheduler: the author's `schedules/` files (declarative, guaranteed) and the agent's wake-ups
(runtime, self-managed) — different reliability contracts, so both stay. Mechanics:

- **The session comes from the turn, not a field.** A `defineTool` tool is built once and reused across
  sessions, so the session can't be a closure — it rides an `AsyncLocalStorage` set around the harness
  turn (`invoke`) and read as `ToolContext.session` inside `execute`. The state root (where wake-ups
  persist) IS a build-time closure (the serving path mounts the tool). This split — per-turn value via ALS,
  deploy-time ambient via closure — is the general rule for tool context.
- **Persisted + polled.** A wake-up is written to `<stateRoot>/schedule/wakeups.json` (survives restart);
  the scheduler polls (~30s) and fires each DUE one, claiming it (remove-before-fire) so it is at-most-once.
- **Guardrails** (self-scheduling is a real runaway surface): a minimum delay (no busy-loop) and a cap on
  pending wake-ups (no unbounded fan-out); a rejected `wake` returns the reason to the model. One-shot is
  naturally bounded (fires once), so recurring self-scheduling — with heavier guardrails — is Phase 4b.
- **Re-fire only when replay-safe.** A wake into a BUSY session (a channel is mid-turn on the same id — the
  common "wake me in 10 min while I'm still chatting" case) is deferred and retried (bounded), since the
  turn never started. Every OTHER failure is terminal: re-running a turn that DID start could duplicate its
  tools' side effects. The scheduler tells the two apart by the busy event's `code` (`SESSION_BUSY_CODE`, a
  `failed.code` per SPEC §8 failure subdivision — a structured field on the neutral contract, not a text
  match on `details` or an engine import).
- **Both collision directions are handled for telegram; other channels still fail fast.** The scheduler
  invokes DIRECTLY, bypassing a channel's turn-queue — so "wake fires while the user is chatting" can
  collide both ways. Each side now waits on telegram: a wake INTO a busy session is deferred by the
  scheduler (above), and a USER turn hitting a lease held by an external turn (the wake) busy-WAITS —
  telegram's `invokeTurn` retries a fail-fast `session_busy` reject (the user sees the "Thinking…"
  placeholder, then the answer) instead of showing "try again". Bounded at 10 min — sized to outlast a
  real wake turn (each retry is a cheap lease-level reject, and the wait ends within seconds of the
  holder finishing); a holder that outlives the cap still surfaces the busy error (the ceiling exists so
  a stuck lease can't hang a chat turn forever). Only a FIRST-event busy retries (the turn never started
  — replay-safe). A github/http turn colliding with a wake still surfaces
  busy immediately (their sessions rarely mix with wake sessions; add the same wait if it bites). The
  structural alternative — one shared per-session serial seam — stays deferred: bounded waits cover the
  real scenario at a fraction of the seam's cost.
- **Deploy keeps the machine running (Phase 3, done):** cron/wake has no external wake-up, so `deploy`'s
  pre-flight detects TIME triggers — `schedules/` files OR `config.selfSchedule` — and the fly plan forces
  `min_machines_running=1` (reason-tagged) while the railway runbook forbids App Sleeping.

Every fire is AUDITED: one line per run in `<stateRoot>/schedule/runs.jsonl` (append-only, full reply — an
immutable per-fire snapshot the rolling session can't give), read by `fastagent schedule history <name>`
(or `wake`) — the answer to "did last night's run silently fail?". Total: an audit-write failure never
breaks a fire.

Self-scheduling is one-shot (`wake({ in })`) or RECURRING (`wake({ cron, tz? })` — the entry keeps its id;
each fire re-arms to the next cron instant). Recurring carries heavier guardrails: a minimum gap between
fires (a tight cron is a permanent token burner, stricter than the one-shot floor), and a busy occurrence is
skipped IMMEDIATELY — no defer/retry (that is one-shot-only, which has no "next time"): the next occurrence
comes by definition, matching static cron semantics; the skipped one is audited `failed`. Kill switches: the agent's `unwake` tool (session-scoped — a conversation
can only cancel its OWN wake-ups) and the operator's `fastagent schedule cancel <id>` (unscoped; `schedule
list` shows ids).

## 10. Running and deployment (design)

The directory IS the agent: there is no build step and no artifact. `dev` and `start` both run the definition directory directly (§4 opener). An agent has no compile output — instructions and skills are markdown, code tools are imported directly in dev and start alike — so packaging was never a *runtime* prerequisite. Packaging for remote deployment (exclude dev cruft, mount state, pin the image) is never a build the author runs by hand to serve; it is what **`fastagent deploy fly|railway`** generates on demand (§10.5) — host artifacts + a runbook, not a step baked into `dev`/`start`.

### 10.1 What an agent is (the M/K seam)

An agent splits into two halves along the N×M×K seam:

| Half | Contents | In the definition directory? |
|---|---|---|
| **M — what the agent is** | the definition tree: `AGENTS.md` + `skills/` + authored context files (reference docs, schemas, data the agent reads on demand) + code tools + `fastagent.config.mjs` | **yes — it IS the directory** |
| **K — where/how it runs** | conversational context (sessions), execution env (fs/shell/sandbox), auth/secrets | **no** — host-provided at runtime; secrets stay outside the directory |

Two distinct things are called "context"; they live on opposite sides:

- **authored context** (static files the author wrote) is part of M and lives in the directory. The agent's `read`/`grep` tools consume it on demand — file access rooted at the run directory (cwd), not prompt-loading, so it needs no mechanism beyond "the file is in the run dir."
- **conversational context** (cross-turn history) is K, lives in an external session store, reconstructed per invoke (§7).

So `definition` is **not** just `AGENTS.md` — it is the whole directory. Skills come ONLY from `skills/` (§6, no external or global mount). Definition-local skills win name collisions; collisions surface as diagnostics, not swallowed.

**Path red line:** every path inside M resolves **relative to the agent root**. Authored context and skills MUST be root-relative — never absolute or `~` (machine-specific, breaks on deploy). Machine-specific paths belong to K and are injected by the host.

### 10.1a Authored-context discovery

Authored context is **not loaded** the way skills are; it is ambient files the agent reads on demand. Minimal model:

| Invariant | Meaning |
|---|---|
| **One root** | the run directory (tool `cwd`) = the directory holding `AGENTS.md` = the root of the definition tree. dev/start: that directory; container: wherever it is COPY'd (e.g. `/app`) |
| **Relative resolution** | `AGENTS.md` / skills reference authored files by root-relative paths; the `cwd`-rooted `read`/`grep`/`find` tools resolve them. The prompt's env segment reports `Current working directory`, so the model knows the root |
| **No prompt enumeration** | authored context is **not** listed in the system prompt (unlike the `<available_skills>` listing). It is discovered by explicit reference in `AGENTS.md` or by exploring (`ls`/`grep`/`find`). The filesystem is the registry |
| **Confinement is the env's job** | the tool layer is not the security boundary; in the single-machine/container tier the container is the boundary |

Consequence: skills need progressive disclosure (a prompt listing); authored context does not. This is why `start` reports skills but not authored files (§10.3).

### 10.2 cwd: one root, persistent and writable

The agent's working directory (tool `cwd`, where `read`/`bash`/`write` operate) = the definition directory = the directory holding `AGENTS.md`. With no separate artifact, cwd is a **real, persistent, writable** directory (your repo locally; the COPY'd project in a container) — never an ephemeral build output that a rebuild replaces. Two consequences:

- **No write-to-ephemeral footgun.** Tools write into a durable directory, not an ephemeral build output that a rebuild would wipe.
- **Self-modification is coherent.** An agent that edits its own `AGENTS.md`/`skills/` edits a real, git-versioned directory (revertable, reviewable) — a deliberate option, should it ever be wanted, not an accident of where cwd points.

Durable *runtime output* still belongs outside the directory (object storage / DB / the response), and in a stateless multi-instance deployment the working dir is per-replica scratch — but the *definition* it roots on is the persistent directory, not a throwaway.

### 10.3 `fastagent dev` / `fastagent start`

One opener (§4), two postures — both reuse **L2** (`createPiAgentFromDefinition`) via the single `createPiAgentFromWorkspace`, so what you iterate is what you serve (single assembly source, no drift):

| Aspect | dev | start |
|---|---|---|
| watch | restart the worker on edits | none (stable process) |
| model/http | `fastagent.config.mjs` (flag > env > config) | same — read directly, frozen by git, **no manifest** |
| skills | definition-only | definition-only (same) |
| sessions | `<state root>/sessions` | same default; `--sessions-dir` / `FASTAGENT_SESSIONS_DIR` override to a volume |
| posture | authoring (verbose) | production (stable, no watch) |

`start` depends on zero builder-machine state: it reads the directory + `fastagent.config.mjs`, resolves model/sessions, calls L2 — no manifest, no frozen copy.

**State** defaults under the definition's own `.fastagent/` (restart-surviving local continuity, faithful to local pi). A container may replace the definition directory wholesale on redeploy, so point `FASTAGENT_STATE_DIR` at a mounted volume to keep the whole machine-state home (sessions, auth, channel state) — `start` reminds the operator when running on the default. Sessions precedence: `--sessions-dir > FASTAGENT_SESSIONS_DIR > <state root>/sessions`; auth: `--auth-path > FASTAGENT_AUTH_PATH > <state root>/auth.json`.

**Startup report (minimal observable surface):** run dir, model, **auth source** (pi's resolved label + provider, e.g. `OAuth (anthropic)` or `ANTHROPIC_API_KEY (anthropic)`), `AGENTS.md` presence, the **loaded skills** (enumerable), the session dir, and the bound port. It does **not** enumerate authored context files: they are ambient (§10.1a), so the only meaningful, bounded list is skills.

**Authoring commands (same assembly, no serving).** `fastagent info` is a read-only inspect of that same surface (model/skills/tools+collisions/channels/diagnostics) without booting a server — it composes the no-side-effect loaders, so it never creates the sessions dir and an unset model is reported, not fatal. `fastagent invoke <message>` runs ONE turn through the same opener and exits (reply text→stdout, tool/diagnostics→stderr, a `failed` event→non-zero exit, so CI can gate on it). Both reuse the dev/start assembly, so they report and answer exactly as the served agent would — the all-agent counterpart of `fastagent tool` (one tool, no model).

### 10.4 Auth at runtime (env key or OAuth)

Auth rides the pi `Models` collection, not a side channel; `start` is **not** env-only. Since pi 0.80 a `Models` (built by `createPiModels` → `builtinModels`) owns both model resolution and per-request auth: each provider carries its own `ProviderAuth`, resolved against a `CredentialStore` (stored credentials) plus an `AuthContext` (ambient env vars). Two deploy-appropriate sources, both upstream-native:

| Source | Use | Refresh |
|---|---|---|
| env API key (pi default `AuthContext`) | simplest, stateless, metered API billing | none |
| OAuth from a credential store | run a deployed agent on a Claude Pro/Max or ChatGPT subscription | upstream-owned |

Resolution order is upstream-owned: a stored credential owns the provider; env is consulted only when nothing is stored. fastagent supplies `fastagentCredentialStore`, a **read-write** `CredentialStore` over its OWN credentials file (the file IS the store shape: `Record<providerId, Credential>` with `type:"oauth"`/`type:"api_key"`). The path is **project-level by default** — the directory opener passes `<dir>/.fastagent/auth.json`; `GLOBAL_AUTH_PATH` (`~/.fastagent/auth.json`) is the loginFlow default / explicit cross-project share target, resolved via `--auth-path` > `FASTAGENT_AUTH_PATH` > project default. Project-level default + **no implicit project↔global fallback** for two reasons: **isolation** (each agent can use a different account/subscription) and **fail-visibly** (a missing credential surfaces at startup instead of being masked by a machine-global one absent on a fresh deploy box). A *fallback* is refused specifically because its only safe shape (read global, write the rotated token to the project file) would diverge — single-use refresh tokens mean consuming global's token and persisting the new one elsewhere leaves global stale for other consumers. Sharing the right way is still safe: point `FASTAGENT_AUTH_PATH` at ONE file (the global path) — one file, one refresh lifecycle under the lock. The store stays **separate** from the pi CLI's `~/.pi/agent/auth.json` for that same single-lifecycle reason: two uncoordinated files over one grant would each rotate and break the other. `fastagent login` populates the resolved file; `modify` — the serialized read-modify-write `Models.getAuth()` runs OAuth refresh inside — **persists** the rotated token, reusing pi's `FileAuthStorageBackend` for the cross-process file lock.

OAuth refresh tokens are single-use, so refresh is serialized (the file lock) and the new credentials written back — the persistence above. **Single machine/container** is covered by that file lock. **Multi-instance** deployments need a shared credential store with row-locked refresh; that uses the same `CredentialStore` seam and is deferred with the K-axis backends.

### 10.5 Container recipe & `fastagent deploy fly|railway`

The container is the v1 "machine-state independence" boundary, and with no build step it is trivial:

```dockerfile
COPY . /app                          # the definition directory
RUN  npm ci                          # code-tool deps (skip for pure markdown/skills agents)
CMD  ["fastagent", "start", "/app"]  # cwd = /app
```

State goes to a mounted volume (`FASTAGENT_STATE_DIR=/data`) so a redeploy never wipes sessions, rotating OAuth credentials, or channel state (the Telegram turn/context files replay depends on); static secrets are injected as env; `PORT` is honored.

**Host-scoped `deploy <host>` — `fly` and `railway`.** The pre-flight (config/model/channels/container facts + their warnings) is host-neutral; the host branch adds its config file and runbook. The portable container (`Dockerfile` + `.dockerignore`) and the required-secret list live in neutral modules (`deploy/container.ts`, `deploy/secrets.ts`) shared by both targets — only the host config and the CLI sequence differ.

**`fastagent deploy fly`** generates this per host, tuned to the definition: `fly.toml` (`auto_stop_machines="suspend"` + `min_machines_running=0` + a `/data` volume mounted as `FASTAGENT_STATE_DIR`), `Dockerfile`, `.dockerignore`, then prints an ordered flyctl runbook — `fly apps/volumes/secrets/deploy` with the exact secret list computed from the model auth + discovered channels + `fastagent.config` `deploy.secrets` (extra env the agent's tools need, e.g. a `GH_TOKEN` — carried from the local env so a real repo doesn't hand-set host variables), plus the post-deploy webhook step only fastagent knows. The generated `Dockerfile` bakes in `deploy.apt` packages (git, ripgrep — so an agent that shells out doesn't need a hand-written image), falling back to a kept custom `Dockerfile` for a custom apt repo or base. By default it **prints a runbook rather than running flyctl** (host-scoped `deploy <host>`, `fly` for now); `--run` drives flyctl to completion. fastagent is cloud-neutral, so it owns the two ends it uniquely knows (definition-aware artifacts; secret list; webhook registration) and orchestrates the flyctl middle only behind an explicit `--run`. `--force` overwrites artifacts (else kept). Contrast a platform owner — Vercel's [Eve](https://vercel.com/eve) deploys into Vercel's own runtime (`eve deploy` runs it); a cloud-neutral tool ([Flue](https://flueframework.com), FastAgent) produces host artifacts and either hands the run off (runbook) or drives the third-party CLI (`--run`).

**The model must be in `fastagent.config.ts`.** That is the model's committed home (config's charter: model / tools / http) and the only source deploy ships — a `--model`/`FASTAGENT_MODEL`/`.env` value is builder-local and does not travel (`.env` is dockerignored), so deploy warns (runbook) or gates (`--run`) when the model isn't in config, since the box would otherwise crash-loop on "missing model". Single source on purpose (same discipline as the app name / region): fly.toml `[env]` is not advertised as a second home. Secrets (the API key, channel tokens) travel separately as Fly secrets, and an OAuth login as `FASTAGENT_AUTH_SEED`.

**`--run` — drive flyctl (idempotent, resumable).** Designed for a coding agent running ONE command: `fly auth whoami` (gate: not logged in → `fly auth login` or `FLY_API_TOKEN`) → `apps create` (skip if present) → `volumes create` (skip if present, region from fly.toml) → `secrets import --stage` (over stdin, not argv) → `deploy --remote-only --yes --ha=false` (remote builder — no local Docker; the volume already forces one machine) → telegram `setWebhook`. The webhook step first polls the deployed `/health` until the container is routable (Telegram VERIFIES the URL when you set it, and a fresh deploy — or a fresh tunnel's DNS — is not reachable the instant the command returns; tracking real readiness beats a fixed retry timer). Webhook wiring is best-effort: if `/health` never comes up (usually a symptom of a container that failed to start, not a webhook problem) it prints the exact manual `setWebhook` curl and the deploy still reports success — the runbook lists the webhook as a manual step regardless, so a registration miss degrades to that, it doesn't fail the deploy. Idempotent (check-then-act) and resumable — it STOPS at a human gate (missing auth, a missing secret value, a taken app name) with one actionable line and a non-zero exit, so the agent clears it and re-runs. flyctl lives behind a runner seam faked in tests: the agent's journey is the benchmark (asserted command sequence + gate behavior, validated without a real Fly account). **Carrying the credential:** an env-key model auth travels as its own Fly secret (value from the local env); an OAuth/stored login (no plaintext key) rides as `FASTAGENT_AUTH_SEED` (base64 auth.json), which `start` materializes onto the /data volume ON FIRST BOOT ONLY (absent-only — a refreshed volume copy is never clobbered), so a personal deploy runs on the SAME subscription. Single-use OAuth refresh means the box then owns that grant's refresh lifecycle: don't keep running the same login locally too (§10.4).

**`fastagent deploy railway`** is the second target, and deliberately NOT a copy of Fly — three asymmetries shape it. (1) *The config file is thin.* `railway.json` holds only build/deploy (`builder=DOCKERFILE`, `healthcheckPath=/health` — which also fixes Fly's "routed before the server is listening" boot race); the volume, variables (state root + secrets), and App Sleeping are Railway service settings the runbook applies via CLI/dashboard, so Railway's source of truth is the linked project's platform state, not a committed file — Fly's fly.toml-single-source does not carry. (2) *Scale-to-zero is not scriptable.* App Sleeping is a dashboard-only toggle (no CLI/API), so it is a stated manual step, not a generated setting — a real capability downgrade vs Fly's `auto_stop_machines`, named not hidden (and the github-no-replay floor becomes "do NOT enable App Sleeping"). (3) *The public URL is minted.* Railway mints a `*.up.railway.app` domain that must be read back (`railway domain`), so the webhook step points at "the domain from `railway domain`" rather than Fly's deterministic `<app>.fly.dev`. `--stop`/`--no-scale-to-zero` are Fly-only (warn on Railway).

**`railway --run`** drives the railway CLI to completion, mirroring `fly --run` (same credential carry via the neutral `assembleSecrets`, same runner seam faked in tests) but shaped by Railway's model (validated against CLI 5.15.0): auth needs an ACCOUNT credential (`railway login` / `RAILWAY_API_KEY`, not a project token — `init` predates any project); linkedness is read from `railway status --json` stdout (any non-empty output = linked, empty = not; the exit code is 0 either way).

The core rule is deliberately narrow: **`--run` PROVISIONS a project and only runs on an UNLINKED directory**, so it can never deploy into a project it didn't create — the near-miss that motivated this (a repo already linked to its production Railway project) is refused outright. A linked directory is REFUSED (the gate names the project so the operator sees what it is) UNLESS they pass `--into-linked` to provision INTO that project deliberately; a routine redeploy of an already-provisioned agent is just `railway up`. **No ownership is tracked.** Railway has no globally unique name to give free identity like Fly's app name; an earlier design synthesized one (a machine-local project-id marker) to auto-distinguish "ours" from "foreign" and to self-heal a half-finished create — that was a large, bug-prone premature optimization for an unproven need, and it was removed. The only "yes, this project" signal is now the operator's explicit `--into-linked`. (Cost, named like the other asymmetries: `railway --run` is not idempotent/resumable the way `fly --run` is — Fly's global app name makes check-then-act free; Railway's doesn't, so a routine redeploy is `railway up`, and a mid-first-deploy failure is recovered with `--into-linked` for the volume step and after — an `add`-step failure (project created, service not) needs a manual `railway add --service` then `--into-linked`, or a `railway unlink` restart.)

The rest is Railway-command detail: the volume is check-then-act (a `--into-linked` into an existing project may already have it; a create that failed at volume-add still gets it); every command passes `--service` to stay non-interactive except `volume add` (no such flag — it rides the linked service, so the service is created first); secrets go one-per-`railway variables set --stdin` (value on stdin, never argv — Railway has no bulk stdin import); and the public domain is minted/read (`railway domain`, never the destructive `domain list` subcommand) since a Railway service is unreachable until one exists.

**autostop = suspend** is a wake-latency optimization, not the correctness mechanism. When it applies, it freezes the in-flight event loop and resumes in ~hundreds of ms on the next webhook; but Fly uses suspend only "if possible" and **may fall back to `stop`** (a snapshot isn't durable, and a volume-mounted machine can be stopped rather than suspended) — a cold start of a few seconds. Either way the **correctness floor is replay — but only for Telegram**: a turn interrupted mid-run (by a discarded suspend snapshot OR a `stop`) is re-run on the next start from the Telegram L1 turn store (at-least-once), and state survives on the /data volume regardless. So suspend buys faster wakes; it is never what makes an interrupted turn safe. **GitHub turns are fire-and-forget with no replay** — an in-flight review dropped by scale-to-zero is lost (GitHub already got its 202), so `deploy fly` generates `min_machines_running=1` when a github channel is present (definition-aware: keep one machine up; the extra capacity still suspends) and prints a note. Edit it to `0` to accept the trade. Short turns (the Q&A sweet spot) complete well within Fly Proxy's periodic idle check, so mid-turn interruption is the rare case either way.

## 11. Current open work

- **The standalone × code-repo cell, *embedded-in-a-host-repo* form** (scenario grid). Serving a project it does **not** own (a Next/TS repo). **Landed:** (1) an authored persona (`persona.md` → segment ①, §2); (2) the **`agentDir` decoupling** — `config.agentDir` puts the agent's own surface (`persona.md`/`skills`/`tools`/`channels`) in a subdir while `cwd` stays the run root, so it never collides with the host's same-named dirs; (3) **② context follows pi** (`loadProjectContextFiles({ cwd, agentDir })`) — the host repo's `AGENTS.md` is picked up by the cwd-ancestor walk, `agentDir`'s own too. **Landed (4) — the repo-as-workspace deploy shape, decided as BAKE (EXPERIMENTAL)**: `deploy fly|railway` on an agentDir workspace generates a kit-namespaced recipe — `agent/Dockerfile` + `agent/fly.toml`|`agent/railway.json` (never colliding with the host repo's own deploy files) plus the ignore in two forms (a root `.dockerignore`, the only one host context-packers reliably read — kept if the host has its own — and `agent/Dockerfile.dockerignore` for plain docker builds) — baking the WHOLE repo as the agent's cwd and installing the KIT's deps only (the host's are the agent's runtime concern). Write-back MECHANICS are fastagent's (git in the image, creds via `deploy.secrets`), the policy is the persona's; but whether `.git` survives the host CLI's upload is **unverified** (`railway up` is known to strip it; flyctl packs its own context and ignores per-Dockerfile ignore files) — the runbook carries the verify-then-clone fallback, and the preflight note marks the layout experimental until a real-host smoke lands. Bake's named tradeoff: the workspace is a deploy-time snapshot; un-pushed changes are lost on redeploy — durability lives in git. **Still direction:** a real Fly/Railway end-to-end smoke (write the result back here), the `--run` drivers for this layout (gated at preflight), and whether the host's `tsc`/build should be helped to exclude `agentDir`. Deferred deviations this cell introduced: `loadProjectContextFiles` bypasses the `ExecutionEnv` port and an unreadable context file warns rather than fails (§6). The five other cells ship on the flat `definition = cwd` path.
- `fastagent dev` / `fastagent start` per §10 are implemented (single-machine tier, the directory is the agent). `fastagent deploy fly` (§10.5) generates the Fly artifacts + runbook and, with `--run`, drives flyctl to completion (idempotent, resumable, credential-carrying). `fastagent deploy railway` is the second host — generate + runbook and, with `--run`, drives the railway CLI to completion (sharing the neutral container/secret modules; the sequence differs per Railway's model). Further hosts extend the same `deploy <host>` seam.
- Multi-instance (multiple Fly machines sharing state) needs a K-axis backend — the single-machine + single-volume tier is the documented scope; `deploy fly` warns to keep one machine.
- Multi-instance credential broker for OAuth refresh (§10.4); single-machine/container credential refresh is covered by the file-backed store.
- Target adapters with external sessions and distributed locking (the async `Lease` port).
- Production observability sink for cleanup anomalies (§3) without violating SPEC terminal discipline.
- Engine #2, which will prove which pi-specific seams (e.g. `PiSessionStore`) should become engine-neutral abstractions.
- Crash-safe reopen (§7) is reconciled in fastagent's session store today; the more fundamental fix is upstream in pi's `buildSessionContext` (the single context-rebuild point). If accepted there, the fastagent-layer reconciliation retires.
