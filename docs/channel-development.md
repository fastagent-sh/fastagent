---
title: Channel development
description: "Build a FastAgent channel adapter: route and long-connection contracts, the adapter/glue split, packaging, and testing guidance."
status: current
---

# Channel development

This guide is for developers building a new FastAgent channel adapter, either inside one agent (`channels/<name>.ts`) or as a reusable package such as `fastagent-channel-acme`.

A channel is an ingress adapter. It receives an external event, decides whether to invoke the agent, and returns an HTTP response appropriate for that external system.

> This page is the AUTHOR's view — building an adapter. Using the existing channels is covered in [Channels](channels.md); the telegram channel's internal architecture (the reference for a stateful chat channel) is in [design/core.md §7](design/core.md).

## The two layers

Every channel has two layers:

| Layer | Owner | Example |
|---|---|---|
| Adapter | reusable package or first-party module | verify signature, parse body, ACK/retry rules, SDK calls |
| Glue | the agent | map an event to a session and prompt |

For first-party channels, the adapter is `@fastagent-sh/fastagent/telegram`, `@fastagent-sh/fastagent/slack`, `@fastagent-sh/fastagent/feishu`, or `@fastagent-sh/fastagent/lark`, and the glue is the scaffolded `channels/*.ts` file.

For a community channel, publish the adapter as a separate package and keep the user's glue in their agent.

## Discovery

An agent channel is a module in `channels/` that default-exports either a route `ChannelModule` or a `LongConnectionChannelModule`. Route form:

```ts
import type { ChannelModule } from "@fastagent-sh/fastagent/core";

const channel: ChannelModule = ({ agent, stateRoot }) => ({
  "POST /slack": async (req) => {
    // parse request, call agent, return response; durable channel state goes under
    // `${stateRoot}/channels/<kind>` (never process.cwd())
    return new Response(null, { status: 204 });
  },
});

export default channel;
```

The mount context's `agent` is the [SPEC v1](SPEC.md) Agent: besides `invoke`, it reaches a session's live
run (the built-in channels map a user "stop" onto `agent.sessions.get(session).abort()`), its history and its
settings, whether or not this serve publishes the HTTP planes.

`fastagent dev` and `fastagent start` discover every `channels/*.ts|*.js|*.mjs`. A function export is called synchronously with the assembled agent and must return a non-empty `Routes` object; an object export must implement `{ name, connect(ctx, signal) }` and return `{ ready, closed }`. `ready` settles once the first usable connection is up; when the signal aborts before that, it must still settle (resolution then means cancellation — the server skips ready-side effects once the signal is aborted — and it must never hang). `closed` resolves after abort-driven shutdown and rejects on terminal transport failure. Long-connection adapters own reconnects and translate the framework's `AbortSignal` into their transport's close operation. Any enabled channel that fails to load fails serving. Rename a file to `<name>.ts.disabled` when it should remain present but disabled.

Deployment preflight also imports every enabled channel to inspect this function/object shape, but it does not call a route module or open a connection. Module top-level code must therefore be import-safe when runtime secrets are absent: capture options in the adapter factory, then validate credentials when the route module is activated or `connect()` runs. An import failure remains fatal because the same enabled channel would fail after deployment.

### Route keys

Route keys are either:

```txt
/path              # any method
METHOD /path       # method-specific
```

The path is matched **literally** — `:id` and `*` are ordinary characters, not patterns, so a key
containing them simply never matches.

Startup refuses only what would cost ANOTHER channel: two keys naming the same route (`/webhook` and
`POST /webhook`), a route inside a mounted prefix, and a path a URL rewrites (`/a/../x` is `/x`
spelled differently, so a collision check comparing strings would not see it). In each of those a
channel goes dark without its author having done anything wrong.

