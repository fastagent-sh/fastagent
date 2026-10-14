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

An agent is a thing with `invoke` and sessions ([SPEC v1](SPEC-v1.md)). Everything else is "how you get it" and "how
you consume it".

```ts
interface Agent {
  invoke(request: { sessionId?: string; prompt: { text: string }; idempotencyKey?: string }): AsyncIterable<InvokeEvent>;
  sessions: { create; list; get(sessionId: string): Session }; // read, follow, abort, rewind, compact, update, delete
  info(); models(); commands();
}
type InvokeEvent =
  | { type: "accepted"; sessionId: string; run: RunStatus }           // first: the run is recorded
  | { type: "rejected"; error: AgentError }                            // or first and only: nothing ran
  | { type: "message_delta"; runId: string; channel: "text" | "thinking"; delta: string } // live text
  | { type: "tool_started"; runId: string; toolCallId: string; name: string; args: Json }
  | { type: "entry"; entry: Entry }                                    // durable: messages, tool results, run_ended
  | /* tool_progress, retry_scheduled, state, serving_error */ …;
```

The stream ends after the run's `run_ended` entry, whose `outcome` says how it ended. `sessionId` is an opaque string
you choose; reuse it to continue a conversation. A message for a session that is running queues behind the run.
Stopping reading detaches; the run goes on, and `agent.sessions.get(id).abort()` stops it.

## 1. Get the agent (pick by what you have)

| You have | Use | Returns |
|---|---|---|
| An agent directory (`APPEND_SYSTEM.md` + `skills/` + `tools/` + config) | `createPiAgentFromDir(dir, { model? })` | `{ agent, definition, modelSpec, … }` — auto-discovers everything |
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

`model` is always a spec string; `fastagent models` (or `listModels`) lists the available ones. `instructions` IS the system prompt — verbatim, no harness identity prepended. The directory path instead has pi build its default prompt (or uses `SYSTEM.md` in its place), then adds `APPEND_SYSTEM.md`, the agent directory's `AGENTS.md` as project context, skills, and environment context. See [core design §2](design/core.md).

## 2. Consume the stream (three ways)

```ts
// (1) raw stream — render tokens as they arrive
for await (const e of agent.invoke({ sessionId: "u1", prompt: { text: "hi" } })) {
  if (e.type === "message_delta" && e.channel === "text") render(e.delta);
  if (e.type === "entry" && e.entry.kind === "run_ended") done(e.entry.data);
}

// (2) buffered JSON — one question, one answer
import { collect, RunNotCompleted } from "@fastagent-sh/fastagent";
const { text } = await collect(agent.invoke({ sessionId: "u1", prompt: { text: "hi" } }));
// `collect` throws AgentRejection (nothing ran), RunNotCompleted (the run ended otherwise; `.outcome` says how) or
// RunUnfinished (the stream stopped first).

// (3) HTTP/SSE — the agent's API as one Fetch handler: POST /invoke, /sessions/*, /agent/*
import { createAgentHandler } from "@fastagent-sh/fastagent";
const handler = createAgentHandler(agent);   // (Request) => Promise<Response>; `{ control: true }` adds /control/*
// It requires content-type: application/json on a body and caps it. It sends NO CORS headers — mounted in your app,
// who may call it cross-origin is your middleware's decision. Call it from another process with `connectAgent`.
```

### The whole agent, as a service

The handler above serves the agent's API only. To mount the **whole** agent — every channel it declares,
its API, health — open the directory as a service:

```ts
import { nodeListener, createAgentService } from "@fastagent-sh/fastagent";

const service = await createAgentService("./my-agent");
app.use("/agent", nodeListener(service.handler));   // channels + the agent's API + health
await service.ready;      // long connections up; rejects if one cannot come up
// ...
await service.close();    // stops long connections and schedules
```

`createAgentService` is the assembly `fastagent dev`/`start` perform, minus the process: no port is
bound, no signal handlers are installed, nothing calls `process.exit`. Like them, it enters the agent's
[environment](configuration.md#environment): the declared packages are installed where they have no install yet,
and put first on this process's `PATH`, which the agent's commands inherit, and an environment FastAgent
refuses fails the call. Two agents opened in one process share that `PATH`. `service.planes` says which of
the agent's HTTP planes it serves (`api`: `/invoke`, `/sessions`, `/agent`; `control`: `/control`), so your app
can route around them.

**Nothing fastagent serves is authenticated** — `POST /invoke` and `/control/*` alike. Mount the handler behind
your own middleware. The cross-origin default is `*`: any page your users visit can call it and read the reply
unless you set `http.cors` to your front end's origin.

Pass `{ signal }` to bind its lifetime to something you already own.

### Mounting a single handler

The Fetch handler mounts wherever your host speaks `(Request) => Response` — and `nodeListener` bridges hosts that speak Node's `(req, res)`. It does not start a server: your app keeps its own, and fastagent becomes routes on it. It routes on the request's path (`/invoke`, `/sessions/…`), so mount it under a prefix your host strips, or strip it yourself.

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
// Next.js App Router — app/agent/[...path]/route.ts: strip the prefix the route lives under
const toApi = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/agent".length);
  return handler(new Request(url, req));
};
export { toApi as GET, toApi as POST, toApi as PATCH, toApi as DELETE };

