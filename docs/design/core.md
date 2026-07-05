---
title: fastagent — Core design
type: design-doc
status: current
updated: 2026-07-03
---

# fastagent core design

This document describes the current pi-based reference implementation of the [Agent Handler SPEC](../SPEC.md). The code source of truth is `src/`.

Technical analogy: FastAgent plays the WSGI-like layer for agent serving — a small internal handler contract plus a reference implementation and deployment tooling around existing agent definitions.

## 1. Layering: N × M × K

FastAgent aims to collapse **N triggers × M agents × K hosts** into additive seams. Those seams live at different layers:

| Axis | What decouples it | Layer |
|---|---|---|
| N × M: trigger ↔ agent | Agent Handler `invoke(scope, prompt) => AsyncIterable<AgentEvent>` | SPEC / core contract |
| M: engine diversity | the Agent is a black box; definitions/config are assembled into an Agent | core dependency inversion |
| K: host diversity | stateless `invoke`, injected `ExecutionEnv`, sessions, and leases | core provides hooks; target adapters do host work |

The SPEC directly owns N × M. K portability is enabled by core invariants, but each host still needs real target-adapter work.

## 2. Agent definitions and prompt assembly

FastAgent consumes existing definition artifacts:

```txt
workspace/
├── AGENTS.md
├── skills/
├── fastagent.config.mjs
└── .fastagent/          # generated machine state, ignored by git
```

`AGENTS.md` is not the full system prompt. The pi reference implementation assembles the final prompt from four segments:

| Segment | Source | Owner |
|---|---|---|
| base prompt | pi engine binding (`piBasePrompt`) | engine asset |
| project instructions | `AGENTS.md`, wrapped in `<project_instructions>` | agent definition |
| skills listing | loaded skills, formatted for progressive disclosure | agent definition |
| environment context | date and cwd | runtime assembly |

`assembleSystemPrompt` is pure: callers provide date/cwd. L2 uses a factory so long-running processes re-evaluate time-sensitive context per invocation.

This four-segment assembly is the **folder path** (L2/opener): it wraps `AGENTS.md` and prepends the engine base for fidelity with how the author vibed in local pi. **L1 `createPiAgent` is different on purpose**: its `instructions` ARE the system prompt (verbatim, no engine base, no wrapping) — the skills listing is the only thing appended, and only when skills are mounted. So `AGENTS.md ≡ instructions` in *role* (author-written instructions), but the folder path additionally bases/wraps them; a hand-built agent is not forced into the coding persona.

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

Skills are markdown/file assets. Loading is **definition-only, period**: an agent is exactly its folder (`AGENTS.md` + `skills/`). This is the structural form of "your folder is the agent" — the same definition loads the same skills on every machine, and dev behavior equals deployed behavior, with **no exceptions**. There is no global-skill mount and no `skillPaths` escape hatch: skills come ONLY from the definition's own `skills/`.

