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

So the recurring question — "should `invoke` be built on pi's `AgentSession` instead of its
`AgentHarness`?" — is malformed. It conflates two independent axes.

## 2. Two axes, not one

| Axis | Values | What it decides |
|---|---|---|
| **State locality** | `per-invoke` \| `resident` | SPEC MUST 6. Whether a turn may require the previous turn's process. |
| **Engine class** | `harness` (pi-agent-core) \| `session` (pi-coding-agent `AgentSession`) | Which engine surface exists: extensions, slash-command dispatch, branch summaries, fork/clone. |

The axes are independent, and the combination that looked impossible is the interesting one:

| | `harness` | `session` |
|---|---|---|
| **per-invoke** | today's serving path | **portable AND extension-hosting** — measured: shared assembly once (~3 ms), then ~1 ms to build a fresh `AgentSession` over the same session file per turn; extension hooks fire every turn; one jsonl accumulates across turns |
| **resident** | pointless (residency buys nothing without the surface) | today's `chat`; a desktop client's natural posture |

Two facts make the top-right cell real rather than theoretical:

- **One durable record.** pi-agent-core's `JsonlSessionStorage` and pi-coding-agent's `SessionManager`
  read and write the same versioned jsonl (`{"type":"session","version":3,…}` + entries). A record
  written by one is read by the other, leaf and parent chain intact, with no migration.
- **The expensive half is shareable.** Extension modules load in the `ResourceLoader`, which is built
  once with the assembly; only the per-session binding is per turn.

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

The seam is **L0 only** ([core.md](core.md) §3). There are now two L0s — `createPiAgentFromHarness`
(`invoke.ts`) and `createPiAgentFromSession` (`session-invoke.ts`) — siblings behind one contract, with
the turn plumbing neither may own alone (lease, terminal classification, image conversion, the
promise+subscription fan-in) in `turn-plumbing.ts`. Neither imports the other: choosing an engine class
must not also choose which module graph loads.

- **`Agent`** — `invoke(scope, prompt) => AsyncIterable<AgentEvent>`. Both engine classes satisfy it;
  the SPEC calls the Agent "a black box to the Caller".
- **`SessionControl`** — engine-neutral, and it was designed with only one implementation in existence.
  Every method maps onto `AgentSession` natively, most of them more directly than onto the harness
  (`dispatch`'s verbs are `steer`/`followUp`/`abort`/`compact`/`setModel`/`setThinkingLevel`/
  `navigateTree`; `commands()` is the extension+prompt+skill registry). Nothing in the contract bends.
- **The assembly ladder, the definition, tools, channels, schedules** — level-agnostic. They produce
  inputs; the level decides who consumes them.

What the two classes do NOT yet share is the SERVING surface. `createPiAgentFromHarness` accepts an
observer and registers per-run modulation handles, which is what the session control plane
(`session-control.ts`, `/control/*`, `fastagent attach`) consumes; the session L0 has neither yet. The
`Agent` contract is satisfied by both, the control plane is not — so an engine-class choice is today
also a choice about session control, and closing that is the wiring work between this L0 and any
serving use of it.

## 5. What each level owes

**`per-invoke` owes MUST 6**: state reconstructible from the store, no process affinity. Nothing more —
in particular, "the directory is the agent, LIVE" is a fastagent product property, not part of this
level: the harness path buys it by re-reading the definition every turn, while a `session`-class
factory that shares one `ResourceLoader` across turns (what makes its per-turn cost ~1ms) trades that
freshness away. Which one is in force is the factory's choice and must be stated by it.

**`resident` owes an explicit lifecycle**: when a session is created, evicted, and rebuilt, plus a
rebind path when the definition changes (an `AgentSession` snapshots its assembly at build). It also
owes honesty in `capabilities()`: a resident deployment is not portable, and a client that migrates
between the two must not discover this from behavior.

**Both owe the same durable record**, and for the `session` class that is a property of HOW the record
is addressed rather than of the turn loop. Measured: a `SessionManager` that opens its own file buffers
everything until the first assistant message — a crash between "the user asked" and "the model answered"
loses the question, and the file is not even created. Binding it to a record the session store already
created (`setSessionFile`) persists the user's turn immediately, matching the harness class. A
`session`-class factory therefore MUST bind to an existing record — `sessionRecordBinder` is that rule
as code, so a deployment inherits it rather than re-deriving it. The shared jsonl format (§2) is what
makes it possible, and the same property is what makes a channel's at-least-once delivery safe.

The engineering bill for `resident`, measured: ~25 KB per idle `AgentSession`, and the real cost is
transcript retention at roughly the size of the record on disk (~8.6 KB per turn of ~8 KB text) — about
0.8 GB for 1000 sessions of 100 turns. Nothing for a desktop; an eviction policy for a channel host.

## 6. Consequences for the roadmap

The engine class — not the locality — is what decides whether an agent's `extensions/` directory does
anything, whether `/name` is a command or text, and whether branch navigation can summarize. Under
`harness` those are absent by construction: pi-agent-core has no extension vocabulary at all.

That reframes a class of requests. Rebuilding the `session` class's surface on the `harness` class, one
verb at a time, is how `navigate` and `commands()` landed — each an adaptation with its own contract
extension and its own divergence from the native semantics (`commands()` is a listing here because
nothing in this class expands `/name`; on the other class the same read is a dispatch surface). That is
a legitimate cost when the verb must work on the portable-and-harness path anyway. It is the wrong
answer when the request is "give me the other engine class".

Extension loading and extension dialogs (`ExtensionUIContext`'s `select`/`confirm`/`input`/`notify`,
which pi already exposes as an injectable `bindExtensions({ uiContext, mode })` seam — the same door
its RPC mode uses) are `session`-class features. They are not blocked by state locality, and they are
not implementable on the `harness` class at any price short of writing a second extension host.
