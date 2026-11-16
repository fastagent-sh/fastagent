---
title: Channel development
description: "Write a FastAgent channel: how it receives, what it is handed, its tools, verifying its platform, sessions, streaming answers, and packaging it."
status: current
---

# Channel development

A channel receives a platform's events, checks they come from that platform, and sends the agent messages through the
[Agent API](agent-api.md). It is a value declared under `channels` in `fastagent.config.ts`, written in your project or
installed as a package such as `fastagent-channel-acme`. To use the built-in ones, see [Channels](channels.md).

## The channel

A channel receives at the routes it returns, or over a connection it opens, typed with `defineChannel`:

```ts
// src/acme.ts
import { defineChannel } from "@fastagent-sh/fastagent";

export const acme = defineChannel({
  routes: ({ agent, sessionFor, turn }) => ({
    "POST /acme": async (req) => {
      const { chatId, text, messageId } = await verifyAndParse(req); // the platform's signature, checked first
      // Answered at once: a platform redelivers a webhook that gets no answer within seconds.
      turn(chatId, async () => {
        const sessionId = await sessionFor(chatId);
        const message = await agent.messages.send({ sessionId, content: text, idempotencyKey: messageId }, { wait: 600 });
        await replyTo(chatId, message.answer?.text ?? "Sorry, that did not work.");
      });
      return new Response(null, { status: 204 });
    },
  }),
});
```

```ts
// fastagent.config.ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { acme } from "./src/acme.ts";

export default defineAgent({ channels: { acme } });
```

What it is handed:

