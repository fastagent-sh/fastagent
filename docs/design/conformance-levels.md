---
title: Conformance levels
description: "Where a session's state lives is a deployment choice the SPEC already defines — not an implementation detail. Two axes (state locality × engine class), the postures that pin them, and what each owes."
status: current
---

# Conformance levels

## 1. Decision

**Where a session's state lives is an explicit deployment choice, and the engine class that serves it
is a separate one.** Neither is a property of "fastagent"; both are properties of a deployment.

The protocol says so already. [SPEC](../SPEC.md) §6, under *Portable conformance (optional; required
for Agents claiming serverless portability)*:

> **No location dependence**: the Agent MUST NOT require multiple invocations with the same `session`
> to land in the same process or instance. Session state must be reconstructible from external state.
> **A resident stateful Agent can still conform to Agent Handler, but it does not satisfy portable
> conformance.**

A resident Agent is permitted, the cost is named, and the level is optional. `test/spec-conformance.ts`
encodes the same shape: `pair?()` is an OPTIONAL subject capability, because MUST 6 is optional.

The recurring question — "should `invoke` be built on pi's `AgentSession` instead of its
`AgentHarness`?" — used to be malformed, because it conflated the level with the engine. It has since
been answered by the engine itself: §2.

## 2. One axis now

| Axis | Values | What it decides |
|---|---|---|
| **State locality** | `per-invoke` \| `resident` | SPEC MUST 6. Whether a turn may require the previous turn's process. |

There used to be a second axis — which pi class ran the turn, `AgentHarness` (pi-agent-core) or
`AgentSession` (pi-coding-agent) — and the interesting cell was `per-invoke × session`: portable AND
extension-hosting. That cell is now the only one, for a reason outside this repo: pi 0.84 replaced
`AgentHarness` with an unimplemented lane-based skeleton, and pi does not consume that class itself
(its TUI, RPC and SDK all run on `AgentSession`). Being the sole consumer of a surface nobody
dogfoods is a position, not an architecture, so the serving path moved.

What made the move affordable, measured on the way through:

- **The expensive half is shareable.** Services (the `ResourceLoader`, settings, model runtime) build
  once at ~23 ms; binding a session to a record costs ~0.6 ms per turn.
- **Freshness survives sharing.** pi's loader caches the prompt and skill overrides, so "the
  directory is the agent, LIVE" needs a reload — but only when the definition actually changed:
  0.08 ms per turn unchanged, ~5.5 ms on the turn after an edit.
- **The engine's TUI origins need adapting, not fighting.** pi buffers a new session until its first
  assistant message (so the store publishes the record on create), rejects every session id a channel
  mints (so ids are encoded), and reads its own machine-global settings unless pointed elsewhere (so
  serving points it at a definition-scoped path). Each is named where it is applied.

## 3. Posture pins the level

The mapping is derived from deployment facts, not preference:

| Posture | State locality | Why |
|---|---|---|
| channels, schedules | `per-invoke` | Many concurrent "places" (a room, a thread) and horizontal scaling. Residency would make the live-session set an unbounded resource with an eviction policy attached. |
| AgentCore | `per-invoke` | The platform has no resident process — compute exists per invocation ([core.md](core.md) §9). MUST 6 is not a preference here, it is the runtime. |
| `chat`, a desktop client | either | One user, one workspace, one live conversation. Location dependence costs nothing, and residency buys the engine's own continuity (queues, in-flight state) for free. |

A deployment that claims serverless portability MUST be `per-invoke`. Everything else is a choice with
a stated bill (§5).

## 4. What does not change

The seam is **L0 only** ([core.md](core.md) §3: `createPiAgentFromSession` is the L0 rung).

- **`Agent`** — `invoke(scope, prompt) => AsyncIterable<AgentEvent>`. The SPEC calls the Agent "a
  black box to the Caller", and the engine swap was invisible through it: the conformance suite ran
  unchanged against both classes.
- **`SessionControl`** — engine-neutral, and designed when only one implementation existed. Every
  method maps onto `AgentSession` natively, most of them more directly than onto the harness
  (`dispatch`'s verbs are `steer`/`followUp`/`abort`/`compact`/`setModel`/`setThinkingLevel`/
  `navigateTree`). The migration confirmed it: nothing in the contract bent, and `compact` lost the
  hand-assembled summarization pipeline the harness needed.
- **The assembly ladder, the definition, tools, channels, schedules** — level-agnostic. They produce
  inputs; the level decides who consumes them.

## 5. What each level owes

**`per-invoke` owes MUST 6**: state reconstructible from the store, no process affinity. Nothing more —
in particular, "the directory is the agent, LIVE" is a fastagent product property, not part of this
level. Sharing a `ResourceLoader` across turns is what makes the per-turn cost ~0.6 ms, and it caches
the definition; the factory pays a reload (~5.5 ms) on the turn after an edit and nothing on the rest,
by asking the loader what it is serving rather than trusting a copy of what it last wrote.

**`resident` owes an explicit lifecycle**: when a session is created, evicted, and rebuilt, plus a
rebind path when the definition changes (an `AgentSession` snapshots its assembly at build). It also
owes honesty in `capabilities()`: a resident deployment is not portable, and a client that migrates
between the two must not discover this from behavior.

**Both owe the same durable record.** `SessionManager` buffers a NEW session's entries until its first
assistant message, so a crash between "the user asked" and "the model answered" would lose the
question — and, worse, open-or-create would stop being idempotent, forking one conversation into two
half-records. `piSessionRecordStore` closes it by publishing pi's own header on create and reopening,
which puts the manager on its normal file-exists path.

The engineering bill for `resident`, measured: ~25 KB per idle `AgentSession`, and the real cost is
transcript retention at roughly the size of the record on disk (~8.6 KB per turn of ~8 KB text) — about
0.8 GB for 1000 sessions of 100 turns. Nothing for a desktop; an eviction policy for a channel host.

## 6. Consequences for the roadmap

The engine surface is no longer a choice, which retires a whole class of requests along with it.
Extensions, slash-command dispatch, branch summaries and fork/clone are `AgentSession` features, and
the serving path is now on `AgentSession` — so they are reachable rather than blocked. What still
gates them is wiring, not class:

- **Extension loading** is suppressed on purpose (`noExtensions: true` in the binding): a served agent
  is its definition, not the operator's `~/.pi` setup. Turning it on means deciding where a served
  agent's extensions come from — the definition directory, presumably — and what an extension dialog
  (`ExtensionUIContext`'s `select`/`confirm`/`input`/`notify`) means with no human at a terminal. pi
  exposes an injectable `bindExtensions({ uiContext, mode })` seam for exactly that, the same door its
  RPC mode uses.
- **`commands()` stays a listing**, not a dispatch surface: the data plane takes prompts as text, so
  what typing `/name` means belongs to the client. That was a `harness`-era constraint that has become
  a deliberate contract line.

What has NOT changed is the level: `per-invoke` remains the serving posture, and residency remains a
deployment choice with the bill in §5. The engine swap moved which class runs a turn, not where the
state lives.
