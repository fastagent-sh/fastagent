---
title: Session — fastagent session-admin draft
type: design-doc
status: draft
updated: 2026-06-11
---

# Session-admin draft

The Agent Handler [SPEC](SPEC.md) defines one operation: `invoke` advances a conversation by one turn. Session-admin is a separate, higher-level surface for inspecting and moving through the conversation tree: history, fork, and navigation.

This document is a draft. It is not part of the locked v0.1 SPEC and is not fully implemented in core today.

## Mental model

A portable conversation session is an event-sourced DAG:

- entries are append-only,
- each entry has a parent pointer,
- a current pointer selects the active path,
- history is derived by walking from current to root,
- fork creates a new session id from an existing prefix,
- navigation moves the current pointer without deleting old branches.

The closest analogy is Git for conversations, minus merge/rebase.

| Git | Session-admin concept |
|---|---|
| commit | immutable `Entry` with `id` and `parentId` |
| HEAD | current pointer |
| reflog | pointer moves as append-only entries |
| branch | `fork(id?) -> new session id` |
| log | active-path history |

## Proposed consumer API

```ts
interface SessionAdmin {
  current(session: string): Promise<string | null>;
  navigate(session: string, entryId: string): Promise<void>;
  fork(session: string, entryId?: string): Promise<string>;
  getHistory(session: string): Promise<Entry[]>;
  capabilities(session: string): Promise<{ fork: boolean; navigate: boolean }>;
}
```

The `Scope` passed to `invoke` remains unchanged: it only contains the opaque `session` string. Node ids do not go into `Scope`; doing so would make unsupported branching silently append to the wrong place.

## Proposed entry model

```ts
interface Entry {
  id: string;
  parentId: string | null;
  kind: EntryKind;
  payload: Json;
  preview?: string;
  timestamp: string;
}

type EntryKind = "turn_input" | "turn_output" | "pointer_move" | "meta";
```

`payload` is opaque to the generic DAG layer. Engine-specific modules interpret it and produce display previews or model-context projections.

## Layering

Session-admin splits into three concerns:

1. **Consumer API** — stable surface for channels/UIs.
2. **DAG core** — engine-neutral graph logic: active path, fork-prefix, navigate, capabilities.
3. **Adapters**:
   - **Host/storage adapter** (`SessionLogStore`) — append/read/pointer/lease over jsonl, Postgres, DynamoDB, AgentCore, etc.
   - **Engine module** — interprets payload and projects entries back into the engine's model context.

The important rule is that `navigate` and `fork` belong to the generic DAG core, not to an engine module. Engines interpret payload; they do not own graph movement.

## Relationship to current core

Current core already implements the minimum needed for linear session continuity:

- `SessionStore` in `core/src/engines/pi/sessions.ts` is intentionally smaller than this draft: it only needs `openOrCreate(sessionId)` for the pi harness factory.
- `jsonlSessionStore` provides restart-surviving continuity for `fastagent dev`.
- `inProcessLease` prevents same-session concurrent writes inside one process.

This draft describes the next layer above that minimum: portable fork/navigation and a richer storage seam. To avoid a naming conflict, the future append/read/pointer backend is called `SessionLogStore` here, not `SessionStore`.

## Open questions

- Is `{ turn_input, turn_output, pointer_move, meta }` enough for UI rendering and graph operations?
- Should remote stores materialize active paths, or is full-log read acceptable for v1?
- What is the distributed lease shape: fail-fast, blocking, TTL, fencing?
- Should payloads remain engine-bound forever, or should FastAgent eventually standardize a cross-engine message schema?

## Non-goals for v0.1

- No session-admin API in the Agent Handler SPEC.
- No node id in `Scope`.
- No merge/rebase semantics.
- No attempt to define a stable engine adapter before a second engine exists.
