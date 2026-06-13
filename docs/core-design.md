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

## 10. Current open work

- `fastagent build`: create deterministic artifact-only bundles.
- `fastagent start`: run artifact-only production posture.
- AgentCore target adapter with external sessions and distributed locking.
- Production observability/logging for cleanup anomalies without violating SPEC terminal discipline.
- Engine #2, which will prove which pi-specific seams should become engine-neutral abstractions.
