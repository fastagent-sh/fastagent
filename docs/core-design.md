---
title: fastagent — Core design
type: design-doc
status: design
updated: 2026-06-11
---

# fastagent core design

This document describes the current pi-based reference implementation of the [Agent Handler SPEC](SPEC.md). The code source of truth is `core/`.

FastAgent is WSGI for agent serving: a small internal handler contract plus a reference implementation and deployment tooling around existing agent definitions.

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
├── fastagent.config.ts
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

The pi implementation exposes four entry points. Each upper rung delegates downward.

| Rung | Function | Meaning |
|---|---|---|
| L3 `[OPEN]` | `createPiAgentFromWorkspace(dir, { model? })` | load workspace config + definition; used by CLI |
| L2 `[LOAD]` | `createPiAgentFromDefinition(dir, options)` | load `AGENTS.md` + skills, assemble prompt, then L1 |
| L1 `[ASSEMBLE]` | `createPiAgent(options)` | assemble from typed parts: model, prompt, tools, sessions, env, auth |
| L0 `[ADAPT]` | `createPiAgentFromHarness({ harnessFactory })` | adapt pi harness wiring into the Agent Handler stream |

Naming rule: `From<source>` means inputs are derived from that source. No suffix (`createPiAgent`) means typed parts are supplied directly.

L0 lives in `invoke.ts` because its body is the request-time turn mechanism; L1–L3 live in `create.ts` because they are configuration-time assembly.

## 5. Config v1

`fastagent.config.ts` currently has three keys:

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

Skills are markdown/file assets. Loading is **definition-only by default**: an agent is exactly its folder (`AGENTS.md` + `skills/`). This is the structural form of "your folder is the agent" — the same definition loads the same skills on every machine, and dev behavior equals deployed behavior. Definition-local skills win name collisions (the deployable unit is authoritative); collisions are surfaced as diagnostics, not swallowed.

The machine's global skills (`~/.pi/agent/skills`, `~/.agents/skills`, via `defaultGlobalSkillPaths()`) are an **explicit opt-in**, never a silent default. Defaulting to them would make the agent depend on ambient machine state, break reproducibility, and recreate the "works on my machine, breaks deployed" trap fastagent exists to kill.

### Skills lifecycle across dev / build / start (spec)

| Stage | Default | Opt-in to globals |
|---|---|---|
| `createPiAgentFromDefinition` (L2) | definition-only | caller passes `skillPaths` |
| `fastagent dev` | definition-only (dev == deployed) | `--global-skills` (ephemeral: loads globals for local-authoring fidelity this run only; does not change the artifact) |
| `fastagent build` | definition-only | `--global-skills` materializes the winning globals into the artifact's `skills/` (the deliberate "I want these to ship" action) |
| `fastagent start` | always definition-only | n/a — the artifact is already self-contained |

`fastagent dev` must not silently drop globals: when run definition-only, it reports which global skills exist but were not loaded, plus the one-liners to use them (`--global-skills`) or ship them (copy into `skills/` / `build --global-skills`). The "what is actually in my agent?" question is thus answered at dev time (cheap), not at deploy time (expensive).

**Red line:** the only way a global skill reaches production is being materialized into the artifact (`build --global-skills` or copied into `skills/`). `fastagent.config.ts` must never carry a machine path like `~/.agents/skills/foo` as a deploy mechanism — that path does not exist on a teammate's machine, CI, or the server, reintroducing the machine-state dependency. Config describes deployment choices, not "go fetch files from a directory on the build machine."

`bundleAgentDefinition` is the build-time step that materializes the resolved skill set into a self-contained artifact. Dropped skills are removed on rebuild so the artifact is the truth.

Code tools are different: they are TypeScript/JavaScript modules with dependencies. FastAgent does not auto-load a magic `tools/` directory. Projects explicitly import and inject code tools through config or library APIs. Declarative MCP tool mounting via `.mcp.json` is future support, not implemented today.

## 7. Sessions and statelessness