| | |
|---|---|
| `agent` | The [Agent API](agent-api.md), in process: besides `messages.send` and `messages.stream`, a channel reads a session (`sessions.entries`, `sessions.events`), finds the message a platform message became (`messages.get` by `idempotencyKey`) and stops the agent (`sessions.cancel`: the built-in channels map a user's "stop" onto it) |
| `sessionFor(key, { forkFrom? })` | The session the conversation `key` talks in: the one recorded, or a new one, created and recorded before it is returned. `forkFrom` answers what a new one forks from (a thread's room, say), asked only when `key` has no session yet. Calls for one key are taken one at a time, so two first messages of a new conversation get one session |
| `recordedSession(key)` | The session recorded for `key`, without making one: what a stop command asks of a place nothing was said in |
| `turn(place, work)` | `work` run after the route has answered, one at a time per place (a chat, a thread) in the order they arrived, and counted as work in flight, which `dev`'s restart waits for. It keeps no record: a turn the process stops before it runs is lost unless the platform delivers its event again, which the platform's message id as `idempotencyKey` makes safe |
| `beginWork()` | Count work the channel runs outside `turn` (a queue of its own, a reply still being written after its message ended) as work in flight, so `dev`'s restart waits for it; call the function it returns when the work ends |
| `stateDir` | The channel's own directory, `<state root>/channels/<its name>`, made at the mount, for what it must keep (the first-party channels keep each turn there before they answer the platform, so none is lost) |

A **long connection** is `{ connect(ctx, signal) }`, returning `{ ready, closed }`: `ready` settles once
connected (and must settle even when aborted first), `closed` resolves on shutdown and rejects on a fatal failure. It
owns its reconnects.

**Routes** are `"/path"` (any method) or `"METHOD /path"`, matched literally. Two keys for one route refuse the start.
`HEAD` is answered from `GET`; a wrong method gets 405, an unknown path 404.

Keep module top-level code free of secrets and side effects: `info` and `build` load the configuration to inspect it.
Take credentials as options, through `needs`.

## Tools

A channel may give the agent tools: `tools: [{ name, description, parameters, execute }]`, offered as
`<channel name>_<name>`. `parameters` is a JSON Schema object the arguments are checked against;
`execute(args, { sessionId })` answers the text the model reads, `sessionId` being the session the call runs in. The
first-party channels give a `send` tool this way.

## Verify the platform

**Every request must be checked against the platform's credential** (a signature over the raw body, a secret header, a
token). Nothing else in front of the channel does it.

- Check before trusting any field, and compare secrets with `secretEquals(given, expected)`.
- Refuse signed timestamps older than a few minutes.
- A missing credential refuses the start (declare it with `needs`); never let a request through.

## Sessions and messages

`sessionFor(conversation)` gives each conversation (a chat, a thread, an issue) its session. Send each message with the
platform's delivery id as `idempotencyKey`: a redelivery then returns the message already sent. A message to a busy
session queues (`whenBusy: "steer"` hands it to the running work, `"reject"` refuses it).

Most platforms want a quick ACK: answer at once and do the work in `turn(conversation, async () => …)`. A turn is not
kept across a restart: what must not be lost goes in `stateDir`.

## A minimal adapter

This one answers in the HTTP response:

```ts
import { type RouteChannel, readBodyCapped, text } from "@fastagent-sh/fastagent";

export interface AcmeChannelOptions {
  secret: string;
  on(event: AcmeEvent): { conversation: string; text: string; deliveryId: string } | null;
}

// Policy options in, a channel out: the mount supplies its context.
export function acmeChannel(options: AcmeChannelOptions): RouteChannel {
  if (!options.secret) throw new Error("acmeChannel requires a non-empty secret");

  return {
    routes: ({ agent, sessionFor }) => ({
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

        const sessionId = await sessionFor(intent.conversation);
        // The delivery id as the idempotency key: a platform's redelivery returns the same message, not a second one.
        const message = await agent.messages.send(
          { sessionId, content: intent.text, idempotencyKey: intent.deliveryId },
          { wait: 120 },
        );
        if (message.status !== "completed") return Response.json(message, { status: 502 });
        return Response.json({ text: message.answer?.text ?? "" });
      },
    }),
  };
}
```

For chat, stream the answer as it is written. A refused send rejects the first read:

```ts
let answer = "";
for await (const event of agent.messages.stream({ sessionId, content: text, idempotencyKey: deliveryId })) {
  if (event.type === "delta" && event.channel === "text") {
    answer += event.text;
    await updateLivePreview(answer);
  } else if (event.type === "tool_started") {
    await updateLivePreview(`Running ${event.name}…`);
  } else if (event.type === "stream_error") {
    return sendError(event.error.message); // the message goes on; `messages.get` says how it ended
  } else if (event.type === "done") {
    const { status, answer: settled } = event.message;
    return status === "completed" ? sendFinal(settled?.text ?? answer) : sendError(`it ended ${status}`);
  }
}
```

Live deltas are best-effort; the `done` message's `answer` is the answer. Never show `thinking` deltas as the answer.

## Checklist

- Verify every request; cap bodies by bytes (`readBodyCapped`); answer 4xx to bad input.
- Use the delivery id as `idempotencyKey`, and `sessionFor` for the session.
- Handle every way a message ends, not only `completed`. Stop work with `sessions.cancel`.
- Log failures after the ACK.
- Import only `@fastagent-sh/fastagent`, never harness packages.

## Packaging

Publish the adapter with `@fastagent-sh/fastagent` as a peer dependency. The user declares it, passing its secrets
through `needs`:

```ts
import { defineAgent, needs } from "@fastagent-sh/fastagent";
import { acmeChannel } from "fastagent-channel-acme";

export default defineAgent({
  channels: {
    acme: needs(["ACME_WEBHOOK_SECRET"], ({ ACME_WEBHOOK_SECRET }) =>
      acmeChannel({
        secret: ACME_WEBHOOK_SECRET,
        on: (event) => ({ conversation: event.threadId, text: event.text, deliveryId: event.deliveryId }),
      }),
    ),
  },
});
```

## Testing

Test with a fake `Agent`, no network and no credentials: wrong method, bad signature, malformed JSON, body cap, an
ignored event answered 2xx, a good event sent with the right session and key, and a message that ends other than
`completed`.
