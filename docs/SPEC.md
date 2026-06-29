---
title: Agent Handler — Protocol Specification
type: spec
status: locked
version: 0.1
updated: 2026-06-09
---

# Agent Handler — Protocol Specification v0.1 (locked)

> A handler contract for the agent layer, analogous to Web fetch handlers: one function plus a small set of MUSTs so any **Caller** can drive any **Agent** without knowing its engine, model, wire protocol, or deployment shape.
>
> The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119. This specification is engine-neutral and does not depend on any implementation.

## 1. Overview

There are three roles:

- **Agent**: an object that implements `invoke`. It receives one call, runs one turn, and streams events. It is a black box to the Caller.
- **Caller**: the party that initiates an invocation — a channel, trigger, CLI, or external wire adapter such as A2A or ACP.
- **Middleware**: both a Caller and an Agent — it wraps a downstream Agent while exposing the same interface for auth, budgets, logging, etc.

`invoke` is not an external wire protocol. HTTP, A2A, ACP, or any custom transport can sit outside it; `invoke` is the internal contract between Callers and Agents.

## 2. The Agent Handler

```ts
interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
```

One turn = one `invoke`. The result is one async event stream; buffered consumption is a degeneration of that stream (§7).

The return type MUST be `AsyncIterable`; `async function*`, `ReadableStream`, and equivalent implementations are all valid.

## 3. Scope

```ts
interface Scope {
  session: string;          // Conversation anchor across invocations.
}
```

`session` is an opaque string owned by the Caller. Multiple turns in the same logical conversation MUST reuse the same `session`. Additional fields such as identity, source, and constraints are extensions (§8).

## 4. Prompt

```ts
interface Prompt { text: string; images?: ImageRef[]; }
interface ImageRef { mimeType: string; data: string; }   // base64
```

Agents that do not support `images` ignore it.

## 5. AgentEvent

```ts
type AgentEvent =
  | { type: "text";         delta: string }
  | { type: "thinking";     delta: string }                      // Model reasoning (process, not the answer)
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended";   id: string; isError: boolean; content: Json }
  | { type: "completed";    data?: Json }                        // Terminal: success
  | { type: "failed";       details: string; retryable: boolean }; // Terminal: failure

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
```

- All textual output is emitted as `text` deltas; `completed` is only a terminal success signal and does not repeat the full text.
- `thinking` deltas carry the model's reasoning when the engine and model expose it (optional — many models emit none). It is process, not output: a consumer MUST NOT fold `thinking` into the final answer (`collect` ignores it). Surface it for live/observability UIs only.
- `completed.data` is present only when the engine produces structured data.
- Every event MUST be JSON-serializable.

## 6. Conformance

An `invoke` stream MUST end in exactly one of the following three ways:

- **(a) `completed`** — success;
- **(b) `failed`** — failure;
- **(c) Caller cancellation** — no terminal event.

The following MUSTs spell out that trichotomy for both roles.

### Agent MUST

1. **Exactly one terminal**: when the Caller consumes the stream to natural completion (without cancelling), the last event MUST be either `completed` or `failed`, and no event may follow it. This corresponds to (a)/(b).
2. **Failures are events, not thrown iteration errors**: an Agent MUST NOT let iteration of `invoke` throw. Every failure MUST be represented as a `failed` event. This keeps the terminal set closed for consumers: failure has exactly one channel.
3. **Respond to cancellation**: when the Caller stops consuming (`for-await` break, iterator `return()`, or `ReadableStream` `reader.cancel()`), the Agent MUST promptly abort in-flight model/tool work and release resources. In this case a terminal event is neither required nor expected. This corresponds to (c).

### Caller MUST

4. **Forward compatibility**: the terminal set `{ completed, failed }` is frozen and not extensible. New event types MUST be non-terminal. A **terminal consumer** (a Caller consuming the stream to obtain a result) MUST ignore unknown non-terminal events.
5. **Relay passthrough**: a Caller acting as **Middleware** and relaying a downstream stream MUST pass unknown non-terminal events through unchanged, and MUST NOT drop them. “Ignore” applies to terminal consumers only, not to relays; otherwise a downstream engine adding a new event type would be broken by the relay hop, defeating MUST 4.

### Portable conformance (optional; required for Agents claiming serverless portability)

6. **No location dependence**: the Agent MUST NOT require multiple invocations with the same `session` to land in the same process or instance. Session state must be reconstructible from external state. A resident stateful Agent can still conform to Agent Handler, but it does not satisfy portable conformance.

### Explicit non-guarantees

The protocol does **not** guarantee the following; implementations and consumers MUST NOT rely on them:

- **`tool_started` / `tool_ended` pairing**: normally these events are paired by `id`, and `tool_ended` follows the matching `tool_started`; after cancellation (c), a dangling `tool_started` may remain. Tool UIs must tolerate dangling starts.
- **Session cleanliness of `failed.retryable`**: `retryable: true` means “worth re-sending with the same `session`”. It does **not** guarantee that the failed turn was atomic with respect to session state. A partial turn may have already appended entries or run side-effecting tools. Retry side-effect safety belongs to the engine/tools, not to the protocol (§9).