`HEAD` is answered from your `GET` route without the content (RFC 9110); write an explicit one only
if it should differ. Full rule: [API reference](api-reference.md#httphost-helpers).

A path overlap is a collision: `/webhook` conflicts with `POST /webhook`; `GET /webhook` and `POST /webhook` can coexist.

## Public channel-authoring kit

A channel adapter should depend on the harness-neutral `@fastagent-sh/fastagent/core` subpath:

| Export | Use |
|---|---|
| `Agent`, `InvokeEvent`, `Entry`, `RunOutcome` | the agent and what its runs report ([SPEC v1](SPEC.md)) |
| `ChannelModule`, `Routes`, `ChannelHandler` | HTTP route module and route types |
| `LongConnectionChannelModule`, `LongConnection` | long-connection module and lifecycle types |
| `collect` | buffer a run into its answer `{ sessionId, runId, text }` |
| `AgentRejection`, `RunNotCompleted`, `RunUnfinished` | why `collect` has no answer: refused, ended otherwise, or cut off |
| `readBodyCapped` | read a request body with a byte cap |
| `text`, `textHeaders` | build plain status/error responses |

Do not import from `src/harnesses/*`, `@earendil-works/*`, or the pi subpath in a channel package. Channels consume the neutral Agent contract, and `/core` loads no package beyond Effect and no Node built-in — which is what makes it the right dependency for a channel package.

## Minimal adapter

A reusable adapter is usually shaped like this:

```ts
import { type ChannelModule, collect, RunNotCompleted, readBodyCapped, text } from "@fastagent-sh/fastagent/core";

export interface AcmeChannelOptions {
  secret: string;
  on(event: AcmeEvent): { session: string; text: string; deliveryId: string } | null;
}

// Policy options in, a ChannelModule out: the framework (or an embedder) supplies { agent, stateRoot }.
export function acmeChannel(options: AcmeChannelOptions): ChannelModule {
  if (!options.secret) throw new Error("acmeChannel requires a non-empty secret");

  return ({ agent }) => ({
    // The route key owns the method: the router 405s anything else. Add an in-handler method guard
    // only as defense-in-depth for embedders who mount the bare handler outside the router.
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

      try {
        // The delivery id as the idempotency key: a platform's redelivery returns the same run, not a second one.
        const result = await collect(
          agent.invoke({ sessionId: intent.session, prompt: { text: intent.text }, idempotencyKey: intent.deliveryId }),
        );
        return Response.json({ text: result.text });
      } catch (error) {
        if (error instanceof RunNotCompleted) {
          return Response.json({ outcome: error.outcome }, { status: 502 });
        }
        throw error;
      }
    },
  });
}
```

This request/reply shape is appropriate when the external system expects the response body to contain the agent result.

## Fire-and-forget adapters

Many webhook providers require a quick ACK. In that case, return 2xx first and run the turn on the process event loop:

```ts
void collect(agent.invoke({ sessionId: session, prompt: { text }, idempotencyKey: deliveryId })).then(
  () => console.error(`[acme] turn done: session=${session}`),
  (error) => console.error(`[acme] turn failed: session=${session}: ${String(error)}`),
);

return new Response(null, { status: 202 });
```

If you do this, document the limitation: post-ACK work is lost when the process exits unless your adapter or host persists intents and retries them. Resending with the same `idempotencyKey` is safe: an accepted run is returned, not run again.

## Streaming adapters

For chat systems, consume the raw event stream instead of `collect`:

```ts
let answer = "";
for await (const event of agent.invoke({ sessionId: session, prompt: { text } })) {
  if (event.type === "rejected") return sendError(event.error.message);
  if (event.type === "message_delta" && event.channel === "text") {
    answer += event.delta;
    await updateLivePreview(answer);
  } else if (event.type === "tool_started") {
    await updateLivePreview(`Running ${event.name}…`);
  } else if (event.type === "entry" && event.entry.kind === "assistant_message") {
    answer = String((event.entry.data as { text?: string }).text ?? answer); // the settled text wins
  } else if (event.type === "entry" && event.entry.kind === "run_ended") {
    const { outcome } = event.entry.data as { outcome: RunOutcome };
    return outcome.status === "completed" ? sendFinal(answer) : sendError(`the run ended ${outcome.status}`);
  }
}
```

Live deltas are best-effort, and a stream joined late may carry none: the `assistant_message` entry is the answer.
Never fold `thinking` deltas into it. They are process/observability output, not user-facing answer text.

## Design checklist

A channel adapter should:

- fail closed when required secrets are missing,
- verify inbound requests before parsing trusted fields,
- cap request bodies by bytes, not `Content-Length`,
- return explicit 4xx responses for invalid input,
- surface post-ACK failures in operator logs,
- choose clear session IDs and document same-session behavior,
- handle every run outcome, not only `completed`,
- stop work it no longer wants with `runs.cancel` or `abort`: a Caller that stops reading only detaches,
- avoid importing harness-specific code,
- keep provider SDK dependencies out of `@fastagent-sh/fastagent` unless the adapter is first-party and lightweight.

## Sessions and concurrency

Channels choose the `sessionId`. A session runs one run at a time: a message that arrives while it is running queues
behind the run by default (`whenBusy: "steer"` joins the running run instead, `"reject"` refuses it as `busy`).

Good session choices depend on the external system:

| Channel type | Typical session |
|---|---|
| direct chat | user id or chat id |
| threaded chat | chat id + thread id |
| independent webhook delivery | delivery id |
| issue/PR automation | repository + issue/PR number, if turns should share context |

Use distinct sessions for independent work. Use shared sessions only when the agent should remember prior turns for the same subject.

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

The user's agent installs the adapter and wires it in `channels/acme.ts`:

```ts
import { acmeChannel } from "fastagent-channel-acme";
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel({
  secrets: ["ACME_WEBHOOK_SECRET"],
  channel: (secrets) =>
    acmeChannel({
      secret: secrets.ACME_WEBHOOK_SECRET,
      on: (event) => ({ session: event.id, text: event.text, deliveryId: event.deliveryId }),
    }),
});
```

Take the adapter's credentials as OPTIONS, never from `process.env` inside the package: the agent file
declares them with `defineChannel`, which is what lets `deploy` carry them and the serve refuse to
start without them.

Keep agent-specific policy in the user's `channels/*.ts`; keep transport mechanics in the adapter package.

## Testing guidance

At minimum, test:

- method rejection,
- missing/invalid signature,
- malformed JSON,
- body cap,
- ignored event returns 2xx,
- successful event invokes the agent with the expected session and prompt,
- failed agent turn is surfaced in the channel's expected way.

Use a fake `Agent` that yields deterministic events. Channel tests should not require real provider credentials or network access.
