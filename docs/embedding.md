---
title: Embedding
type: doc
status: current
---

# Embedding

Use FastAgent as a **library** — the agent is one capability inside a product you already have, living in your own route, wired to your session store, your auth, your host. For the standalone CLI path (`init` / `dev` / `start`), see [quickstart](quickstart.md); both serve the **same** assembled agent.

## Prerequisites

- **Node ≥ 22.19.** Ships compiled JS + types; no build step for FastAgent itself.
- **Install as a dependency:** `npm i @kid7st/fastagent`.
- **Model credentials** — `fastagent login` (OAuth, writes `~/.fastagent/auth.json`) or a provider API key in the environment (e.g. `OPENAI_API_KEY`). Auth is invisible to your code; see [Auth](#auth) below.

## The one mental model

An agent is a thing with `invoke`. Everything else is "how you get it" and "how you consume it".

```ts
interface Agent {
  invoke(scope: { session: string }, prompt: { text: string }): AsyncIterable<AgentEvent>;
}
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  | { type: "completed"; data?: Json }    // terminal: success
  | { type: "failed"; details: string; retryable: boolean };  // terminal: failure
```

The stream ends with exactly one `completed` / `failed`, or is cancelled by the consumer. `session` is an opaque string you choose; reuse it to continue a conversation.

## 1. Get the agent (pick by what you have)

| You have | Use | Returns |
|---|---|---|
| An agent folder (`AGENTS.md` + `skills/` + `tools/` + config) | `createPiAgentFromWorkspace(dir, { model? })` | `{ agent, definition, modelSpec, … }` — auto-discovers everything |
| A definition folder, but you want to control the K ports | `createPiAgentFromDefinition(dir, { model, … })` | `{ agent, definition }` |
| No folder — assemble from code | `createPiAgent({ model, instructions, tools })` | `agent` |

```ts
// A) folder, batteries-included (the same assembly `fastagent dev` uses)
const { agent } = await createPiAgentFromWorkspace("./agent", { model: "openai-codex/gpt-5.5" });

// B) no folder — Tier 1: three concrete fields
import { createPiAgent, defineTool, z } from "@kid7st/fastagent";

const lookupOrder = defineTool({
  name: "lookup-order",                       // set the name explicitly when assembling in code
  description: "Look up an order by id.",
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return await db.find(orderId);            // a plain value is auto-wrapped; a throw is reported to the model
  },
});

const agent = createPiAgent({
  model: "openai-codex/gpt-5.5",              // a "provider/modelId" spec string
  instructions: "You are a support assistant. Use lookup-order to answer order questions.",
  tools: [lookupOrder],
});
```

`model` is always a spec string; `fastagent models` (or `listModels`) lists the available ones. `instructions` IS the system prompt — verbatim, no engine persona prepended. (The folder path assembles `AGENTS.md` differently: it adds the pi engine base + skills + env for fidelity with local pi. See [core-design §2](core-design.md).)

## 2. Consume the stream (three ways)

```ts
// (1) raw stream — render tokens as they arrive
for await (const e of agent.invoke({ session: "u1" }, { text: "hi" })) {
  if (e.type === "text") render(e.delta);
}

// (2) buffered JSON — one question, one answer
import { collect } from "@kid7st/fastagent";
const { text } = await collect(agent.invoke({ session: "u1" }, { text: "hi" }));
// `collect` throws AgentFailure on a failed turn, and errors if the stream has no terminal event.

// (3) HTTP/SSE — createInvokeHandler is a Fetch handler: mount it in any host route
import { createInvokeHandler } from "@kid7st/fastagent";
const handler = createInvokeHandler(agent);   // (Request) => Promise<Response>; POST {session,text} → SSE
```

The Fetch handler mounts wherever your host speaks `(Request) => Response`:

```ts
// Next.js App Router — app/api/chat/route.ts
export const POST = handler;

// Hono — c.req.raw is a Web Request
app.post("/chat", (c) => handler(c.req.raw));

// Bun
Bun.serve({ port: 8787, fetch: (req) =>
  new URL(req.url).pathname === "/chat" ? handler(req) : new Response("not found", { status: 404 }) });

// Plain Node (no native Fetch routing) — the built-in server
import { serveNode, router } from "@kid7st/fastagent";
serveNode(router({ "POST /chat": handler }), { port: 8787 });
```

Cancellation, backpressure, and a body cap are native to the web-stream primitives: a client disconnect cancels the underlying invoke. Concurrent requests on the **same** session fail fast — the second receives `failed{session busy}`.

## 3. Tier 1 vs Tier 2

The common path is three concrete fields. The engine ports are optional injection points you reach for only when you need them — defaults run out of the box.

```ts
createPiAgent({
  model: "openai-codex/gpt-5.5",   // Tier 1: which model (spec string)
  instructions: "…",               // Tier 1: the persona
  tools: [/* defineTool(...) */],  // Tier 1: capabilities
  skills: [/* … */],               // optional: on-demand skill files

  // ── Tier 2: injectable ports (default values run fine) ──
  sessions,   // PiSessionStore  — persistence (default: in-memory)
  env,        // ExecutionEnv    — tool execution env (default: local Node cwd)
  lease,      // Lease           — concurrency floor (default: in-process fail-fast)
  providers,  // Provider[]      — your own model source (see §5)
});
```

| Port | Default | Reach for it when |
|---|---|---|
| `sessions` | `inMemorySessionStore()` (lost on restart) | `jsonlSessionStore({ dir })` for restart-surviving continuity, or your own `PiSessionStore` |
| `env` | local `NodeExecutionEnv` (cwd) | a sandbox / microVM for untrusted execution |
| `lease` | `inProcessLease()` | a distributed lock across instances (implement `Lease`) |
| `providers` | built-in providers | your own gateway / self-hosted endpoint (see §5) |

## 4. Auth

Auth never appears in your agent code. It resolves, in order, from **`~/.fastagent/auth.json`** (written by `fastagent login` — OAuth or API key) then **ambient env vars** (e.g. `ANTHROPIC_API_KEY`). A server deploy that only sets an env key Just Works; a dev machine uses `fastagent login`.

To check what's in effect: `probeAuthSource(createPiModels(), "openai-codex/gpt-5.5")` returns the resolved source label (`"OAuth"`, `"ANTHROPIC_API_KEY"`, or `undefined`).

Static keys belong in the login file or the environment, not in code — there is no `apiKey` constructor option by design. The only model-source injection point is `providers` (next), for when the endpoint itself is yours.

## 5. Your own model source: `providers`

When you run your own **gateway** or a **self-hosted / OpenAI-compatible** endpoint, register it as a provider; a `model` spec then selects it by id. This is the one case that touches the engine's provider layer — built-in providers cover everything else.

```ts
import { createPiAgent, createProvider } from "@kid7st/fastagent";
// the wire-protocol impl comes from pi-ai's api subpath (reuse, don't reimplement)
import { /* the matching api impl */ } from "@earendil-works/pi-ai/api/openai-responses";

const myGateway = createProvider({
  id: "acme",
  baseUrl: "https://gw.acme/v1",
  auth: {
    apiKey: {
      name: "Acme gateway",
      // resolve() runs per request — mint / fetch / rotate a token from your auth service here
      resolve: async () => ({ auth: { apiKey: await mintToken() }, source: "acme" }),
    },
  },
  models: [/* your model descriptors */],
  api: /* the reused api impl */,
});

const agent = createPiAgent({ model: "acme/gpt-x", providers: [myGateway] });
```

`providers` are registered on top of the built-ins (a matching id overrides a built-in). An "auth service" is modeled as a provider — its per-request credential logic lives in the provider's `auth.…resolve()`, not as a separate credential option.

## How embed and CLI relate

`fastagent dev` / `start` are the CLI wrapping of `createPiAgentFromWorkspace` plus process side effects (`.env`, proxy, watch, serve). The agent the CLI serves is the **same** one `createPiAgentFromDefinition` hands you when embedding — single assembly source. What you iterate under `dev`, what `start` serves, and what you embed are identical.

## Where next

- [SPEC](SPEC.md) — the Agent Handler contract the whole thing rests on.
- [quickstart](quickstart.md) — the CLI path (`init` / `dev` / `start`).
- [core-design](core-design.md) — the assembly ladder (L0–L2), the four-segment prompt assembly, and the N × M × K layering.
