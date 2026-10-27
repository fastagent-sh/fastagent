---
title: Channel development
description: "Build a FastAgent channel adapter: route and long-connection contracts, verifying the platform, the conversation-to-session map, the adapter/glue split, packaging, and testing."
status: current
---

# Channel development

This guide is for developers building a new FastAgent channel adapter, either inside one agent
(`src/channels/<name>.ts`) or as a reusable package such as `fastagent-channel-acme`.

A channel is an ingress adapter. It receives an external event, verifies that it comes from its platform, decides
whether to send the agent a message, and returns an HTTP response appropriate for that external system.

> This page is the AUTHOR's view: building an adapter. Using the existing channels is covered in
> [Channels](channels.md); the first-party chat channels' internal architecture is in [design/core.md §7](design/core.md).

## The two layers

Every channel has two layers:

| Layer | Owner | Example |
|---|---|---|
| Adapter | reusable package or first-party module | verify signature, parse body, ACK/retry rules, SDK calls |
| Glue | the agent | map an event to a conversation and a message |

For first-party channels, the adapter is `@fastagent-sh/fastagent/telegram`, `/slack`, `/feishu`, or `/lark`, and the
glue is the scaffolded `src/channels/*.ts` file. For a community channel, publish the adapter as a separate package and
keep the user's glue in their agent.

## Discovery

An agent channel is a module of `src/channels/`, named by its file, that default-exports either a route
`ChannelModule` or a `LongConnectionChannelModule`, or `needs([...])` around one. Route form:

```ts
import type { ChannelModule } from "@fastagent-sh/fastagent/core";

const channel: ChannelModule = ({ agent, stateRoot }) => ({
  "POST /acme": async (req) => {
    // verify, parse, send the agent a message, return a response; durable channel state goes under
    // `${stateRoot}/channels/<kind>` (never process.cwd())
    return new Response(null, { status: 204 });
  },
});

export default channel;
```

