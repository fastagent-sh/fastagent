---
title: Embedding
description: "Run a FastAgent inside your Node backend or desktop app behind your own authentication, database, and routes."
status: current
---

# Embedding

Embed a compiled FastAgent directly in your Node backend or desktop application when you want your own auth, user model, database, and UI—while getting durable sessions, crash recovery, streaming, and tool execution out of the box.

```bash
npm i @fastagent-sh/fastagent       # Node ≥ 24.15
```

Compile your agent into a standalone npm package with `fastagent build` ([Packaging, Distribution & CI/CD](packaging-and-ci.md)), then import it from your application.

## Choose your embedding pattern

| Scenario | Recommended pattern |
| --- | --- |
| **Custom app routes / UI behind your own auth** | Call `openAgent()` and invoke `agent.messages.stream`, `agent.messages.send`, or `agent.invoke` directly from your route handlers. |
| **Hosting multiple tenant instances in one Node process** | Open one shared pool with `openPostgresDatabase()` and pass it to each `openAgent({ name, database })`. |
| **Exposing the standard `/v1` Agent API inside an existing web server** | Call `const service = await agent.serve({ apiKeys })` and mount `service.fetch` in Next.js, Hono, Express, or Fastify. |
| **Local desktop application** | Open with an app-owned `root`, populate model pickers from `agent.info().models`, and handle `info().unusableDefault` gracefully. |

## 1. Open the agent

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot"; // built by `fastagent build`

const agent = await openAgent(copilot, {
  root: "/var/lib/myapp/copilot",
  secrets: {
    ANTHROPIC_API_KEY: vault.read("anthropic"),
    LINEAR_API_KEY: vault.read("linear"),
  },
  env: baseEnv(process.env), // PATH, HOME, locale, and proxy for agent subprocesses
  model: "anthropic/claude-sonnet-4-6",
});

