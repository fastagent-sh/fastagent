---
title: Embedding
description: "Use FastAgent as a library: open an agent in your app, send it messages, serve it from your server, give it its credentials, and run it in a desktop host."
status: current
---

# Embedding

Run the agent inside your own app, behind your own auth. It is the same agent the CLI runs.

```bash
npm i @fastagent-sh/fastagent       # Node ≥ 24.15
```

Build the agent with `fastagent build`; your app imports the package that makes.

## 1. Open it

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import support from "@acme/support-agent"; // the default export of a package `fastagent build` made

const agent = await openAgent(support, {
  root: "/var/lib/myapp/support",
  secrets: { ZENDESK_TOKEN: vault.read("zendesk") }, // what the agent's code and model read by name
  env: baseEnv(process.env), // PATH, HOME, locale and proxy: what its commands start from; without it, nothing
  model: "openai/gpt-5.5",
});
// ...
await agent.close(); // on shutdown: releases the instance's storage
```

- `root` is absolute: the agent's working directory, with its state in `<root>/.state`.
- The agent reads only the `secrets` and `env` you give it, never your process's environment. `baseEnv(process.env)`
  passes `PATH`, `HOME`, locale and proxy.
- Opening refreshes the model lists (`offline: true` skips the network).
- One process opens an instance at a time. `close()` releases it; a running message is answered at the next open. To
  stop work for good, `agent.sessions.cancel(sessionId)` first.
- [MCP servers](mcp.md) read their `${NAME}` references from `secrets`.
- `database: { url: "postgres://…" }` keeps the sessions and the clock in PostgreSQL
  ([sessions in PostgreSQL](configuration.md#sessions-in-postgresql)), under the instance's `name`, which is then
  required; so does `secrets.FASTAGENT_DATABASE_URL`. To host several instances in one process over a single shared
  connection pool, open it once with `const db = openPostgresDatabase({ url }, { max: 20 })`, pass `database: db` to
  each `openAgent` (migration runs once, and each `agent.close()` releases only that instance's lease), and call
  `await db.close()` on shutdown. On Aurora DSQL, `dsqlDatabase({ endpoint })` from `@fastagent-sh/agentcore` gives
  the database descriptor (and can also be wrapped with `openPostgresDatabase`).
- [Run traces](configuration.md#run-traces) are exported when `secrets` holds `OTEL_EXPORTER_OTLP_ENDPOINT` (and the
  other `OTEL_*` variables). Pass them there, not in `env`: what is in `env` reaches the agent's commands.

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

Keep `session.id` to continue the conversation. Pass your request's id as `idempotencyKey` so a resend returns the same
message. Leaving the loop detaches; the agent goes on until `agent.sessions.cancel(sessionId)`. The calls are the
[Agent API](agent-api.md).

### Exposing it to your users

Do not give a browser the API key: it opens the whole instance. Write your own routes over these calls, behind your
auth. Results and events are JSON, so you can forward them, for example as Server-Sent Events:

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

**One instance is one trust domain**: the agent's tools can reach every session in it. Give users who must not see each
other an instance each ([security model](agent-api.md#security)).

## 3. Serve its schedules and the Agent API

```ts
const service = await agent.serve();
// mount service.fetch in your app (below), or give it a server of its own:
const port = await service.listen(8787);
// ...
await agent.close(); // closes the service, then releases the storage
```

- `service.fetch` answers `GET /health`. `serve({ apiKeys: [key] })` adds the Agent API
  under `/v1`, which another service calls with `connectAgent(url, { apiKey })` from
  `@fastagent-sh/client`.
- `agent.busy()` says whether a message or a schedule's fire is in flight in the process: for a platform that stops an
  idle machine, as AgentCore does. `serve({ alarm })` keeps one external alarm set for when the instance next needs a
  process, and `service.tick()` claims and runs what is due when that alarm wakes it.

### Mounting `fetch`

`service.fetch` takes a `Request` and returns a `Response`. It routes on the path (`/health`, `/v1/...`), so mount it
under a prefix your framework strips. On Node's `(req, res)`, bridge it with `getRequestListener` from
`@hono/node-server`.

> **Mount before your body parser.** A body parser registered ahead of the mount consumes the request stream, which
> the Agent API reads itself:
>
> ```ts
> app.use("/agent", getRequestListener(service.fetch, { overrideGlobalObjects: false })); // first
> app.use(express.json()); // then: parses everything else as usual
> ```
>
> Scoping the parser (`app.use("/other", express.json())`) works too.

```ts
const { fetch: handler } = service;

