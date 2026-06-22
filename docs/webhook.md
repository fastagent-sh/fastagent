---
title: Webhook channel & the `background` port (N-axis)
type: design-doc
status: implemented
updated: 2026-06-22
---

# Webhook channel & the `background` port

> Engineer handoff for the first non-SSE channel. **N-axis only.** It defines the
> webhook channel and the single new Caller-side port the channel surfaces
> (`background`). It does **not** design hosts (fly.io / AgentCore) — those *fill*
> `background` and are K-face work. The locked `Agent` / `invoke` contract (SPEC v0.1)
> is untouched.
>
> **Status:** shipped in core — `createWebhookHandler`, `WebhookBinding`,
> `BackgroundRunner`, `createTrackedBackground` (`core/src/channels/webhook.ts` +
> `background.ts`), exercised by `core/test/webhook.test.ts`. `deliver`/`onError` are
> **optional** (§5/§7): a fat agent posts its own result via tools.

## 1. Why this, why now

`serve` is the strategic core (build an agent → deploy it to the cloud → it acts while
you are away). The webhook is the canonical "agent acts on an external trigger" channel.

It is also the **seam test**: the SSE channel already proved a Caller can consume the
`Agent` contract alone; the webhook is the second N, and it surfaces something SSE hid —
that a Caller has its own host dependency (execution lifetime). Building it validates
that the N axis composes on contracts, and pins down the one port that was missing from
the catalog.

## 2. Where it sits

```
webhook.ts (N) ─────────┐
                        ├──► @kid7st/fastagent contracts (Agent, collect, BackgroundRunner, …)
background impl (K) ────┘                ▲
                                         │
server.ts (composition root) ────────────┘   only this file knows all three of N/M/K
```

The channel imports **only** the contract. The host fills `background`. **Neither imports
the other.** The composition root (`server.ts` = `main`) wires a concrete N + M + K — that
is its job, and it is the one place allowed to import all three (core's own `cli.ts` does
exactly this).

## 3. The consumption topology this channel is

The webhook is the **ACK-early** topology: the caller does not wait for the result.

| Consumption | Caller waits for the result? | Needs `background`? | Stays alive via |
|---|---|---|---|
| SSE chat (`createInvokeHandler`) | yes (connection open) | **no** | the open connection |
| Buffered embed (`await collect` in a route) | yes (request blocks) | **no** | the awaited request |
| CLI (`for await`) | yes (process runs) | **no** | the process |
| Queue worker (`await collect`, then ack) | yes | **no** | worker + visibility timeout |
| **Webhook (`202`, deliver out-of-band)** | **no** | **yes** | **`background`** |

The discriminator is **"does the caller await the result"**, not "is the turn long". A
caller that blocks on the result gets liveness for free; a caller that ACKs early and
finishes later must re-acquire it. `background` is therefore **not a universal tax** — only
ACK-early channels declare it. SSE/embed/CLI never import it.

## 4. The `background` port (new, Caller-side)

A new port, added to core's public surface alongside the Agent-side ports
(`PiSessionStore`, `Lease`, `AuthResolver`, `ExecutionEnv`).

```ts
/**
 * Run a task to completion AFTER the caller has detached (e.g. a webhook that already
 * returned 202). The host provides this; the channel only declares it.
 *
 * CONTRACT: the implementation MUST run `task` to completion under normal operation.
 * `(t) => void t()` is ILLEGAL — it carries no completion guarantee; the moment the
 * response is sent the runtime may reclaim the process and the task dies mid-flight.
 * The completion guarantee is the entire reason this port exists.
 */
export type BackgroundRunner = (task: () => Promise<void>) => void;
```

Placement, stated so nobody re-files it:

- It is **not** an `invoke` extension (it adds no `scope` field, no event, no `invoke`
  parameter; `agent.invoke` is byte-identical with or without it; the agent never sees it).
- It is **not** Middleware (Middleware *is* the invoke contract — invoke in, invoke out;
  "detach early, finish later" cannot be expressed inside a stream-someone-consumes).
- It **is** the Caller-side twin of SPEC §9 dependency inversion. §9 documents the
  Agent-side injected ports; `background` is the same idea on the Caller side. It lives
  **outside** the invoke contract, in the deployment/execution-model layer SPEC §10 keeps
  out of scope. In WSGI/ASGI terms it is the server's background-task / lifespan layer, not
  the app callable.

Naming: the call site (`background(() => work)`) is read by many channel authors whose
intent is "do this after I ACK"; the completion guarantee is enforced for the few host
implementers by the contract above + the reference impl in §8, not by the name.

**v1 scope of the port:** the task is an opaque closure. This is correct for in-process
hosts. A durable, cross-instance host (the work must survive *this* instance dying) cannot
serialize a closure — that reshapes the port to carry `{ scope, prompt, delivery }` data
and re-invoke on a worker. That reshape is **K-face**, deferred (§12).

## 5. The channel interface