## 7. Consumption: streaming and buffered

`invoke` returns a stream, but there are **two first-class ways to consume it**, matching the two shapes of agent work:

- **Streaming** — conversational/interactive features: read `text` deltas and `tool_*` events as they arrive (a chat UI, an SSE endpoint).
- **Buffered** — task-style features (classify, extract, generate, triage): ignore intermediate events and take the final result. This is the dominant shape when an agent is **embedded as a feature** (input → result), not a chat.

Buffered consumption is a degeneration of the same stream via a pure caller-side reducer. It adds **no** protocol surface — `invoke` still returns only `AsyncIterable<AgentEvent>` — but it is a **canonical, supported consumption mode**, not an afterthought (the reference implementation exports `collect`):

```ts
async function collect(events: AsyncIterable<AgentEvent>): Promise<{ text: string; data?: Json }> {
  let text = "";
  for await (const e of events) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "completed") return { text, data: e.data };
    else if (e.type === "failed") throw new AgentFailure(e.details, e.retryable);
  }
  throw new Error("stream ended without a terminal event"); // violates MUST 1
}
```

`collect` also restores JS-idiomatic error handling for the buffered case: `failed` becomes a thrown `AgentFailure`, whereas streaming consumers handle it as the terminal event (MUST 2). Task-style results ride on `completed.data`; a typed/validated result is an extension (§8), demand-driven and not part of v0.1 core.

## 8. Extension points

The core stays small. The following extensions attach through additional `scope` fields, new non-terminal events, optional parameters, or Middleware:

| Extension | Attachment point |
|---|---|
| Identity / multi-tenancy | `scope.principal`, e.g. `{ type, issuer, subject }` |
| Source / trace | `scope.source` and other identifying fields |
| Execution constraints such as deadline / budget | Middleware; for example, `budget_exceeded` becomes a `failed` event produced by Middleware |
| Mid-turn steering | **Extension, not part of the v0.1 core signature**: add an optional third parameter `input?: AsyncIterable<Prompt>` to `invoke` and feed input into the in-flight turn, corresponding to pi `steer` / `followUp` / `nextTurn`. If the desired behavior is “discard the current turn and go another way”, use cancel + a new `invoke` with the same `session`; no steering extension is required. |
| Thinking / citations / artifact streaming | Add new non-terminal `AgentEvent` types |
| Structured / typed result | Per-invoke output-schema negotiation; the validated result rides on `completed.data`. Demand-driven (task-style embed features); not in v0.1 core, and MUST NOT change the frozen terminal set. |
| Failure subdivision | Add `failed.code?` |

## 9. Dependency inversion

The protocol treats an Agent as a black box. The following concerns are injected inside that black box and are not specified here:

| Injection | Meaning |
|---|---|
| Session storage | an external session store such as jsonl, Postgres, or DynamoDB |
| Tool execution environment | local process, sandbox, E2B, etc. |
| Model selection | injected by implementation/assembly |
| Tools and agent definition loading | assembly-layer concerns |

## 10. Out of scope

- **Wire / transport**: expose the Agent through A2A, ACP, HTTP, or any custom transport; Agent Handler is the internal layer they call.
- **Engine internals**: turn loop, tool execution, model calls, and context management.
- **Agent definition format**: consume existing standards such as `AGENTS.md`, Agent Skills, and MCP; do not invent a parallel format.
- **Packaging / deployment**: consume OCI and target runtime conventions.
- **Task orchestration**: long-running task state machines and artifact versions belong to upper layers such as A2A Tasks or userland workflows.

## 11. Relationship to existing standards

| Layer | Web | Agent |
|---|---|---|
| External wire | HTTP | A2A / ACP |
| Gateway contract | fetch handler `(Request) => Response` | **Agent Handler `invoke(scope, prompt) => AsyncIterable<AgentEvent>`** |
| Engine/app internals | frameworks / application code | agent engine |

## Minimal example

```ts
async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
  try {
    for await (const chunk of model.stream(scope.session, prompt.text)) {
      if (chunk.kind === "text") yield { type: "text", delta: chunk.text };
      if (chunk.kind === "tool") {
        yield { type: "tool_started", id: chunk.id, name: chunk.name, args: chunk.args };
        const r = await runTool(chunk);
        yield { type: "tool_ended", id: chunk.id, isError: r.error, content: r.content };
      }
    }
    yield { type: "completed" };
  } catch (e) {
    yield { type: "failed", details: String(e), retryable: isTransient(e) };
  }
}

// Streaming
for await (const e of agent.invoke({ session: "s1" }, { text: "triage issue #42" })) {
  if (e.type === "text") process.stdout.write(e.delta);
}

// Buffered
const { text } = await collect(agent.invoke({ session: "s1" }, { text: "…" }));
```