// Next.js App Router — app/agent/[...path]/route.ts: strip the prefix the route lives under
const toAgent = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/agent".length);
  return handler(new Request(url, req));
};
export { toAgent as GET, toAgent as POST };

// Hono — mount strips the prefix
app.mount("/agent", handler);

// Express — getRequestListener bridges (req, res) to the Fetch handler, and app.use strips the prefix. It reads the RAW
// body stream, so mount it BEFORE any body parser (see the note above). `overrideGlobalObjects: false` leaves this
// process's global Request and Response alone.
import { getRequestListener } from "@hono/node-server";
app.use("/agent", getRequestListener(handler, { overrideGlobalObjects: false }));

// Fastify — the same bridge on the raw req/res: keep the body stream unread, hijack the reply, strip the prefix
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

## 4. Credentials

The agent reads provider keys from `secrets` by their variable names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), and
nothing from the project's `.secrets/` or `~/.fastagent`, so a developer's own login never becomes your app's.

```ts
const agent = await openAgent(definition, { root, secrets: { ANTHROPIC_API_KEY: vault.read("anthropic") } });
```

A gateway or self-hosted model is a provider in the agent's config ([custom models](configuration.md#custom-models)).

## 5. What an open promises

- **Its inputs, and nothing else.** Of the process's environment FastAgent reads only `FASTAGENT_LOG_LEVEL`: no
  variable places, configures or serves the instance, and none reaches a process the agent starts. It reads no file its
  inputs do not name, the machine's model credentials included, and writes neither `process.env` nor the package. A
  model provider's SDK still reads its own credential chain.
- **Refusals at open, never later.** A relative `root`, a required secret without a value, a second open over the same
  state, and a definition built for another FastAgent format each refuse the open, naming what to fix.
- **What a started process gets**: `env`, the declared packages' commands ahead on its `PATH`, the declared secrets, a
  stdio MCP server's own `env`, and `GIT_CEILING_DIRECTORIES` at the workspace's parent.
- **`close()`** interrupts a running message as a process stop does: it is answered at the next open, unless
  `sessions.cancel` was stopping it.
- **`serve()`.** `close()` ends the API's event streams, gives requests in flight 500 ms, then stops the schedules.
- **Users kept apart are yours.** An app serving its own users over one instance sets `codingTools: false` in
  `fastagent.config.ts` (so the agent has no `read`, `write`, `edit` or `bash`), uses only tools that cannot reach
  the instance's storage or files, and checks every session id a request names, a fork's source included.

## 6. A desktop host

An app that runs agents for a person on their machine:

- Open with a `root` of your own to run beside `fastagent dev` on the same project. Each instance has its own
  sessions. Only one of them should `serve()`, or schedules fire twice; an instance nobody serves refuses `wake`.
- `agent.info().models` lists the models a session may use, with their context windows and thinking levels.
- A configured default model that the model lists no longer have (a provider retired it, a catalog update renamed it)
  does not stop the open: `info().defaultModel` is absent, `info().unusableDefault` gives the configured `spec` and the
  `reason`, and a message that names no model is refused `missing_model`. A `model` given to `openAgent` is stricter: one
  the lists do not have fails the open.
- A new agent version is a new build: `close()` and open it again.
- Agents in one process keep their secrets and packages apart, but share the process: one that crashes it crashes all.