```ts
// You implement WebhookBinding; core ships createWebhookHandler (core/src/channels/webhook.ts).
import type { Agent, AgentFailure, BackgroundRunner, Json, Prompt, Scope } from "@kid7st/fastagent";

/** Per-platform glue (generic callback, Slack, GitHub, …). One impl per platform. */
export interface WebhookBinding<E> {
  /** Verify signature + parse the request into an event, or null to reject (→ 4xx). */
  parse(req: Request): Promise<E | null>;
  /** Map the event to an invocation. `scope.session` is derived from the payload. */
  toInvocation(event: E): { scope: Scope; prompt: Prompt };
  /**
   * Deliver the result out-of-band (OPTIONAL). Omit it when the agent posts its own result via
   * tools (e.g. `gh pr review`); provide it for a thin agent whose text/data the binding posts.
   */
  deliver?(event: E, result: { text: string; data?: Json }): Promise<void>;
  /** Deliver a turn failure out-of-band (OPTIONAL). `retryable` is the platform-retry signal. */
  onError?(event: E, failure: AgentFailure): Promise<void>;
}

// Shipped by core — you implement only the WebhookBinding above. Signature:
export function createWebhookHandler<E>(
  agent: Agent,
  binding: WebhookBinding<E>,
  background: BackgroundRunner,
): (req: Request) => Promise<Response>;
```

Behavior (the authoritative impl is `core/src/channels/webhook.ts`): a non-POST is `405`; a
`parse` returning `null` is `401` and a `parse` that throws is `400` (failure plane #1, pre-ACK);
otherwise it ACKs `202` and runs the turn via `background`. On a turn failure it calls
`binding.onError` — or, when no `onError` is installed, **rethrows** the `AgentFailure` so it reaches
the background runner's error sink rather than being swallowed (fail-visible). The handler is
**Fetch-shaped** (`(Request) => Promise<Response>`), like `createInvokeHandler`, so it mounts in any
host route; `nodeListener` bridges it to `node:http` for the standalone server.

## 6. The discipline (the rules that make it host-neutral)

1. **ACK / run split.** Respond `202` immediately; the turn runs via `background`. Never
   block the response on the turn, and never run the turn synchronously hoping the platform
   waits.
2. **Delivery is out-of-band.** The HTTP response is only an acknowledgement. The result
   reaches the user through `binding.deliver` (and failures through `binding.onError`).
3. **Never bake the runtime lifecycle into the channel.** No `void task()`, no assuming a
   long-running process. The channel's only contact with execution lifetime is the
   `background` port; *how* it is fulfilled is the host's problem.
4. **Buffered consumption.** Use `collect`. Drop to the raw `invoke` stream only if a
   channel genuinely needs partial output on failure (rare; webhooks want atomic
   success-or-fail).

## 7. Cross-cutting behaviors (decided here so they are not rediscovered)

**Two failure planes.** Pre-ACK (`parse`/verify) failures answer the HTTP request directly
(`4xx`). Post-ACK (turn) failures cannot use the original response (already `202`) — they go
out-of-band via `onError`. Retry of a post-ACK failure is the binding's call (re-POST a
callback, re-enqueue, or rely on the platform's own redelivery); `AgentFailure.retryable`
is the signal that it is worth retrying with the same `session`.

**Same-session concurrency is not the dedup tool.** Two turns for the same `session` at once
→ the second yields `failed{retryable:true}` ("session busy"), surfaced as a thrown
`AgentFailure` through `collect`. The channel's correct response is retry/re-enqueue
(channel policy). This is the *concurrency floor*, not idempotency.

**Dedup / idempotency is channel-owned, before `invoke`.** Webhooks redeliver; an
at-most-once channel must dedup on the platform's **delivery id** (which the binding has),
*before* calling `invoke` — not via the Lease (busy ≠ duplicate) and not via the agent.
v1 leaves dedup to the binding; a shared idempotency store may later become its own port
(do not add it now — §12).

**`Scope` is sufficient for serve.** `scope.session` (opaque, channel-derived) is enough
for a served, single-tenant-per-deployment agent. Multi-tenant principal threading is an
embed-phase concern, and is deferred not only as a `Scope` field but because it would have
no path to tools/env today (tools receive only `ToolContext{ signal }`).

## 8. Reference host (single-instance) — `createTrackedBackground`

Core ships this as `createTrackedBackground` (import it; you do not write it). The simplest
**correct** `background`: track in-flight tasks so a graceful shutdown drains them instead of
killing turns mid-flight. Channel-agnostic (any ACK-early channel can use it); depends only on
the port type. Its shape:

```ts
import { createTrackedBackground } from "@kid7st/fastagent";

const { background, drain } = createTrackedBackground(); // + optional { onTaskError }
// pass `background` to createWebhookHandler; call `drain()` on SIGTERM before exiting.
```

Behavior (impl: `core/src/channels/background.ts`): each task starts on a **macrotask**
(`setImmediate`) so the caller's response — e.g. a webhook `202`, written in a microtask
continuation — lands before the turn begins; a synchronous throw inside the task is captured and
routed to `onTaskError` (default `console.error` — fail visibly, never swallow); `drain()` awaits
all in-flight tasks. Strict ACK-first latency *under load* is the durable runner's job, not this
in-process one (§12).

The wrong impl, for contrast:

```ts
const background: BackgroundRunner = (task) => void task(); // ✗ no completion guarantee
// 202 already sent → SIGTERM / process.exit cuts the running turn mid tool-call. The bug is
// 100% here in the host's background impl, not in the channel and not in invoke.
```

Multi-instance / crash-durable `background` (queue + worker, AgentCore async invocation) is
**K-face**, out of scope for this doc.

## 9. Composition root example

```ts
// server.ts — wires one N + one M + one K.
import { createServer } from "node:http";
import {
  createPiAgentFromArtifact, // M assembly
  nodeListener, // transport
  createWebhookHandler, // N channel (shipped by core)
  createTrackedBackground, // K runner (shipped by core)
} from "@kid7st/fastagent";
import { callbackBinding } from "./callback-binding.ts"; // N glue (per platform — you write this)

const { agent } = await createPiAgentFromArtifact(process.cwd());
const { background, drain } = createTrackedBackground();

const server = createServer(nodeListener(createWebhookHandler(agent, callbackBinding, background)));
process.on("SIGTERM", async () => {
  server.closeIdleConnections?.(); // drop idle keep-alive sockets so close() does not hang
  await new Promise<void>((r) => server.close(() => r())); // let in-flight requests send their 202 (they enqueue their task first)
  await drain(); // ordering matters: drain AFTER close, so no late request enqueues a task past the snapshot
  process.exit(0);
});
server.listen(8787);
```

The `close → drain` order is the point: draining before the listener is closed can miss a task
from a request still mid-`parse` when the signal arrived. Production-grade graceful shutdown
(keep-alive handling, a hard timeout) is host-specific; this shows only the ordering.

## 10. Build it as a family, not a one-off

Reusable core (`createWebhookHandler` + `background`) + **per-platform bindings**. Ship a
generic **callback** binding first (cleanest: a shared-secret header, `{ session, text,
callbackUrl }` in, result POSTed back); Slack / GitHub bindings follow the same interface.

```ts
// callback-binding.ts
import type { WebhookBinding } from "@kid7st/fastagent";
interface Ev { session: string; text: string; callbackUrl: string }

export const callbackBinding: WebhookBinding<Ev> = {
  async parse(req) {
    if (req.headers.get("x-secret") !== process.env.WEBHOOK_SECRET) return null;
    const b = (await req.json()) as Partial<Ev>;
    return b.session && b.text && b.callbackUrl ? (b as Ev) : null;
  },
  toInvocation: (e) => ({ scope: { session: e.session }, prompt: { text: e.text } }),
  deliver: async (e, r) => {
    const res = await fetch(e.callbackUrl, { method: "POST", body: JSON.stringify({ ok: true, ...r }) });
    if (!res.ok) throw new Error(`callback POST failed: ${res.status}`); // fetch does NOT reject on 4xx/5xx; surface it
  },
  onError: async (e, f) => {
    const res = await fetch(e.callbackUrl, {
      method: "POST",
      body: JSON.stringify({ ok: false, error: f.details, retryable: f.retryable }),
    });
    if (!res.ok) throw new Error(`callback POST failed: ${res.status}`);
  },
};
```

> The §9/§10 samples are **illustrative** — they show the wiring and the binding shape, not a
> production HTTP client. Concerns like request timeouts, retry/backoff, and SSRF allowlisting of
> `callbackUrl` are the binding author's, per platform; only the essentials (a `res.ok` check so a
> failed delivery is not silently lost) are shown here.

