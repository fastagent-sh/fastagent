---
title: Embedding
description: "Use FastAgent as a library: open an agent directory in your app, call the Agent API in process, put it on your own routes, and mount its channels in Next.js, Hono, Express, Fastify, Bun, or Node."
type: doc
status: current
---

# Embedding

Use FastAgent as a **library**: the agent is one capability inside a product you already have, in your own process,
behind your own auth, on your own host. For the CLI path (`init` / `dev` / `start`), see [quickstart](quickstart.md);
both run the **same** agent.

## Prerequisites

- **Node ≥ 24.15** (or Bun ≥ 1.4). Ships compiled JS + types; no build step for FastAgent itself.
- **Install as a dependency** of your app: `npm i @fastagent-sh/fastagent`. The agent directory has its own
  `package.json` too ([init](cli.md#fastagent-init)); keep the versions aligned.
- **Model credentials**: `fastagent login` in the agent directory (writes its `.secrets/auth.json`) or a provider API
  key in the environment (e.g. `OPENAI_API_KEY`). See [Auth](#4-auth).

## The one mental model

An agent is the [Agent API](design/agent-api.md): sessions the Agent names, messages whose end outlives whoever sent
them, and a durable history of entries. It is TypeScript, in process; its HTTP binding is not served yet.

```ts
interface Agent {
  info(): Promise<AgentInfo>;
  usage(): Promise<Usage>;
  sessions: { create, get, list, update, entries, events, cancel, compact, attachment };
  messages: {
    send(request: { sessionId: string; content: string | ContentPart[]; idempotencyKey?: string; whenBusy?: "queue" | "steer" | "reject" },
         options?: { wait?: number; signal?: AbortSignal }): Promise<Message>;
    stream(request, options?): AsyncIterable<MessageStreamEvent>; // the message, then its events through its done
    get(key, options?): Promise<Message>; // by its id or its key, with `wait` too
  };
}
```

`send` answers once the message is recorded, and with `wait` (seconds) once it has ended: its `status`, and its
`answer`. A message for a busy session queues behind the ones before it. A refused operation rejects with an
`AgentError`. See the [API reference](api-reference.md#the-agent-api).

## 1. Open the agent

```ts
import { openServing } from "@fastagent-sh/fastagent";

const opened = await openServing("./my-agent", { model: "openai-codex/gpt-5.5" });
const { agent } = opened;
// ...
await agent.close(); // on shutdown: releases the instance's storage
```

`openServing` is what `dev` and `start` run: it reads the definition (`SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`,
`src/`, `fastagent.config.ts`), builds its code with the secrets it declares, installs its declared
[environment](configuration.md#environment) where it has no install yet and puts it first on this process's `PATH`,
clones its content, and opens the instance's storage (`<agent dir>/.state/agent.sqlite`), which one process holds at a
time. Without a `model`, the config's is the default; with none at all the agent still opens, and a session needs a
model of its own (`sessions.create({ model })`, `sessions.update`) before a message is answered.

A definition is always a directory: the prompt is its `SYSTEM.md`, and its tools are modules of `src/tools/`. To
assemble one in code, write the directory.

## 2. Send a message

```ts
// One question, one answer.
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 120 });
if (message.status === "completed") reply(message.answer?.text);

// Its answer as it is written.
for await (const event of agent.messages.stream({ sessionId: session.id, content: "hi" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
  if (event.type === "done") finish(event.message);
}
```

Keep the session's `id` to continue the conversation. An `idempotencyKey` (your request's id) makes a resend return the
same message rather than a second one. Leaving the iteration detaches; the agent goes on, and
`agent.sessions.cancel(sessionId)` stops it.

### Putting it on your network

The Agent API's HTTP binding is not served yet. To give a browser or another service the agent, write the routes your
product needs over these calls, behind your own authentication. Every result and event is JSON, so you can send them on
as they are, for example as Server-Sent Events:

```ts
app.post("/chat/:session", requireUser, async (req, res) => {
  const sessionId = await sessionOfUser(req.user, req.params.session); // yours: which session this user may use
  const events = agent.messages.stream({ sessionId, content: req.body.text })[Symbol.asyncIterator]();
  // A refused send rejects the first read: answer it before the stream starts.
  const first = await events.next().catch((error: unknown) => error);
  if (first instanceof AgentError) return res.status(409).json(first);
  res.setHeader("content-type", "text/event-stream");
  for (let next = first as IteratorResult<MessageStreamEvent>; !next.done; next = await events.next()) {
    res.write(`data: ${JSON.stringify(next.value)}\n\n`);
  }
  res.end();
});
```

**An instance is one trust domain.** The agent's tools reach every session of its instance, whichever user asked, so
keeping users apart by session id works only for an agent whose tools reach neither its storage nor its files. Users
who must not see each other's conversations get an instance each
([security boundary](design/security-boundary.md#3-people-who-must-be-kept-apart)).

## 3. The whole agent, as a service

To serve the agent's channels and schedules from your app too, mount it:

```ts
import { mountAgentService, nodeListener, openServing } from "@fastagent-sh/fastagent";

const opened = await openServing("./my-agent");
const service = await mountAgentService(opened);
app.use("/agent", nodeListener(service.handler)); // the channels' routes + GET /health
await service.ready; // long connections up; rejects if one cannot come up
// ...
await service.close(); // stops long connections and schedules
await opened.agent.close();
```

`mountAgentService` is the assembly `dev`/`start` perform, minus the process: no port is bound, no signal handlers are
installed, nothing calls `process.exit`. Its handler answers only the channels' routes, each of which verifies its
platform, and `GET /health`. Pass `{ signal }` to bind its lifetime to something you already own.

### Mounting a handler

The Fetch handler mounts wherever your host speaks `(Request) => Response`, and `nodeListener` bridges hosts that speak
Node's `(req, res)`. It does not start a server: your app keeps its own. It routes on the request's path (`/telegram`,
`/health`), so mount it under a prefix your host strips, or strip it yourself.

> **Mount before your body parser.** A body parser registered ahead of the mount consumes the request stream, and
> webhook channels verify signatures over the raw body:
>
> ```ts
> app.use("/agent", nodeListener(service.handler)); // first: fastagent takes these requests
> app.use(express.json()); // then: parses everything else as usual
> ```
>
> Scoping the parser (`app.use("/other", express.json())`) works too. Getting it wrong is logged with this fix.

```ts
const { handler } = service;

// Next.js App Router — app/agent/[...path]/route.ts: strip the prefix the route lives under
const toAgent = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/agent".length);
  return handler(new Request(url, req));
};
export { toAgent as GET, toAgent as POST };

// Hono — mount strips the prefix
app.mount("/agent", handler);

// Express — nodeListener bridges (req, res) to the Fetch handler, and app.use strips the prefix. It reads the RAW
// body stream, so mount it BEFORE any body parser (see the note above).
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

// Plain Node — the built-in server
import { serveNode } from "@fastagent-sh/fastagent";
serveNode(handler, { port: 8787 });
```

## 4. Auth

`openServing` reads the agent's `.secrets/auth.json` (`FASTAGENT_SECRETS_DIR` moves it), the provider's environment
variable, and then the global `~/.fastagent/.secrets/auth.json` for a provider the agent authenticates no other way
([order](configuration.md#auth-and-secrets)).

- `authPath` names the one credentials file to read instead.
- `credentialStore` is a store of your own (an OS keychain, Electron `safeStorage`), which replaces the credentials
  files, refreshes included. Environment variables and a provider's own auth still apply.
- `opened.models.authStatus("openai-codex")` says what authenticates a provider, resolved as a message would:
  `{ source: "OAuth" }`, an environment variable's name, or no `source` with the `error` when resolving failed.
- `login({ provider, method, authPath | credentialStore, interaction })` signs a provider in from your own UI
  ([API reference](api-reference.md#models-and-sign-in)).

## 5. Your own model source

A gateway or a self-hosted model is a provider in the agent's `fastagent.config.ts` (`providers`), so every path
(`dev`, `start`, `invoke`, `deploy`, and your app) picks it up: see [custom models](configuration.md#custom-models).
Its `auth.apiKey.resolve()` runs per request, which is where a token you mint or rotate goes.

## How embed and CLI relate

`fastagent dev` / `start` are `openServing` plus `mountAgentService` plus process concerns (`.env`, the proxy, the dev
watcher, the port, the signal handlers). The agent they serve is the one `openServing` returns to your app.

Subpaths: `/core` (the Agent API's types and `AgentError`, the channel contract), `/node` (`mountAgentService`, `serveNode`,
`nodeListener`, content and authoring), `/pi` (`openServing`, `defineAgent`, the model environment). The root entry
re-exports all of them.

## Where next

- [Agent API](design/agent-api.md): the API the whole thing rests on.
- [API reference](api-reference.md): every export.
- [quickstart](quickstart.md): the CLI path (`init` / `dev` / `start`).
- [core design](design/core.md): how a directory is opened onto pi-durable.