The `skills/` format is **Agent Skills** ([agentskills.io](https://agentskills.io)) compatible — a `skills/<name>/SKILL.md` with `name`/`description` frontmatter and progressive disclosure (name+description at startup, the body on activation), as implemented by pi's `loadSkills`. Any standard skill (e.g. from [anthropics/skills](https://github.com/anthropics/skills)) works by **vendoring**: copy the folder into `skills/`, git-tracked, and it Just Works — unsupported optional fields (`license`, `metadata`, `compatibility`) are ignored without error. **There is no registry, and none is needed**: the filesystem is the registry, git is the distribution, and the user owns trust (a vendored skill's `scripts/` is code they audit, like an npm dependency). fastagent is the serving layer, not a skill marketplace.

Loading the machine's global skills (`~/.pi/agent/skills`, `~/.agents/skills`) was removed deliberately. It made the agent depend on ambient machine state and recreated the "works on my machine, breaks deployed" trap fastagent exists to kill. The principle is general: **the definition directory is the agent's only source of truth; nothing the code can't see is loaded into its behavior** (credentials and env are deployment config, not behavior — they stay outside the directory by design). To ship a skill, put it in `skills/`.

Definition-local skills win name collisions (the deployable unit is authoritative); collisions are surfaced as diagnostics, not swallowed.

Code tools are TypeScript/JavaScript modules. The vibe path is `defineTool` + filesystem discovery: drop a file in `tools/`, default-export `defineTool({ description, input, execute })`, and it is auto-discovered, named from the filename (authoritative), schema-validated, and injected — no `name` field, no manual registration. `defineTool` takes a Zod `input` schema (re-exported as `z` from the package), converts it to JSON Schema for the model, validates the model's arguments before `execute` (a validation failure becomes an error result the model can correct, not a crash), and wraps a plain return value into pi's result shape.

> Reversal: an earlier draft said "FastAgent does not auto-load a magic `tools/` directory." That rationale conflated dependency installation with registration — they are orthogonal. Filesystem discovery is the bigger DX win because it removes both the `name` field and the wiring. So fastagent now auto-discovers `tools/`.

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

## 9. Channels

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
webhook delivery. Its folder (`src/channels/telegram/`) is the future package boundary; each
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

- **Channel-state convention:** engine state lives at the `.fastagent` top level (auth, sessions);
  channel state lives under `.fastagent/channels/<kind>/` (buffers, downloaded files),
  mirroring `src/channels/<kind>/`. The home self-ignores (nested `.gitignore`) — it can carry chat
  content. Single-process semantics.
- **Turn durability is layered: L1 in the channel (`turn-store.ts`), L2 at the K-axis backend.**
  While the process is DOWN, Telegram retries undelivered (never-ACKed) webhooks, so those are covered
  for free. The remaining window is the ACKed-but-unfinished turn (200 already returned) — Telegram's
  *no-redelivery* case. L1 recovers it: `turn-store.ts` persists an accepted turn's intent pre-ACK
  (like the context buffer) and, on the next start, replays anything an interrupted run left mid-flight.
  "Interrupted" is not just a rare crash: `runStart` has no graceful drain, so a SIGTERM — every rolling
  deploy — exits mid-turn too. This is a per-process WAL by another name, and a deliberate reversal of
  the earlier "accept the loss" stance — the atomic-rename primitive (`state.ts`) already in the channel
  makes it cheap enough to be worth the ACKed-but-unfinished window that a single re-ask otherwise
  costs. It is **at-least-once, not exactly-once**: replay re-runs the whole turn (re-running
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

## 10. Running and deployment (design)

The directory IS the agent: there is no build step and no artifact. `dev` and `start` both run the definition directory directly (§4 opener). An agent has no compile output — instructions and skills are markdown, code tools are imported directly in dev and start alike — so packaging was never a *runtime* prerequisite. Packaging for remote deployment (exclude dev cruft, pin a model, push) returns later as an internal step of a future **`deploy`** command, not a build the author must run by hand.

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

- **No write-to-ephemeral footgun.** Tools write into a durable directory, not one the next build wipes (the old build/artifact made cwd the throwaway `.fastagent/build`).
- **Self-modification is coherent.** An agent that edits its own `AGENTS.md`/`skills/` edits a real, git-versioned directory (revertable, reviewable) — a deliberate option, should it ever be wanted, not an accident of where cwd points.

Durable *runtime output* still belongs outside the directory (object storage / DB / the response), and in a stateless multi-instance deployment the working dir is per-replica scratch — but the *definition* it roots on is the persistent directory, not a throwaway.

### 10.3 `fastagent dev` / `fastagent start`

One opener (§4), two postures — both reuse **L2** (`createPiAgentFromDefinition`) via the single `createPiAgentFromWorkspace`, so what you iterate is what you serve (single assembly source, no drift):

| Aspect | dev | start |
|---|---|---|
| watch | restart the worker on edits | none (stable process) |
| model/http | `fastagent.config.mjs` (flag > env > config) | same — read directly, frozen by git, **no manifest** |
| skills | definition-only | definition-only (same) |
| sessions | `<dir>/.fastagent/sessions` | same default; `--sessions-dir` / `FASTAGENT_SESSIONS_DIR` override to a volume |
| posture | authoring (verbose) | production (stable, no watch) |

`start` depends on zero builder-machine state: it reads the directory + `fastagent.config.mjs`, resolves model/sessions, calls L2 — no manifest, no frozen copy.

**Sessions** default under the definition's own `.fastagent/sessions` (restart-surviving local continuity, faithful to local pi). A container may replace the definition directory wholesale on redeploy, so point `FASTAGENT_SESSIONS_DIR` at a mounted volume to keep conversations — `start` reminds the operator when running on the default. Precedence `--sessions-dir > FASTAGENT_SESSIONS_DIR > <dir>/.fastagent/sessions`.

**Startup report (minimal observable surface):** run dir, model, **auth source** (pi's resolved label + provider, e.g. `OAuth (anthropic)` or `ANTHROPIC_API_KEY (anthropic)`), `AGENTS.md` presence, the **loaded skills** (enumerable), the session dir, and the bound port. It does **not** enumerate authored context files: they are ambient (§10.1a), so the only meaningful, bounded list is skills.

**Authoring commands (same assembly, no serving).** `fastagent info` is a read-only inspect of that same surface (model/skills/tools+collisions/channels/diagnostics) without booting a server — it composes the no-side-effect loaders, so it never creates the sessions dir and an unset model is reported, not fatal. `fastagent invoke <message>` runs ONE turn through the same opener and exits (reply text→stdout, tool/diagnostics→stderr, a `failed` event→non-zero exit, so CI can gate on it). Both reuse the dev/start assembly, so they report and answer exactly as the served agent would — the all-agent counterpart of `fastagent tool` (one tool, no model).

### 10.4 Auth at runtime (env key or OAuth)

Auth rides the pi `Models` collection, not a side channel; `start` is **not** env-only. Since pi 0.80 a `Models` (built by `createPiModels` → `builtinModels`) owns both model resolution and per-request auth: each provider carries its own `ProviderAuth`, resolved against a `CredentialStore` (stored credentials) plus an `AuthContext` (ambient env vars). Two deploy-appropriate sources, both upstream-native:

| Source | Use | Refresh |
|---|---|---|
| env API key (pi default `AuthContext`) | simplest, stateless, metered API billing | none |
| OAuth from a credential store | run a deployed agent on a Claude Pro/Max or ChatGPT subscription | upstream-owned |

Resolution order is upstream-owned: a stored credential owns the provider; env is consulted only when nothing is stored. fastagent supplies `fastagentCredentialStore`, a **read-write** `CredentialStore` over its OWN credentials file (the file IS the store shape: `Record<providerId, Credential>` with `type:"oauth"`/`type:"api_key"`). The path is **project-level by default** — the folder opener passes `<dir>/.fastagent/auth.json`; `GLOBAL_AUTH_PATH` (`~/.fastagent/auth.json`) is the loginFlow default / explicit cross-project share target, resolved via `--auth-path` > `FASTAGENT_AUTH_PATH` > project default. Project-level default + **no implicit project↔global fallback** for two reasons: **isolation** (each agent can use a different account/subscription) and **fail-visibly** (a missing credential surfaces at startup instead of being masked by a machine-global one absent on a fresh deploy box). A *fallback* is refused specifically because its only safe shape (read global, write the rotated token to the project file) would diverge — single-use refresh tokens mean consuming global's token and persisting the new one elsewhere leaves global stale for other consumers. Sharing the right way is still safe: point `FASTAGENT_AUTH_PATH` at ONE file (the global path) — one file, one refresh lifecycle under the lock. The store stays **separate** from the pi CLI's `~/.pi/agent/auth.json` for that same single-lifecycle reason: two uncoordinated files over one grant would each rotate and break the other. `fastagent login` populates the resolved file; `modify` — the serialized read-modify-write `Models.getAuth()` runs OAuth refresh inside — **persists** the rotated token, reusing pi's `FileAuthStorageBackend` for the cross-process file lock.

OAuth refresh tokens are single-use, so refresh is serialized (the file lock) and the new credentials written back — the persistence above. **Single machine/container** is covered by that file lock. **Multi-instance** deployments need a shared credential store with row-locked refresh; that uses the same `CredentialStore` seam and is deferred with the K-axis backends.

### 10.5 Container recipe (v1, documented not generated)

The container is the v1 "machine-state independence" boundary, and with no build step it is trivial:

```dockerfile
COPY . /app                          # the definition directory
RUN  npm ci                          # code-tool deps (skip for pure markdown/skills agents)
CMD  ["fastagent", "start", "/app"]  # cwd = /app
```

Sessions go to a mounted volume (`FASTAGENT_SESSIONS_DIR=/data/sessions`) so a redeploy never wipes them; secrets and (optionally) OAuth credentials are injected as env/mounted files; `PORT` is honored. Excluding dev cruft from the image is `.dockerignore`'s job until the future `deploy` command owns packaging. The recipe is documented here rather than generated or shipped as a Dockerfile.

## 11. Current open work

- `fastagent dev` / `fastagent start` per §10 are implemented (single-machine tier, the directory is the agent); the documented container recipe (§10.5) is not yet shipped as a generated Dockerfile.
- `fastagent deploy`: packaging (exclude dev cruft, pin a model, push to a target runtime) returns here as an internal step, not a user-facing build. Future milestone.
- Multi-instance credential broker for OAuth refresh (§10.4); single-machine/container credential refresh is covered by the file-backed store.
- Target adapters with external sessions and distributed locking (the async `Lease` port).
- Production observability sink for cleanup anomalies (§3) without violating SPEC terminal discipline.
- Engine #2, which will prove which pi-specific seams (e.g. `PiSessionStore`) should become engine-neutral abstractions.
- Crash-safe reopen (§7) is reconciled in fastagent's session store today; the more fundamental fix is upstream in pi's `buildSessionContext` (the single context-rebuild point). If accepted there, the fastagent-layer reconciliation retires.