Each `invoke` creates a fresh harness bound to the requested session and discards it after the turn. Conversation continuity comes from reopening the session from a `PiSessionStore` (pi-coupled: it returns pi's `Session`):

- L1 default: `inMemorySessionStore()` for embedding/tests.
- L3 default: `jsonlSessionStore()` under `.fastagent/sessions` for restart-surviving local dev.

This gives the reference implementation portable conformance in miniature: two separate instances sharing the same external store can continue the same session.

Full fork/navigation session-admin is a separate draft: see [session](session.md).

## 8. Same-session concurrency

Core provides only a corruption-prevention floor: one in-flight turn per session.

If a second invocation arrives for the same session while one is already running, it immediately yields:

```ts
{ type: "failed", retryable: true, details: "session busy: ..." }
```

Core does not queue. Dedupe, retry, user-visible “busy” messages, and steering are channel-level decisions because only the channel understands the trigger semantics.

## 9. HTTP channel

`createInvokeHandler(agent)` implements the minimal dev HTTP channel:

- `POST /invoke { session, text }`,
- SSE output with one `data:` line per `AgentEvent`,
- request body cap by real bytes,
- client disconnect calls `iterator.return()` to trigger invoke cleanup.

The HTTP channel consumes only the neutral `Agent` contract.

## 10. Deployment: build / start (design)

This section is the agreed design for `fastagent build` / `fastagent start`. The first implementation targets a single machine or container; AWS AgentCore is deferred.

### 10.1 What an agent is (the deployable unit)

An agent splits into two halves along the N×M×K seam:

| Half | Contents | Bundled into the artifact? |
|---|---|---|
| **M — what the agent is** | the authored **source tree**: `AGENTS.md` + `skills/` (markdown + bundled `scripts/`/`references/`/`assets/`) + **authored context files** (reference docs, schemas, data samples, sub-instruction files the agent reads on demand) + code tools + `fastagent.config.ts` + `.mcp.json` | **yes** |
| **K — where/how it runs** | conversational context (sessions), execution environment (fs/shell/sandbox), auth/secrets | **no** — host-provided at runtime; **secrets are never bundled** |

Two distinct things are both called "context"; they live on opposite sides:

- **authored context** (static files the author wrote) is part of M and ships. It is consumed by the agent's `read`/`grep` tools on demand — it is file access rooted at the run directory (cwd), **not** prompt-loading, so it needs no new mechanism beyond "the file is present in the run dir."
- **conversational context** (cross-turn history/memory) is K, lives in an external session store, and is reconstructed per invoke (§7).

So `definition` is **not** just `AGENTS.md` — it is the authored source tree. Its default boundary is the source tree **minus**:

| Never bundled | Why |
|---|---|
| secrets (`.env`, `.env.*`) | red line — secrets are injected at runtime, out-of-band (packaging-standard consensus) |
| dependencies (`node_modules`) | provided by the runtime (container `npm ci` / deploy-time install) |
| machine state / generated (`.fastagent/`, build output) | rebuildable, not authored |
| VCS (`.git`) | irrelevant to the running agent |

The boundary is gitignore-style ignore rules **plus** an unconditional secret/dep exclusion (same model as Docker build context, `npm publish`, Vercel).

### 10.2 Two packaging tiers

The real axis is **bundled vs runtime-provided**, not "data vs code." Code (skill `scripts/`, code tools) is part of the agent and ships; the open question is only whether its *npm dependencies* travel with it.

| Tier | Carries | npm-dependent code tools | Status |
|---|---|---|---|
| **Container (project + `node_modules`)** | the whole project, baked into an image | works (deps in the image) | **v1 target** |
| **Portable data bundle** (source tree, no `node_modules`) | md + skills (+scripts) + authored context + MCP declarations + manifest | needs deps bundled/self-contained | deferred (AgentCore) |

In the container tier, authored context and code tools ship automatically because the whole source tree is in the image — so v1 does **not** need to solve the portable-bundle scoping problem. The portable tier must solve source-tree bundling under the §10.1 boundary (secret exclusion is the hardest part); that lands with AgentCore.

### 10.3 `fastagent build`

Compile a workspace into a self-contained, inspectable deployable. It is build-time (`node:fs` is fine here):

1. Load + validate config and definition; resolve the model (fail visibly on a broken workspace).
2. Materialize skills via `bundleAgentDefinition` (definition-local + opted-in globals with `--global-skills`; §6 skills lifecycle).
3. Freeze resolved config into a `fastagent.json` manifest (data only): `{ fastagentVersion, engine, builtAt, model, http }`. The skill list is **not** duplicated — the `skills/` directory is the single source of truth.
4. Deterministic rebuild: only owned outputs are cleaned (`AGENTS.md`, `skills/`, `fastagent.json`); never the whole out dir.

`--global-skills` materializes the machine's global skills into the artifact's `skills/` (the deliberate "these ship" action). Default out dir: `.fastagent/build`; `--out` overrides.

### 10.4 `fastagent start`

Run a built agent in **production posture**. Differences from `dev`:

| Aspect | dev | start |
|---|---|---|
| config | executes `fastagent.config.ts` | reads `fastagent.json` (manifest) — **no `.ts` execution at runtime** |
| skills | definition-only (+ `--global-skills`) | artifact is the truth; **never scans globals** |
| auth | pi OAuth → env | pluggable `AuthResolver` (§10.5) |
| sessions | jsonl under `.fastagent/sessions` | persistent store (jsonl now; external/DDB later) |
| model | `--model > FASTAGENT_MODEL > config` | `--model > FASTAGENT_MODEL > manifest.model` |
| port | `--port > config` | `--port > PORT env > manifest.http.port > 8787` |

`start` reuses **L2** (`createPiAgentFromDefinition`) with production wiring injected — no new ladder rung — which is exactly what L2's injection points exist for. It depends on zero builder-machine state.

### 10.5 Auth at runtime (env key or OAuth)

Auth is a pluggable `AuthResolver`; `start` is **not** env-only. Two deploy-appropriate sources:

| Source | Use | Refresh |
|---|---|---|
| env API key (`envAuth`) | simplest, stateless, metered API billing | none |
| OAuth from a credential store | run a deployed agent on a Claude Pro/Max or ChatGPT subscription | required |

Feasibility is confirmed in pi: `pi-ai`'s `getOAuthApiKey()` auto-refreshes and returns updated credentials, and `pi-coding-agent`'s `AuthStorage` does file-locked auto-refresh-and-persist. The current `piOAuthAuth` reads `~/.pi/agent/auth.json` and does **not** refresh — a refresh-capable resolver is needed for runtime OAuth.

Constraint: OAuth refresh tokens are single-use, so refresh must be serialized and the new credentials persisted back to the store. **Single machine/container**: a file-backed `AuthStorage` (its file lock) is sufficient — in scope for v1. **Multi-instance**: a credential broker with row-locked refresh over a shared store (the ketchup `worker_credentials` pattern) — same `AuthResolver` seam, deferred with the K-axis backends.

### 10.6 Container recipe (v1, documented not generated)

The container is the v1 "machine-state independence" boundary: copy the project, `npm ci`, `fastagent build`, then `CMD fastagent start`. Secrets and (optionally) OAuth credentials are injected as env/mounted files; `PORT` is honored. A Dockerfile sample ships with the implementation.

## 11. Current open work

- `fastagent build` / `fastagent start` per §10 (container tier first).
- Refresh-capable runtime OAuth resolver (§10.5); multi-instance credential broker deferred.
- Portable data-bundle scoping (§10.2): bundle the source tree under the §10.1 boundary, secret exclusion enforced — lands with the AgentCore target adapter.
- AgentCore target adapter with external sessions and distributed locking (the async `Lease` port).
- Production observability sink for cleanup anomalies (§3) without violating SPEC terminal discipline.
- Engine #2, which will prove which pi-specific seams (e.g. `PiSessionStore`) should become engine-neutral abstractions.