// On shutdown: stops any served HTTP endpoints and releases storage locks/leases
await agent.close();
```

Key options on `openAgent(definition, options)`:

- **`root` (required, absolute):** Agent working directory; local SQLite state lives under `<root>/.state/`.
- **`name`:** Instance name (one path segment). Required when using PostgreSQL (`database` or `secrets.FASTAGENT_DATABASE_URL`).
- **`secrets`:** The sole environment-value source for `needs()`, MCP `${VAR}` placeholders, env-based model provider keys, and `OTEL_*` tracing config. `openAgent` never reads `process.env`, `.secrets/`, or `~/.fastagent` (model provider credentials may also come from the instance's own durable credential store via `/v1/auth/*` / `service.auth`, or `<root>/.state/auth.json`).
- **`env`:** Base environment for subprocesses the agent spawns (`bash`, skill scripts, stdio MCP servers). Defaults to empty; pass `baseEnv(process.env)` for standard `PATH`, `HOME`, locale, and proxy settings. Pass `OTEL_*` variables in `secrets` (not `env`) so agent subprocesses cannot read collector credentials.
- **`model`:** Optional `provider/modelId` override over `fastagent.config.ts`.
- **`harness` / `sandbox`:** Optional `"pi-durable"` (default) or `"dsh"` (requires `@fastagent-sh/harness-dsh`), with `sandbox: "workspace" | "read-only" | "off"` on `dsh`.
- **`database`:** PostgreSQL descriptor (`{ url }`, `openPostgresDatabase(...)`, or `dsqlDatabase({ endpoint })` from `@fastagent-sh/agentcore`).

### Hosting multiple instances on one PostgreSQL pool

First choose the right multi-tenant pattern for your product:

| Multi-tenant pattern | When to use it | How you wire it |
| --- | --- | --- |
| **Shared-key SaaS copilot (1 `openAgent()` instance)** | All tenants share the same model API keys, MCP servers, and tool definitions (`codingTools: false`) | Open **one** `openAgent()` per process, authorize `sessionId` ownership in your backend routes, and call `sessionIdOf(api, context)` inside custom tools to look up the owning tenant. Zero per-tenant instance cache needed. |
| **BYOK / tenant-isolated SaaS (1 `openAgent()` per active tenant)** | Tenants bring their own API keys (`secrets`), tenant-scoped MCP servers, or require PostgreSQL instance-level storage partitioning | Share one `openPostgresDatabase()` pool and pass it to each `openAgent({ name, database })`. |

When one process hosts multiple isolated instances over PostgreSQL (or Aurora DSQL), share a single connection pool with `openPostgresDatabase`:

```ts
import { baseEnv, openAgent, openPostgresDatabase } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot";

const db = openPostgresDatabase({ url: process.env.DATABASE_URL! }, { max: 20 });

const tenantA = await openAgent(copilot, {
  root: "/var/lib/myapp/tenants/a",
  name: "tenant-a",
  database: db,
  secrets: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  env: baseEnv(process.env),
});

// Schema migration runs once; closing one agent releases only its lease, keeping `db` open.
await tenantA.close();
// Close the shared pool once during process shutdown.
await db.close();
```

#### Responsibility boundary (why there is no built-in `AgentPool`)

FastAgent is intentionally a **single-instance data plane**: `openPostgresDatabase()` and `openAgent()` own the hard distributed storage primitives (shared pooling, one-time migration, batched lease renewals, single-writer fencing, cooperative idle handoff, and `ready()` / `busy()` / `closed` lifecycle signals), while your host owns multi-tenant orchestration (tenant-to-secret resolution, sticky routing across replicas, active SSE/WebSocket tracking, and memory/MCP eviction budgets). Keeping orchestration in your host avoids forcing a generic tenancy or secret-resolver abstraction onto your backend.

Operational notes for multi-tenant pools:
- **Coalesced lease heartbeats:** Instances sharing an `openPostgresDatabase()` handle automatically batch their PostgreSQL lease renewals into one query per tick (up to 500 instances per query) instead of one query per tenant.
- **Cooperative idle handoff & passive SSE streams:** During rolling deploys or multi-replica traffic shifts, if another process requests an instance whose current holder is idle (`!agent.busy()`), the idle holder yields cleanly on its next renewal tick instead of blocking until lease expiry. Active turns and remote auth flows (`agent.busy() === true`) are never interrupted. Note that handoff checks only `agent.busy()`, not passive `sessions.events()` subscribers: if a browser holds an idle SSE stream when its tenant moves to another replica, that stream ends and the client should reconnect with `?after=<entryId>` / `Last-Event-ID`.
- **Same-process `close() -> reopen` serialization:** Calling `openAgent()` for a SQLite file or PostgreSQL instance whose previous handle in the same process is mid-`close()` (explicit `close()`, cooperative idle handoff, or lease-loss teardown) automatically waits for that close to finish before acquiring the lock or lease.
- **Host cache checklist** (reference implementation in [`examples/saas-copilot/server.ts`](../examples/saas-copilot/server.ts)):
  1. **Deduplicate concurrent opens** per tenant by caching the in-flight `openAgent()` promise.
  2. **Check `agent.ready()` on cache hits:** `ready()` flips to `false` synchronously as soon as `close()` or cooperative handoff starts, before `agent.closed` resolves asynchronously; drop `!agent.ready()` entries and call `openAgent()` directly (no manual per-tenant `closing` lock map is needed).
  3. **Evict on `agent.closed`:** remove the cache entry when `agent.closed` settles (covers both cooperative handoff and unexpected lease loss).
  4. **Bound memory & MCP clients:** evict long-idle handles (`!agent.busy()` and no active host streams) via TTL/LRU, prefer sticky routing by tenant ID across replicas, and await all cached and evicted `close()` promises before `db.close()` on shutdown.

## 2. Call the Agent API

`LocalAgent` exposes the full [Agent API](agent-api.md) (`sessions`, `messages`, `invoke`, `invokeStream`) plus lifecycle helpers:

```ts
// One-shot or caller-named conversation
const digest = await agent.invoke(
  { conversation: "daily-digest", content: "/daily-digest" },
  { wait: 120 },
);

// Interactive session with live streaming
const session = await agent.sessions.create();
for await (const event of agent.messages.stream({ sessionId: session.id, content: "hi" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
  if (event.type === "done") finish(event.message);
}
```

Lifecycle helpers on `LocalAgent`:
- **`agent.ready()` / `service.ready()`:** Returns `true` while the runtime can accept work, and flips to `false` synchronously as soon as shutdown starts (before async cleanup finishes). `GET /health` reflects this state (`200` / `503`) without exiting the host process.
- **`agent.busy()`:** Returns `true` while any message turn or remote auth flow is active (useful for graceful drain or scale-to-zero probes).
- **`agent.closed`:** Optional promise that resolves once cleanup completes after `close()` or a PostgreSQL single-writer lease loss.
- **`agent.close()`:** Closes any served HTTP endpoints and releases storage. Running turns are interrupted cleanly and resume on next open (call `agent.sessions.cancel(sessionId)` first to stop work permanently).

### Streaming to your own end users

Never send `FASTAGENT_API_KEY` to a browser. Authorize the user and their session id in your backend, then stream events directly:

```ts
import { AgentError, type MessageStreamEvent } from "@fastagent-sh/fastagent";

app.post("/chat/:session", requireUser, async (req, res) => {
  const sessionId = await sessionOfUser(req.user, req.params.session);
  const events = agent.messages.stream({ sessionId, content: req.body.text })[Symbol.asyncIterator]();
  // Refused sends reject on the first read—check before writing SSE headers.
  const first = await events.next().catch((error: unknown) => error);
  if (first instanceof AgentError) return res.status(409).json(first);

  res.setHeader("content-type", "text/event-stream");
  for (let next = first as IteratorResult<MessageStreamEvent>; !next.done; next = await events.next()) {
    res.write(`data: ${JSON.stringify(next.value)}\n\n`);
  }
  res.end();
});
```

## 3. Serve the HTTP Agent API

```ts
const service = await agent.serve({ apiKeys: [process.env.AGENT_API_KEY!] });

// Mount service.fetch inside your existing server, or bind a standalone port:
const port = await service.listen(8787);

// Closing the agent drains the HTTP server (500 ms) and releases storage
await agent.close();
```

Without `apiKeys`, `service.fetch` serves only `GET /health`. With `apiKeys`, it serves the full [Agent API](agent-api.md#http-binding) under `/v1`.

### Mounting `service.fetch` in web frameworks

`service.fetch` accepts a Web `Request` and returns a Web `Response`, routing on `/health` and `/v1/...`. Mount it under a stripped prefix. For Node `(req, res)` servers, bridge with `getRequestListener` from `@hono/node-server`.

> **Mount before any body parser.** A body parser registered ahead of the mount consumes the raw request stream before `service.fetch` can read it:
>
> ```ts
> app.use("/agent", getRequestListener(service.fetch, { overrideGlobalObjects: false })); // first
> app.use(express.json()); // second
> ```

```ts
const { fetch: handler } = service;

// Next.js App Router (app/agent/[...path]/route.ts)
const toAgent = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/agent".length);
  return handler(new Request(url, req));
};
export { toAgent as GET, toAgent as POST, toAgent as PATCH, toAgent as DELETE };

// Hono (mount strips the prefix automatically)
app.mount("/agent", handler);

// Express (mount before express.json())
import { getRequestListener } from "@hono/node-server";
app.use("/agent", getRequestListener(handler, { overrideGlobalObjects: false }));

// Fastify (keep body unread, hijack reply, strip prefix)
const listener = getRequestListener(handler, { overrideGlobalObjects: false });
app.register(async (scope) => {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  scope.all("/agent/*", (req, reply) => {
    reply.hijack();
    req.raw.url = req.raw.url!.slice("/agent".length);
    listener(req.raw, reply.raw);
  });
});
```

## 4. Isolation & open guarantees

- **Strict input boundary:** Apart from `FASTAGENT_LOG_LEVEL`, `openAgent` reads nothing from `process.env`, `.secrets/`, or `~/.fastagent`, and never mutates `process.env` or the built package. (Third-party cloud SDKs may still read their own ambient credential chains unless overridden.)
- **Fail fast at open:** A relative `root`, missing required `needs()` secret, held storage lock, missing `name` with PostgreSQL, or incompatible build format rejects `openAgent()` immediately with an actionable message.
- **Multi-user isolation:** One instance is one trust domain. Give users who must not see each other's data separate instances, or set `codingTools: false` in `fastagent.config.ts`, write custom tools that cannot access shared files/storage, and authorize every session id (including `forkFrom.sessionId`) in your backend.

## 5. Desktop hosts

When running agents inside a local desktop application:

- Pass an app-owned `root` so it never contends with a developer's `fastagent dev`.
- Read `agent.info().models` to populate model pickers (includes `contextWindow` and supported `thinkingLevels`).
- If `fastagent.config.ts` names a retired or renamed default model, `openAgent()` still opens with `info().defaultModel` omitted and `info().unusableDefault` explaining why; messages without an explicit model refuse with `missing_model`. Passing an invalid `options.model` directly to `openAgent()` fails at open.
- To upgrade to a new compiled build, `await agent.close()` and reopen the new build.
