---
title: Embedding
description: "Use FastAgent as a library: get an agent, consume its event stream, and mount the Fetch handler in Next.js, Hono, Express, Fastify, Bun, or Node."
type: doc
status: current
---

# Embedding

Use FastAgent as a **library** — the agent is one capability inside a product you already have, living in your own route, wired to your session store, your auth, your host. For the embedded CLI path (`init` / `dev` / `start`), see [quickstart](quickstart.md); both serve the **same** assembled agent.

## Prerequisites

- **Node ≥ 22.19.** Ships compiled JS + types; no build step for FastAgent itself.
- **Install as a dependency:** `npm i @fastagent-sh/fastagent`.
- **Model credentials** — `fastagent login` (OAuth, writes the project-level `<agent dir>/.secrets/auth.json`) or a provider API key in the environment (e.g. `OPENAI_API_KEY`). Auth is invisible to your code; see [Auth](#4-auth) below.

## The one mental model

An agent is a thing with `invoke`. Everything else is "how you get it" and "how you consume it".

```ts
interface Agent {
  invoke(scope: { session: string }, prompt: { text: string }): AsyncIterable<AgentEvent>;
}
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string } // advisory: internal retry backoff
  | { type: "completed"; data?: Json }    // terminal: success
  | { type: "failed"; details: string; retryable: boolean; code?: string };  // terminal: failure
```

The stream ends with exactly one `completed` / `failed`, or is cancelled by the consumer. `session` is an opaque string you choose; reuse it to continue a conversation.

## 1. Get the agent (pick by what you have)

| You have | Use | Returns |
|---|---|---|
| An agent directory (`persona.md` + `skills/` + `tools/` + config) | `createPiAgentFromDir(dir, { model? })` | `{ agent, definition, modelSpec, … }` — auto-discovers everything |
| A definition directory, but you want to control the K ports | `createPiAgentFromDefinition(dir, { model, … })` | `{ agent, definition }` |
| No directory — assemble from code | `createPiAgent({ model, instructions, tools })` | `agent` |

```ts
// A) directory, batteries-included (the same assembly `fastagent dev` uses)
const { agent } = await createPiAgentFromDir("./agent", { model: "openai-codex/gpt-5.5" });

// B) no directory — Tier 1: three concrete fields
import { createPiAgent, defineTool, z } from "@fastagent-sh/fastagent";

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

Use the `z` re-exported from `@fastagent-sh/fastagent`, not a separately installed `zod`: `defineTool` converts schemas with its own copy. Every type our signatures name (`AgentTool`, `Skill`, `Model`, `PiSessionEntry`, …) is re-exported. Import `createProvider` and a provider's wire-protocol `api` from `@earendil-works/pi-ai` (see §5).

`model` is always a spec string; `fastagent models` (or `listModels`) lists the available ones. `instructions` IS the system prompt — verbatim, no engine persona prepended. The directory path instead assembles the pi base (optionally customized by `persona.md`), `AGENTS.md` project context, skills, and environment context. See [core design §2](design/core.md).

## 2. Consume the stream (three ways)

```ts
// (1) raw stream — render tokens as they arrive
import { SESSION_BUSY_CODE } from "@fastagent-sh/fastagent";
for await (const e of agent.invoke({ session: "u1" }, { text: "hi" })) {
  if (e.type === "text") render(e.delta);
  // A FIRST event of this shape is a reject, not a failed turn: that session is mid-run. Retry with
  // backoff, or steer the running turn (docs/design/session-control.md). Import the code, never copy it.
  if (e.type === "failed" && e.code === SESSION_BUSY_CODE) queueOrSteer();
}

// (2) buffered JSON — one question, one answer
import { collect } from "@fastagent-sh/fastagent";
const { text } = await collect(agent.invoke({ session: "u1" }, { text: "hi" }));
// `collect` throws AgentFailure on a failed turn, and errors if the stream has no terminal event.

// (3) HTTP/SSE — createInvokeHandler is a Fetch handler: mount it in any host route
import { createInvokeHandler } from "@fastagent-sh/fastagent";
const handler = createInvokeHandler(agent);   // (Request) => Promise<Response>; POST {session,text} → SSE
// Standalone it checks the method, requires content-type: application/json, and caps the body. It sends
// NO CORS headers — mounted in your app, who may call it cross-origin is your middleware's decision.
```

### The whole agent, as a service

The handler above serves `invoke` only. To mount the **whole** agent — every channel it declares,
its control plane, health — open the directory as a service:

```ts
import { nodeListener, createAgentService } from "@fastagent-sh/fastagent";

const service = await createAgentService("./my-agent");
app.use("/agent", nodeListener(service.handler));   // channels + control plane + health
await service.ready;      // long connections up; rejects if one cannot come up
// ...
await service.close();    // stops long connections and schedules
```

`createAgentService` is the assembly `fastagent dev`/`start` perform, minus the process: no port is
bound, no signal handlers are installed, nothing calls `process.exit`. With `sessionControl` on,
`service.controlPrefix` names the prefix the plane owns (`/control`) so your app can route around it.

**Nothing fastagent serves is authenticated** — `POST /invoke` and `/control/*` alike. Mount the handler behind
your own middleware. The cross-origin default is `*`: any page your users visit can call it and read the reply
unless you set `http.cors` to your front end's origin.

Pass `{ signal }` to bind its lifetime to something you already own.

### Mounting a single handler

The Fetch handler mounts wherever your host speaks `(Request) => Response` — and `nodeListener` bridges hosts that speak Node's `(req, res)`. It does not start a server: your app keeps its own, and fastagent becomes routes on it.

> **Mount before your body parser.** A body parser registered ahead of the mount consumes the request stream, and
> webhook channels verify signatures over the raw body:
>
> ```ts
> app.use("/agent", nodeListener(handler));  // first: fastagent takes these requests
> app.use(express.json());                   // then: parses everything else as usual
> ```
>
> Scoping the parser (`app.use("/other", express.json())`) works too. Getting it wrong is logged with this fix.

```ts
// Next.js App Router — app/api/chat/route.ts
export const POST = handler;

// Hono — c.req.raw is a Web Request
app.post("/chat", (c) => handler(c.req.raw));

// Express — nodeListener bridges (req, res) to the Fetch handler. It reads the RAW body
// stream, so mount it BEFORE any body parser (see the note below).
import { nodeListener } from "@fastagent-sh/fastagent";
app.post("/chat", nodeListener(handler));

// Fastify — same bridge on the raw req/res: keep the body stream unread, hijack the reply
app.register(async (scope) => {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  scope.post("/chat", (req, reply) => {
    reply.hijack();
    nodeListener(handler)(req.raw, reply.raw);
  });
});

// Bun
Bun.serve({ port: 8787, fetch: (req) =>
  new URL(req.url).pathname === "/chat" ? handler(req) : new Response("not found", { status: 404 }) });

// Plain Node (no native Fetch routing) — the built-in server
import { createAgentService, serveNode } from "@fastagent-sh/fastagent";
serveNode(handler, { port: 8787 });                    // just the invoke route
// ...or the whole agent, channels and all:
serveNode((await createAgentService("./my-agent")).handler, { port: 8787 });
```

Cancellation, backpressure, and a body cap are native to the web-stream primitives: a client disconnect cancels the underlying invoke. Concurrent requests on the **same** session fail fast — the second receives `failed{session busy}`.

## 3. Tier 1 vs Tier 2

The common path is three concrete fields. The engine ports are optional injection points you reach for only when you need them — defaults run out of the box.

```ts
createPiAgent({
  model: "openai-codex/gpt-5.5",   // Tier 1: which model (spec string)
  instructions: "…",               // Tier 1: the system prompt
  tools: [/* defineTool(...) */],  // Tier 1: capabilities
  skills: [/* … */],               // optional: on-demand skill files

  // ── Tier 2: injectable ports (default values run fine) ──
  sessions,   // PiSessionRecordStore  — persistence (default: in-memory)
  env,        // ExecutionEnv    — supplies cwd at L1; definition IO at L2
  lease,      // Lease           — concurrency floor (default: in-process fail-fast)
  providers,  // Provider[]      — your own model source (see §5)
});
```

| Port | Default | Reach for it when |
|---|---|---|
| `sessions` | `piInMemorySessionRecordStore()` (lost on restart) | `piSessionRecordStore({ dir })` for restart-surviving continuity, or your own `PiSessionRecordStore` |
| `env` | `process.cwd()` at L1; local `NodeExecutionEnv` at L2 | supplies cwd at L1; reads persona/skills at L2; not a sandbox |
| `lease` | `inProcessLease()` | a distributed lock across instances (implement `Lease`) |
| `providers` | built-in providers | your own gateway / self-hosted endpoint (see §5) |

`env` governs definition loading only. The coding tools and your `tools/` use the local process directly, so `env`
is not a sandbox; to isolate an agent, constrain its whole process.

## 4. Auth

Credentials resolve from a **credentials file**, then **env vars** (e.g. `ANTHROPIC_API_KEY`).

- `createPiAgentFromDir` (what `dev`/`start` use) and `createPiAgentFromDefinition(dir)` read
  `<agent dir>/.secrets/auth.json` (`FASTAGENT_SECRETS_DIR` moves it), and fall back to the global
  `~/.fastagent/.secrets/auth.json` for any provider the project file lacks.
- `createPiAgent` and `createPiModels` read the global file.
- Every opener accepts an explicit `authPath`, which then is the only file read.

To check what's in effect: `probeAuthSource(createPiModels({ authPath }), "openai-codex/gpt-5.5")` returns the resolved source label — `"OAuth"` for a stored OAuth credential (what a logged-in `openai-codex` user sees), `"stored credential"` for a stored API key, an env-var name like `"ANTHROPIC_API_KEY"`, or `undefined`.

There is no `apiKey` option: put keys in the credentials file or the environment. For your own endpoint, see
`providers` below.

## 5. Your own model source: `providers`

> Reach for this only when the provider needs **code**. An endpoint that is just a URL, a key and some
> model ids is data: declare it in the agent's own `models.json` and every path — `dev`, `start`,
> `invoke`, `chat`, `deploy`, and L2 embedding — picks it up with no wiring. See
> [Custom model endpoints](configuration.md#custom-model-endpoints).

When your model source needs per-request logic (minting or rotating a token, calling an auth service), register
it as a provider; a `model` spec selects it by id.

```ts
import { createPiAgent } from "@fastagent-sh/fastagent";
// Both come from pi-ai: the provider factory and the wire-protocol impl (reuse, don't reimplement).
import { createProvider } from "@earendil-works/pi-ai";
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

`providers` override built-ins with the same id. A same-id entry in the agent's `models.json` overrides an injected
provider, so use a distinct id when you want both.

## How embed and CLI relate

`fastagent dev` / `start` are `createPiAgentFromDir` plus process concerns (`.env`, proxy, watch, serve). The agent
they serve is the one `createPiAgentFromDefinition` returns when embedding.

Subpaths: `/core` (the contract and channel kit, no third-party packages), `/node` (`mountAgentService`,
`serveNode`, `nodeListener`), `/session` (the control-plane contract), `/pi` (the pi assembly). The root entry
re-exports all of them.

## Where next

- [SPEC](SPEC.md) — the Agent Handler contract the whole thing rests on.
- [quickstart](quickstart.md) — the CLI path (`init` / `dev` / `start`).
- [core design](design/core.md) — the assembly ladder (L0–L2), the four-segment prompt assembly, and the N × M × K layering.