// Hono — mount strips the prefix
app.mount("/agent", handler);

// Express — nodeListener bridges (req, res) to the Fetch handler, and app.use strips the prefix. It reads the RAW
// body stream, so mount it BEFORE any body parser (see the note above).
import { nodeListener } from "@fastagent-sh/fastagent";
app.use("/agent", nodeListener(handler));

// Fastify — same bridge on the raw req/res: keep the body stream unread, hijack the reply, strip the prefix
app.register(async (scope) => {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  scope.all("/agent/*", (req, reply) => {
    reply.hijack();
    req.raw.url = req.raw.url!.slice("/agent".length);
    nodeListener(handler)(req.raw, reply.raw);
  });
});

// Bun — the handler is the whole server
Bun.serve({ port: 8787, fetch: handler });

// Plain Node (no native Fetch routing) — the built-in server
import { createAgentService, serveNode } from "@fastagent-sh/fastagent";
serveNode(handler, { port: 8787 });                    // just the agent's API
// ...or the whole agent, channels and all:
serveNode((await createAgentService("./my-agent")).handler, { port: 8787 });
```

Backpressure and a body cap are native to the web-stream primitives. A client disconnect detaches from the run, which
goes on; `POST /sessions/{s}/abort` or `/runs/{r}/cancel` stops it. A second message for a running session queues
behind the run, as `whenBusy` says.

## 3. Tier 1 vs Tier 2

The common path is three concrete fields. The harness ports are optional injection points you reach for only when you need them — defaults run out of the box.

```ts
createPiAgent({
  model: "openai-codex/gpt-5.5",   // Tier 1: which model (spec string)
  instructions: "…",               // Tier 1: the system prompt
  tools: [/* defineTool(...) */],  // Tier 1: capabilities
  skills: [/* … */],               // optional: on-demand skill files

  // ── Tier 2: injectable ports (default values run fine) ──
  sessions,   // PiSessionRecordStore  — persistence (default: in-memory)
  cwd,        // string          — working directory (default: process.cwd())
  providers,  // Provider[]      — your own model source (see §5)
});
```

| Port | Default | Reach for it when |
|---|---|---|
| `sessions` | `piInMemorySessionRecordStore()` (lost on restart) | `piSessionRecordStore({ dir })` for restart-surviving continuity, or your own `PiSessionRecordStore` |
| `cwd` | `process.cwd()` | tools should operate in another directory; it is not a sandbox |
| `providers` | built-in providers | your own gateway / self-hosted endpoint (see §5) |

`env` governs definition loading only. The coding tools and your `tools/` use the local process directly, so `env`
is not a sandbox; to isolate an agent, constrain its whole process.

## 4. Auth

Credentials resolve from a **credentials file**, then **env vars** (e.g. `ANTHROPIC_API_KEY`).

- `createPiAgentFromDir` (what `dev`/`start` use) and `createPiAgentFromDefinition(dir)` read
  `<agent dir>/.secrets/auth.json` (`FASTAGENT_SECRETS_DIR` moves it), and fall back to the global
  `~/.fastagent/.secrets/auth.json` for a provider the project authenticates no other way
  ([order](configuration.md#auth-and-secrets)).
- `createPiAgent` and `createPiModels` read the global file.
- Every opener accepts an explicit `authPath`, which then is the only file read.
- Every opener also accepts a `credentialStore` of your own (an OS keychain, Electron `safeStorage`), which replaces
  the credentials files, refreshes included. Env variables and `models.json` keys still apply, as with `authPath`.
  See [the store's contract](api-reference.md#config-and-models).

To check what's in effect: `probeAuthSource(createPiModels({ authPath }), "openai-codex/gpt-5.5")` returns the resolved source label — `"OAuth"` for a stored OAuth credential (what a logged-in `openai-codex` user sees), `"stored credential"` for a stored API key, an env-var name like `"ANTHROPIC_API_KEY"`, or `undefined` when nothing is configured. It rejects when resolving fails (a corrupt entry, a refresh the provider refused), with the reason.

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
