---
title: Agent API
description: "The one API every caller of a FastAgent agent uses, in process or over HTTP: sessions, messages and entries, what a message promises, watching a session, errors, and the HTTP routes."
status: current
---

# Agent API

Every caller of an agent uses one API: an app that embeds it, a program elsewhere, a client that shows conversations,
and FastAgent's own channels, schedules and `fastagent invoke`. It is the same in process and over HTTP:

```ts
import { connectAgent } from "@fastagent-sh/fastagent/client";

const agent = connectAgent("https://support.example.com", { apiKey: process.env.SUPPORT_AGENT_KEY! });
// in your own process instead: const agent = await openAgent(support, { root: "/var/lib/myapp/support" });

const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "Where is order 9231?" }, { wait: 120 });
console.log(message.status, message.answer?.text);
```

Every type, with every field, is in the package's declarations (`@fastagent-sh/fastagent`, `/client`), and over HTTP
in the OpenAPI document a served agent publishes at `/v1/openapi.json`. This page is what the types do not say.

## What it promises

- **One accepted message, one end.** A message is recorded before it is acknowledged, ends exactly once, and survives a
  restart.
- **Found again.** A caller that lost its connection gets its message, and its answer, by id or by its key.
- **Sent again without running twice.** A send repeated with the same key returns the same message.
- **Watched, and picked up again.** A caller sees the answer as it is written, and after a drop continues from the last
  entry it saw.

## The model

| | Is |
|---|---|
| **Agent** | One served agent, one trust domain. `info()` says what it offers (commands, tools, models), `usage()` what it has spent |
| **Session** | A conversation: its entries, its status (`idle` or `running`), its settings (`model`, `thinkingLevel`, `instructions`, `tools`). The agent names it |
| **Message** | One thing a caller sends into a session, from acceptance to its end: a `status`, and its `answer` |
| **Entry** | One durable record of a session's history: `user`, `assistant`, `tool_result`, `compaction`. A fork shares its source's entries, ids included |

```
session s1
├─ message m1 "Where is order 9231?"   completed, answer = e4
│    e1 user · e2 assistant (calls a tool) · e3 tool_result · e4 assistant (the answer)
├─ message m2 "And the refund?"        running
└─ message m3 "Thanks"                 queued, behind m2
```

Watch a **session** to see everything in it; check a **message** to learn what became of one send. Several callers
may write into one session, so the session's status says it is busy, not whether *your* message was answered.

## Operations

