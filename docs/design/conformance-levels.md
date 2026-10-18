---
title: Conformance levels
description: "Where a session's state lives is a deployment choice the SPEC already defines — not an implementation detail. The axis, the postures that pin it, and what each owes."
status: current
---

# Conformance levels

## 1. Decision

**Where a session's state lives is an explicit deployment choice** — a property of a deployment, not
of "fastagent". Which pi class serves it is a separate question, and it is settled.

The protocol says so already. [SPEC](../SPEC.md) §8, under *Portable conformance (optional)*:

> **Process affinity only while a session works.** A session's calls MUST NOT need to reach one process while the
> session is idle: its state is reconstructible from external storage. While a message is taken or queued, they MAY
> need to reach the process working on it; portable deployment therefore needs a session router in front that sends
> a session's calls to that process.

A resident Agent is permitted, the cost is named, and the level is optional. FastAgent's own agent meets it:
`test/protocol-conformance.ts` asks every subject to `restart`, a second process over the same storage, and reads
what the first one accepted from there.

A run executes on pi's `AgentSession` (pi-coding-agent), the class pi itself consumes (its TUI, RPC
and SDK all run on it); the serving path moved there off the former `AgentHarness` (pi-agent-core),
because being the sole consumer of a surface nobody dogfoods is a position, not an architecture.
That leaves one axis: §2.

## 2. The axis

| Axis | Values | What it decides |
|---|---|---|
| **State locality** | `per-run` \| `resident` | SPEC MUST 8. Whether an idle session may require the process that ran it. |

The serving cell is `per-run` on `AgentSession`: portable AND extension-hosting.

What makes per-run binding affordable on that class, measured:

- **The expensive half is shareable.** Services (the `ResourceLoader`, settings, model runtime) build
  once at ~23 ms; binding a session to a record costs ~0.6 ms per run.
- **Freshness survives sharing.** pi's loader caches the prompt and skill overrides, so "the
  directory is the agent, LIVE" needs a reload — but only when the definition actually changed:
  0.08 ms per run unchanged, ~5.5 ms on the run after an edit.
- **The harness's TUI origins need adapting, not fighting.** pi buffers a new session until its first
  assistant message (so the store publishes the record on create), rejects every session id a channel
  mints (so ids are encoded), and installs a missing package whenever it resolves one (so fastagent
  resolves them itself and skips the absent). Each is named where it is applied.

## 3. Posture pins the level

The mapping is derived from deployment facts, not preference:

| Posture | State locality | Why |
|---|---|---|
| channels, schedules | `per-run` | Many concurrent "places" (a room, a thread) and horizontal scaling. Residency would make the live-session set an unbounded resource with an eviction policy attached. |
| AgentCore | `per-run` | The platform has no resident process — compute exists per invocation ([core.md](core.md) §9). MUST 8 is not a preference here, it is the runtime. |
| `chat`, a desktop client | either | One user, one agent, one live conversation. Location dependence costs nothing, and residency buys the harness's own continuity (queues, in-flight state) for free. |

A deployment that claims serverless portability MUST be `per-run`. Everything else is a choice with
a stated bill (§5).

## 4. What does not change

The seam is **the harness port** (`src/harness-port.ts`, [agent service](agent-service.md) §9.1): `LoopPort` over
`piLoopHarness` is the `per-run` side of it, and a resident harness would implement the port with the sessions it
keeps.

- **`Agent`** — `invoke(request) => AsyncIterable<InvokeEvent>` and its sessions. The SPEC calls the Agent "a black
  box to the Caller", and which pi class runs a run is invisible through it: the `AgentHarness` → `AgentSession` swap
  changed no contract, and `compact` lost the hand-assembled summarization pipeline `AgentHarness` needed.
- **The assembly ladder, the definition, tools, channels, schedules** — level-agnostic. They produce
  inputs; the level decides who consumes them.

## 5. What each level owes

**`per-run` owes MUST 8**: an idle session's state reconstructible from the store, process affinity only while a
message is taken or queued. Nothing more — in particular, "the directory is the agent, LIVE" is a fastagent product property,
not part of this level. Sharing a `ResourceLoader` across runs is what makes the per-run cost ~0.6 ms, and it caches
the definition; the binding pays a reload (~5.5 ms) on the run after an edit and nothing on the rest,
by asking the loader what it is serving rather than trusting a copy of what it last wrote.

**`resident` owes an explicit lifecycle**: when a session is created, evicted, and rebuilt, plus a
rebind path when the definition changes (an `AgentSession` snapshots its assembly at build). It also
owes honesty in `info().capabilities`: a resident deployment is not portable, and a client that migrates
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

The serving class is no longer a choice, which retires a whole class of requests along with it.
Extensions, slash-command dispatch, branch summaries and fork/clone are `AgentSession` features, and
the serving path is now on `AgentSession` — so they are reachable rather than blocked. What still
gates them is wiring, not class:

- **Extensions** come from the definition directory only (`noExtensions: true` keeps the operator's
  `~/.pi` setup out). pi's extension runtime belongs to its resource loader, so the binding builds one
  loader per session and each run gets its own extension instances. Dialogs get pi's no-UI default
  (`hasUI === false`, answers resolve as cancelled); routing them to the caller is still open.
- **`commands()` stays a listing**, not a dispatch surface: `invoke` takes prompts as text, and what a
  `/name` in one means is the harness's to expand ([agent service](agent-service.md) §7.4).

What has NOT changed is the level: `per-run` remains the serving posture, and residency remains a
deployment choice with the bill in §5. The `AgentHarness` → `AgentSession` swap moved which class runs a
run, not where the state lives.
