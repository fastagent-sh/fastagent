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

Author tool schemas with the `z` re-exported from `@fastagent-sh/fastagent` (as above), not a separately installed `zod` — `defineTool` converts the schema with its own zod, so a single shared copy avoids version-skew surprises. Every type on this surface (`AgentTool`, `Skill`, `Session`, `Model`, …) is re-exported too, so you never import from `@earendil-works/*` (the one exception is a provider's wire-protocol `api`, see §5).

`model` is always a spec string; `fastagent models` (or `listModels`) lists the available ones. `instructions` IS the system prompt — verbatim, no engine persona prepended. The directory path instead assembles the pi base (optionally customized by `persona.md`), `AGENTS.md` project context, skills, and environment context. See [core design §2](design/core.md).

## 2. Consume the stream (three ways)

```ts
// (1) raw stream — render tokens as they arrive
for await (const e of agent.invoke({ session: "u1" }, { text: "hi" })) {
  if (e.type === "text") render(e.delta);
}

// (2) buffered JSON — one question, one answer
import { collect } from "@fastagent-sh/fastagent";
const { text } = await collect(agent.invoke({ session: "u1" }, { text: "hi" }));
// `collect` throws AgentFailure on a failed turn, and errors if the stream has no terminal event.

// (3) HTTP/SSE — createInvokeHandler is a Fetch handler: mount it in any host route
import { createInvokeHandler } from "@fastagent-sh/fastagent";
const handler = createInvokeHandler(agent);   // (Request) => Promise<Response>; POST {session,text} → SSE
```

### The whole agent, as a service

The handler above serves `invoke` only. To mount the **whole** agent — every channel it declares,
its control plane, health — open the directory as a surface:

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
`service.control` carries the plane's bearer token so you can hand a client access without the
CLI's `control.json` discovery file. Composing the same thing by hand
means assembling routes, mounts, schedules and long connections in the right order — and getting it
wrong is silent (a control plane that 404s while `control.json` advertises it, a schedule that never
fires).

Pass `{ signal }` to bind its lifetime to something you already own; `service.routes`/`service.mounts`
are there for a host that must re-wrap them before serving.

### Mounting a single handler

The Fetch handler mounts wherever your host speaks `(Request) => Response` — and `nodeListener` bridges hosts that speak Node's `(req, res)`. It does not start a server: your app keeps its own, and fastagent becomes routes on it.

> **Mount before your body parser.** Node's request is a one-shot stream, so `app.use(express.json())`
> registered *ahead* of the mount consumes it and nothing reaches the agent — and webhook channels
> verify signatures over the RAW body, which a re-serialised one would fail. Order is the whole fix:
>
> ```ts
> app.use("/agent", nodeListener(handler));  // first: fastagent takes these requests
> app.use(express.json());                   // then: parses everything else as usual
> ```
>
> Scoping the parser (`app.use("/other", express.json())`) works too. Get it wrong and the log says
> so, naming the fix rather than `Body is unusable`.

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
import { serveNode, router } from "@fastagent-sh/fastagent";
serveNode(router({ "POST /chat": handler }), { port: 8787 });
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
  env,        // ExecutionEnv    — engine environment (default: local Node cwd)
  lease,      // Lease           — concurrency floor (default: in-process fail-fast)
  providers,  // Provider[]      — your own model source (see §5)
});
```

| Port | Default | Reach for it when |
|---|---|---|
| `sessions` | `piInMemorySessionRecordStore()` (lost on restart) | `piSessionRecordStore({ dir })` for restart-surviving continuity, or your own `PiSessionRecordStore` |
| `env` | local `NodeExecutionEnv` (cwd) | filesystem/process IO for definition loading; not a sandbox |
| `lease` | `inProcessLease()` | a distributed lock across instances (implement `Lease`) |
| `providers` | built-in providers | your own gateway / self-hosted endpoint (see §5) |

`env` governs definition loading. It does NOT govern the coding tools (`read`/`grep`/`find`/`ls`/
`bash`/`edit`/`write`), which reach the local process directly, rooted at the workspace they were built
for; nor author-written `tools/`, which are code and can import anything. Injecting `env` therefore
does not isolate a directory agent — a sandbox has to constrain the process, and that adapter is
future work.

## 4. Auth

Auth never appears in your agent code. It resolves, in order, from a **credentials file** then **ambient env vars** (e.g. `ANTHROPIC_API_KEY`). The dir-aware rungs default it to the **project-level** `<agent dir>/.secrets/auth.json` (the dir resolves `FASTAGENT_SECRETS_DIR` > `<dir>/.secrets`): the directory opener (`createPiAgentFromDir`, i.e. `dev`/`start`) and `createPiAgentFromDefinition(dir)`. The dir-less `createPiAgent` / `createPiModels` default to the global `~/.fastagent/.secrets/auth.json`; all of them accept an explicit `authPath`. A server deploy that only sets an env key Just Works; a dev machine uses `fastagent login` (which writes the project-level file by default). There is no implicit fallback between the project and global files — each owns its own OAuth refresh lifecycle.

To check what's in effect: `probeAuthSource(createPiModels({ authPath }), "openai-codex/gpt-5.5")` returns the resolved source label — `"OAuth"` for a stored OAuth credential (what a logged-in `openai-codex` user sees), `"stored credential"` for a stored API key, an env-var name like `"ANTHROPIC_API_KEY"`, or `undefined`.

Static keys belong in the login file or the environment, not in code — there is no `apiKey` constructor option by design. The only model-source injection point is `providers` (next), for when the endpoint itself is yours.

## 5. Your own model source: `providers`

> Reach for this only when the provider needs **code**. An endpoint that is just a URL, a key and some
> model ids is data: declare it in the agent's own `models.json` and every path — `dev`, `start`,
> `invoke`, `chat`, `deploy`, and L2 embedding — picks it up with no wiring. See
> [Custom model endpoints](configuration.md#custom-model-endpoints).

When your model source needs per-request logic — minting or rotating a token, calling an auth service — register it as a provider; a `model` spec then selects it by id. This is the one case that touches the engine's provider layer — built-in providers cover everything else.

```ts
import { createPiAgent, createProvider } from "@fastagent-sh/fastagent";
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

`providers` are registered on top of the built-ins (a matching id overrides a built-in). Against the agent's own `models.json` the precedence is the other way round: an injected provider is the BASE and a same-id `models.json` entry composes over it, so the file wins. That is deliberate — where a deployed agent's traffic goes is a property of the definition, not of the program that embedded it — but it does mean a same-id entry silently replaces the endpoint you injected. Use a distinct id when you mean both to exist.

An "auth service" is modeled as a provider — its per-request credential logic lives in the provider's `auth.…resolve()`, not as a separate credential option.

## How embed and CLI relate

`fastagent dev` / `start` wrap the pi reference implementation's `createPiAgentFromDir` plus process side effects (`.env`, proxy, watch, serve). The agent the CLI serves is the **same** one `createPiAgentFromDefinition` hands you when embedding — single assembly source. What you iterate under `dev`, what `start` serves, and what you embed are identical.

For contract-only or channel code, import `@fastagent-sh/fastagent/core`; it does not load the pi
reference runtime. Pi-specific assembly is also available explicitly from `@fastagent-sh/fastagent/pi`.

## Where next

- [SPEC](SPEC.md) — the Agent Handler contract the whole thing rests on.
- [quickstart](quickstart.md) — the CLI path (`init` / `dev` / `start`).
- [core design](design/core.md) — the assembly ladder (L0–L2), the four-segment prompt assembly, and the N × M × K layering.