The mount context's `agent` is the [Agent API](SPEC.md), in process: besides `invoke`, a channel reads a session
(`read`, `resume`), finds the message a platform message became (`getMessage` by `idempotencyKey`), forks a thread from
its room (`createSession({ from })`) and stops the agent (`abort`: the built-in channels map a user's "stop" onto it).

A function export is called with the context and must return a non-empty `Routes` object; an object export must
implement `{ name, connect(ctx, signal) }` and return `{ ready, closed }`. `ready` settles once the first usable
connection is up; when the signal aborts before that, it must still settle (resolution then means cancellation) and
must never hang. `closed` resolves after abort-driven shutdown and rejects on terminal transport failure.
Long-connection adapters own reconnects and translate the framework's `AbortSignal` into their transport's close
operation. A channel module that does not load refuses the start. Rename a file to `<name>.ts.disabled` to keep it
present but disabled.

`deploy`'s pre-flight and `add` build every channel to inspect this function/object shape without calling a route
module or opening a connection, with stand-ins for secrets that have no value there. Module top-level code must
therefore be import-safe when runtime secrets are absent: take credentials as options (or through `needs`), and use
them when the route module is called or `connect()` runs.

### Route keys

Route keys are either:

```txt
/path              # any method
METHOD /path       # method-specific
```

The path is matched **literally**: `:id` and `*` are ordinary characters, not patterns. Startup refuses two keys
naming the same route (`/webhook` and `POST /webhook`) and a path a URL rewrites (`/a/../x`). `GET /webhook` and
`POST /webhook` can coexist. `HEAD` is answered from your `GET` route without the content. A path that exists under
another method answers 405; an unknown path, 404.

## Verify the platform

**A channel MUST verify that a request comes from its platform**, with the credential the platform issued: a
signature over the raw body, a secret token header, a verification token. Nothing in front of the channel does it:
a serve has no authentication of its own, and its routes are the channels' ([security boundary](design/security-boundary.md)).
A channel that verifies nothing lets anyone who finds its URL send the agent a message, with the agent's full tools.

- Verify before parsing any field you trust.
- Compare secrets in constant time: `secretEquals(given, expected)` from `@fastagent-sh/fastagent/node`.
- Bound replays: a signed timestamp outside a few minutes is refused.
- Fail closed: a missing credential refuses the start (declare it with `needs`), never a request let through.

A platform's signature proves the platform, not the person: everyone who can message the bot is inside the agent's
trust domain.

## Public channel-authoring kit

A channel adapter depends on the harness-neutral `@fastagent-sh/fastagent/core` subpath:

| Export | Use |
|---|---|
| `Agent`, `InvokeRequest`, `SessionEvent`, `Entry`, `Outcome`, `DoneMessage` | the Agent API ([SPEC](SPEC.md)) |
| `stream` | send a message and read its answer as it is written |
| `ChannelModule`, `ChannelContext`, `Routes`, `ChannelHandler` | HTTP route module and route types |
| `LongConnectionChannelModule`, `LongConnection` | long-connection module and lifecycle types |
| `readBodyCapped` | read a request body with a byte cap |
| `text`, `textHeaders` | build plain status/error responses |

`secretEquals` is in `/node`, since it uses Node's constant-time comparison. Do not import from `src/harnesses/*`,
`@earendil-works/*`, or the `/pi` subpath in a channel package: `/core` loads no package beyond Effect and no Node
built-in.

## Sessions: the channel's map

The Agent names sessions; a channel keeps which session each of its conversations talks in (a chat, a thread, an
issue), in its own state under `ctx.stateRoot`. Create a conversation's session in one order: the session
(`createSession`), then the record in your map, then the message. A crash between the first two leaves a session
nothing refers to, which the retry does not reuse; no message is answered twice, since it is sent only once its
session is recorded.

| Channel type | Typical conversation |
|---|---|
| direct chat | user id or chat id |
| threaded chat | chat id + thread id (a new thread may fork its room's session) |
| independent webhook delivery | delivery id |
| issue/PR automation | repository + issue/PR number, if messages should share context |

A message that arrives while a session is busy queues behind the ones before it by default (`whenBusy: "steer"` hands
it to the agent at its next step instead, `"reject"` refuses it `busy`). Send each message with the platform's
delivery id as its `idempotencyKey`, so a redelivery returns the message already sent instead of a second one.

## Minimal adapter

A reusable adapter is usually shaped like this:

```ts
import { type ChannelModule, readBodyCapped, text } from "@fastagent-sh/fastagent/core";

export interface AcmeChannelOptions {
  secret: string;
  on(event: AcmeEvent): { conversation: string; text: string; deliveryId: string } | null;
}

// Policy options in, a ChannelModule out: the framework (or an embedder) supplies { agent, stateRoot }.
export function acmeChannel(options: AcmeChannelOptions): ChannelModule {
  if (!options.secret) throw new Error("acmeChannel requires a non-empty secret");

  return ({ agent, stateRoot }) => {
    const sessions = sessionMap(`${stateRoot}/channels/acme/sessions.json`); // yours: conversation → session id
    return {
      "POST /acme": async (req) => {
        const body = await readBodyCapped(req, 1 << 20);
        if ("tooLarge" in body) return text("payload too large\n", 413);
        if (!verify(req.headers, body.text, options.secret)) return text("invalid signature\n", 401);

        let event: AcmeEvent;
        try {
          event = JSON.parse(body.text) as AcmeEvent;
        } catch {
          return text("invalid json\n", 400);
        }
        const intent = options.on(event);
        if (!intent) return new Response(null, { status: 204 });

        const sessionId = await sessions.of(intent.conversation, async () => {
          const created = await agent.createSession();
          if (!created.ok) throw new Error(created.error.message);
          return created.sessionId;
        });
        // The delivery id as the idempotency key: a platform's redelivery returns the same message, not a second one.
        const sent = await agent.invoke({
          sessionId,
          content: [{ type: "text", text: intent.text }],
          idempotencyKey: intent.deliveryId,
        });
        if (!sent.ok) return Response.json(sent, { status: 503 });
        const end = await sent.wait();
        if (!end.ok || end.message.outcome.status !== "completed") return Response.json(end, { status: 502 });
        return Response.json({ text: end.message.answer?.text ?? "" });
      },
    };
  };
}
```

This request/reply shape is appropriate when the external system expects the response body to contain the answer.

## Fire-and-forget adapters

Many webhook providers require a quick ACK. In that case, send the message, return 2xx, and wait for its end apart:

```ts
const sent = await agent.invoke({ sessionId, content: [{ type: "text", text }], idempotencyKey: deliveryId });
if (sent.ok) {
  void sent.wait().then(
    (end) => console.error(`[acme] message ended: ${end.ok ? end.message.outcome.status : end.unfinished.reason}`),
    (error) => console.error(`[acme] waiting failed: ${String(error)}`),
  );
}
return new Response(null, { status: sent.ok ? 202 : 503 });
```

An accepted message is durable: the agent answers it after a restart too. What happens after it (delivering the answer
back to the platform) is yours to make durable: the first-party channels record each turn's intent before the ACK and
deliver the answer of a turn recovered after a restart.

## Streaming adapters

For chat systems, read the answer as it is written with `stream`:

```ts
import { stream } from "@fastagent-sh/fastagent/core";

const result = await stream(agent, { sessionId, content: [{ type: "text", text }], idempotencyKey: deliveryId });
if (!result.ok) return sendError("error" in result ? result.error.message : result.unknown.reason);
let answer = "";
for await (const event of result.events) {
  if (event.type === "message_delta" && event.channel === "text") {
    answer += event.delta;
    await updateLivePreview(answer);
  } else if (event.type === "tool_started") {
    await updateLivePreview(`Running ${event.name}…`);
  } else if (event.type === "done") {
    const { outcome, answer: settled } = event.message;
    return outcome.status === "completed" ? sendFinal(settled?.text ?? answer) : sendError(`it ended ${outcome.status}`);
  }
}
```

Live deltas are best-effort, and a stream joined late may carry none: the `done` message's `answer` is the answer.
Never fold `thinking` deltas into it.

## Design checklist

A channel adapter should:

- verify that every request comes from its platform, in constant time, before trusting a field,
- fail closed when required secrets are missing,
- cap request bodies by bytes, not `Content-Length`,
- return explicit 4xx responses for invalid input,
- send each message with the platform's delivery id as its `idempotencyKey`,
- keep its conversation → session map in its own state, created in the order session, record, message,
- surface post-ACK failures in operator logs,
- handle every message outcome, not only `completed`,
- stop work it no longer wants with `abort`: a Caller that stops waiting only detaches,
- avoid importing harness-specific code,
- keep provider SDK dependencies out of `@fastagent-sh/fastagent` unless the adapter is first-party and lightweight.

## Packaging a third-party channel

A reusable channel package should normally look like:

```jsonc
{
  "name": "fastagent-channel-acme",
  "type": "module",
  "peerDependencies": {
    "@fastagent-sh/fastagent": "^0.x"
  },
  "dependencies": {
    "@acme/sdk": "^1.0.0"
  }
}
```

The user's agent installs the adapter and wires it in `src/channels/acme.ts`:

```ts
import { needs } from "@fastagent-sh/fastagent";
import { acmeChannel } from "fastagent-channel-acme";

export default needs(["ACME_WEBHOOK_SECRET"], ({ ACME_WEBHOOK_SECRET }) =>
  acmeChannel({
    secret: ACME_WEBHOOK_SECRET,
    on: (event) => ({ conversation: event.threadId, text: event.text, deliveryId: event.deliveryId }),
  }),
);
```

Take the adapter's credentials as OPTIONS, never from `process.env` inside the package: the agent file declares them
with `needs`, which is what lets `deploy` carry them and the serve refuse to start without them. Keep agent-specific
policy in the user's `src/channels/*.ts`; keep transport mechanics in the adapter package.

## Testing guidance

At minimum, test:

- method rejection,
- missing/invalid signature,
- malformed JSON,
- body cap,
- ignored event returns 2xx,
- a successful event sends the agent the expected message, in the expected session, with the delivery id as its key,
- a message that ends other than `completed` is surfaced in the channel's expected way.

Use a fake `Agent` that answers deterministically. Channel tests should not require real provider credentials or
network access.
