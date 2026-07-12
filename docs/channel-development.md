---
title: Channel development
description: "Build a FastAgent channel adapter: the adapter/glue split, the ChannelModule contract, packaging third-party channels, and testing guidance."
status: current
---

# Channel development

This guide is for developers building a new FastAgent channel adapter, either inside one workspace (`channels/<name>.ts`) or as a reusable package such as `fastagent-channel-slack`.

A channel is an ingress adapter. It receives an external event, decides whether to invoke the agent, and returns an HTTP response appropriate for that external system.

> This page is the AUTHOR's view — building an adapter. Using the existing channels is covered in [Channels](channels.md); the telegram channel's internal architecture (the reference for a stateful chat channel) is in [design/core.md §7](design/core.md).

## The two layers

Every channel has two layers:

| Layer | Owner | Example |
|---|---|---|
| Adapter | reusable package or first-party module | verify signature, parse body, ACK/retry rules, SDK calls |
| Glue | the agent workspace | map an event to a session and prompt |

For first-party channels, the adapter is `@fastagent-sh/fastagent/github` or `@fastagent-sh/fastagent/telegram`, and the glue is the scaffolded `channels/*.ts` file.

For a community channel, publish the adapter as a separate package and keep the user's glue in their workspace.

## Workspace discovery

A workspace channel is a module in `channels/` that default-exports a `ChannelModule`:

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

`fastagent dev` and `fastagent start` discover every `channels/*.ts|*.js|*.mjs`, call each module with the same assembled agent, and merge the returned route tables. The module factory must be synchronous and return a non-empty `Routes` object; async setup belongs inside the returned request handler. Any enabled channel that fails to load fails serving. Rename a file to `<name>.ts.disabled` when it should remain present but disabled.

Route keys are either:

```txt
/path              # any method
METHOD /path       # method-specific
```

A path overlap is a collision: `/webhook` conflicts with `POST /webhook`; `GET /webhook` and `POST /webhook` can coexist.

## Public channel-authoring kit

A channel adapter should depend on the engine-neutral `@fastagent-sh/fastagent/core` subpath:

| Export | Use |
|---|---|
| `Agent` | the agent type |
| `ChannelModule`, `Routes`, `ChannelHandler` | workspace module and route types |
| `collect` | buffer a turn into `{ text, data }` |
| `AgentFailure` | distinguish failed turns when using `collect` |
| `readBodyCapped` | read a request body with a byte cap |
| `text`, `textHeaders` | build plain status/error responses |

Do not import from `src/engines/*`, `@earendil-works/*`, or the pi subpath in a channel package. Channels consume the neutral Agent contract; `/core` also avoids loading the reference runtime.

## Minimal adapter

A reusable adapter is usually shaped like this:

```ts
import { AgentFailure, type ChannelModule, collect, readBodyCapped, text } from "@fastagent-sh/fastagent/core";

export interface AcmeChannelOptions {
  secret: string;
  on(event: AcmeEvent): { session: string; text: string } | null;
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
        const result = await collect(agent.invoke({ session: intent.session }, { text: intent.text }));
        return Response.json({ text: result.text, data: result.data ?? null });
      } catch (error) {
        if (error instanceof AgentFailure) {
          return Response.json({ error: error.details, retryable: error.retryable }, { status: 502 });
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
void collect(agent.invoke({ session }, { text })).then(
  () => console.error(`[acme] turn done: session=${session}`),
  (error) => console.error(`[acme] turn failed: session=${session}: ${String(error)}`),
);

return new Response(null, { status: 202 });
```

If you do this, document the limitation: post-ACK work is lost when the process exits unless your adapter or host persists intents and retries them.

## Streaming adapters

For chat systems, consume the raw event stream instead of `collect`:

```ts
let answer = "";
for await (const event of agent.invoke({ session }, { text })) {
  if (event.type === "text") {
    answer += event.delta;
    await updateLivePreview(answer);
  } else if (event.type === "tool_started") {
    await updateLivePreview(`Running ${event.name}…`);
  } else if (event.type === "failed") {
    await sendError(event.details);
    return;
  }
}
await sendFinal(answer);
```

Never fold `thinking` into the final answer. It is process/observability output, not user-facing answer text.

## Design checklist

A channel adapter should:

- fail closed when required secrets are missing,
- verify inbound requests before parsing trusted fields,
- cap request bodies by bytes, not `Content-Length`,
- return explicit 4xx responses for invalid input,
- surface post-ACK failures in operator logs,
- choose clear session IDs and document same-session behavior,
- tolerate `failed` terminal events,
- cancel or stop work when the client disconnects if the protocol supports it,
- avoid importing engine-specific code,
- keep provider SDK dependencies out of `@fastagent-sh/fastagent` unless the adapter is first-party and lightweight.

## Sessions and concurrency

Channels choose the `session` string. The engine enforces one in-flight turn per session. A concurrent turn on the same session fails fast with a retryable `failed` event.

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

The user's workspace installs the adapter and wires it in `channels/acme.ts`:

```ts
import { acmeChannel } from "fastagent-channel-acme";

export default acmeChannel({
  secret: process.env.ACME_WEBHOOK_SECRET ?? "",
  on: (event) => ({ session: event.id, text: event.text }),
});
```

Keep workspace-specific policy in the user's `channels/*.ts`; keep transport mechanics in the adapter package.

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