| Operation | Does |
|---|---|
| `info()`, `usage()` | What the agent offers; what the instance has spent |
| `sessions.create({ model?, …, forkFrom? })` | A new session, or a fork: the source's entries up to `entryId`, its settings, none of its messages |
| `sessions.get`, `sessions.list` | A session as it is now; every session, most recently active first, in pages |
| `sessions.update` | Change its settings from its next model request; `null` clears one |
| `sessions.entries` | One page of history, the newest page first, then `prev` and `next` |
| `sessions.events` | Watch it ([below](#watching)) |
| `sessions.cancel` | Stop everything it is doing; answers once the stop is recorded, with the messages it stopped |
| `sessions.compact` | Summarize older entries now; the summary arrives as a `compaction` entry |
| `sessions.attachment` | The bytes of an image an entry refers to |
| `messages.send` | Send a message; answers once it is recorded, or with `wait` (seconds) once it has ended |
| `messages.stream` | Send a message and receive it as it is written |
| `messages.get` | A message by id or by its key, with `wait` too |

A `signal` lets go of a wait or a stream, never of the work: the message goes on. Only `cancel` stops the agent. A
`wait` is an upper bound: the answer may come before the message ends, so check `status`.

## Sending

**Content** is text, or text and images; a string is one text part. A message starting with `/<name>`, for a name in
`info().commands`, runs a prompt template or `/skill:<name>`; its `user` entry keeps the text as sent.

**Keys.** Give a send an `idempotencyKey` (your request's id), unique within the session. A send with a key the session
has seen returns that message and records nothing. A send that may have been recorded but could not be confirmed
rejects `unconfirmed`: send it again with the same key to find out. `connectAgent` gives a send without a key one of
its own.

**A busy session.** `whenBusy` decides what a message that arrives while the agent works is:

| `whenBusy` | Then |
|---|---|
| `queue` (default) | Waits its turn |
| `steer` | Handed to the running work, taken at its next step |
| `reject` | Refused: `busy`, `details.reason: "running"` |

**How a message ends:**

| Status | Means | `answer` |
|---|---|---|
| `completed` | Answered | The `assistant` entry it stopped on |
| `incomplete` | Cut off at the model's token limit | The cut-off reply |
| `failed` | Could not be answered: `error` says why (`missing_model`, `auth_required`, `model_error`, `internal`) | None |
| `canceled` | `cancel` stopped it, or withdrew it while queued | None |

Until then it is `queued` or `running`. A process that stops does not lose it: it is answered after the restart, and a
tool cut off by the restart is not run again unless it says that is safe. The agent never sends a message again on its
own.

## Watching

`sessions.events(sessionId, { after })` delivers, in order:

1. **Replay:** the entries after the entry `after` names, every entry with `after: "start"`, none without `after`.
2. **Snapshot:** one `state` event with the session as it is now, including the `reply` being written.
3. **Live:** everything that happens next, with no gap. A message's `done` comes before the next message's `user`
   entry.

| Event | Carries |
|---|---|
| `entry` | A durable entry |
| `state` | The session |
| `delta` | Text added to the reply being written; `channel: "thinking"` is reasoning, never part of the answer |
| `tool_started`, `tool_progress` | A running tool's call, then its latest status line |
| `retrying` | A pause while a model call waits to be tried again |
| `done` | A message that has ended |
| `stream_error` | The stream cannot go on (the message does) |

After a drop, open it again with `after` set to the last entry you received. Deltas are live only: a caller that
attaches mid-answer shows `state.session.reply` and appends the deltas after it.

`messages.stream` sends a message and delivers a `message` event with it as recorded, then its own events from its
`user` entry through its `done`. A send with a key the session has seen delivers that message from wherever it is.

## Errors

Every operation answers or rejects with an `AgentError`: `code`, `message`, `retryable`, `details`.

| Code | When | Retryable | HTTP |
|---|---|---|---|
| `invalid_request` | A malformed request, or a limit exceeded (`details.reason: "too_large"` for a body too large) | no | 400, 413 |
| `unauthorized` | No key, or a wrong one (HTTP only) | no | 401 |
| `not_found` | An unknown session, message, fork source or cursor | no | 404 |
| `busy` | `running`: refused by a busy session; `queue_full`: the session's queue is full; `capacity`: the process holds all it can | yes | 409; 429 and 503 with `Retry-After` |
| `missing_model` | The session names no model the agent has | no | 409 |
| `missing_tool` | The session names a tool the agent no longer has | no | 409 |
| `unconfirmed` | A send may have been recorded and could not be confirmed | no | 500 |
| `unavailable` | The agent cannot answer now, and the same request is safe to send again | yes | 503 with `Retry-After` |
| `internal` | Anything else | no | 500 |

The limits behind `busy` and `invalid_request` (queued messages per session, messages per process, page sizes) are
FastAgent's, and may change: handle the refusal, do not depend on the number.

New event types, entry kinds, statuses and error codes may be added. Ignore an event or entry you do not know, treat an
unknown session status as busy, act on `retryable` for an unknown code, and treat any message status other than the
four ends as not ended.

## Over HTTP

Every route is under `/v1`, with `Authorization: Bearer <key>`. A served agent holds one or more keys
([`FASTAGENT_API_KEY`](configuration.md#the-agent-api-over-http)); without one it serves no API. There is no CORS:
the key opens the whole instance, so a browser calls your backend, which calls the agent.

| Method and path | Operation |
|---|---|
| `GET /v1/agent`, `GET /v1/usage` | `info`, `usage` |
| `GET /v1/openapi.json` | This API as an OpenAPI 3.1 document |
| `POST /v1/sessions`, `GET /v1/sessions?limit&after` | `sessions.create` (`201`), `sessions.list` |
| `GET`, `PATCH /v1/sessions/{sessionId}` | `sessions.get`, `sessions.update` |
| `GET /v1/sessions/{sessionId}/entries?after&before&limit` | `sessions.entries` |
| `GET /v1/sessions/{sessionId}/events?after` | `sessions.events`, as server-sent events |
| `POST /v1/sessions/{sessionId}/cancel`, `/compact` | `sessions.cancel`, `sessions.compact` (`202`) |
| `GET /v1/sessions/{sessionId}/attachments/{ref}` | `sessions.attachment` |
| `POST /v1/sessions/{sessionId}/messages` | `messages.send`; `messages.stream` with `"stream": true` |
| `GET /v1/sessions/{sessionId}/messages/{messageId}?wait` | `messages.get` |
| `GET /v1/sessions/{sessionId}/messages/by-key/{idempotencyKey}?wait` | `messages.get` by key |

A send's body is `{ content, whenBusy?, wait?, stream? }`, and its key the `Idempotency-Key` header, percent-encoded.
An event stream sends each event as `event: <type>` with its JSON as `data`, and a comment at least every 15 seconds so
proxies keep it open. A refusal answers the status above with `{ "error": AgentError }`.

```bash
SEND=$(uuidgen)   # one key per message: running this again is the same message
curl -s https://support.example.com/v1/sessions/$SESSION/messages -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $SEND" \
  -d '{"content": "Where is order 9231?", "wait": 60}'
```

## Security

- **One instance is one trust domain.** A key can do everything, in every session, and the agent's tools act with the
  process's authority.
- **One instance per customer.** People who must not read each other's conversations get an instance each.
- **A key belongs on a server**, sent only over HTTPS. Rotate it by adding the new one, moving callers, removing the
  old.
- **A channel lets in everyone who can message its bot.** A platform's signature proves the platform, not the person.
- **A session id is a name, not a credential.**

## Not provided

Deleting a session; per-message usage (messages answered together share their model calls); structured results (have
a tool take the result as its arguments, and read its `tool_result`); asking the user mid-message; a webhook when a
message ends (use `get` with `wait`); files other than images; A2A and MCP bindings; the API on AgentCore.