## 11. Acceptance criteria (definition of done)

- `webhook.ts` imports **only** contract symbols — zero `Pi*`, zero host imports.
- The handler returns `202` **before** any turn work runs.
- The generic callback binding round-trips: `POST` → `202` → out-of-band delivery carrying
  the result `{ text, data? }`.
- Failure paths: a turn failure reaches `onError` (out-of-band); a parse/verify failure
  returns `4xx` (on the request).
- The same handler runs **unchanged** against two different `background` impls
  (`createTrackedBackground` + a stub queue runner) — proving the seam is the only N↔K
  contact point.
- `createTrackedBackground` drains in-flight turns on `SIGTERM` — no dropped turns.

## 12. Non-goals / open questions (explicitly deferred)

- **Durable / cross-instance `background`.** A closure cannot cross a process; a crash-durable
  host reshapes the port to carry `{ scope, prompt, delivery }` data + re-invoke on a worker.
  K-face.
- **A shared idempotency/dedup store** as its own port. Surfaced (§7) but not built; wait for
  a real backend.
- **Multi-tenant principal threading.** Embed-phase; needs a path to tools/env, not just a
  `Scope` field.
- **Streaming + detached** (e.g. a self-editing Slack message: `background` + the raw stream).
  Real but not v1.

## Core change this implies

Add `BackgroundRunner` to the package's public port surface (Caller-side), re-exported from
the root like the other ports. No change to `agent.ts` or the locked SPEC. Optional: a SPEC
§9 note that Callers, like Agents, have injected host capabilities.
