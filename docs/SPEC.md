---
title: Agent API — Specification v1
description: "The consumer API of a served FastAgent agent: sessions the Agent names, messages whose outcome outlives their callers, durable entries, and one event stream, in process and over HTTP."
type: spec
status: locked
version: 1.0
updated: 2026-10-20
---

# Agent API — Specification v1

> **Status: locked.** This is the API a served agent offers its consumers. Changing its semantics needs an explicit
> decision. Why it has this shape is [architecture.md](design/architecture.md).
>
> Until the move to it lands ([#788](https://github.com/fastagent-sh/fastagent/issues/788)), the reference
> implementation still serves the previous v1 draft: Caller-named sessions, `messages.*`, `sessions.list`, the
> control plane, capabilities, and a harness port.

> The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## 1. Overview

There are three roles:

- **Agent**: one served agent, the way a bot is one: whoever reaches it can talk to it. Who may reach it is decided
  in front of it (§8).
- **Caller**: whoever talks to it: an app's front end, a client, a service, another agent, and the implementation's own
  channels, schedules and wake-ups.
- **Middleware**: both a Caller and an Agent. It wraps an Agent while exposing the same API, for authentication,
  budgets, logging and the like.

The API has three concepts:

| Concept | Is | Exposed as |
|---|---|---|
| **Session** | A conversation: the messages of one session share its history | An id the Agent names (§5) |
| **Message** | One message a Caller sends into a session, from its acceptance to its outcome | `messageId`, with a status and an outcome (§4) |
| **Entry** | One record in a session's history: a user's message once taken, the agent's messages, tool results | An id that is the cursor for reading and the point for forking (§6) |

A Caller remembers its sessions: the Agent lists none. How the agent answers, in steps, turns or runs, and which
messages it handles together, is not part of the API: each message's facts are its own.

This is the consumer surface, and only that. Operating the agent (its model and settings, compaction, inspecting
every session) is the harness's own API, used by whoever builds and runs the agent (§11).

Fields are camelCase; enum values and discriminators are snake_case. A field that refers to another object names its
kind: `sessionId`, `messageId`, `entryId`, `parentEntryId`. The API has two bindings with the same operations and
the same semantics: TypeScript, in process (§2), and HTTP (§10).

## 2. Operations

```ts
interface Agent {
  info(): AgentInfo;
  invoke(request: InvokeRequest): Invocation;
  createSession(options?: { from?: ForkSource }): Promise<{ ok: true; sessionId: string } | { ok: false; error: AgentError }>;
  read(sessionId: string, options?: { after?: string; before?: string; limit?: number }): Promise<ReadResult>;
  follow(sessionId: string, options?: { after?: string }): AsyncIterable<FollowEvent>;
  abort(sessionId: string): Promise<AbortResult>;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
}

interface AgentInfo { protocolVersion: "1.0"; name: string; description?: string }

/** The events of one message, and the message's end as a value. */
type Invocation = AsyncIterable<InvokeEvent> & { result: Promise<InvokeResult> };
type InvokeResult =
  | { ok: true; sessionId: string; message: DoneMessage }
  | { ok: false; error: AgentError };

interface ForkSource { sessionId: string; entryId?: string; context?: "full" | "recent" }

type ReadResult =
  | { ok: true; state: SessionState; entries: Entry[]; prev?: string; next?: string }
  | { ok: false; error: AgentError };

type AbortResult =
  | { ok: true; stopped: { taken: string[]; queued: string[] } }
  | { ok: false; error: AgentError };

/** A follow that cannot start (an unknown session or cursor) is a single `rejected`. */
type FollowEvent = SessionEvent | { type: "rejected"; error: AgentError };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface ImageRef { mimeType: string; data: string }        // base64
interface Attachment { mimeType: string; data: string }      // base64
```

Every operation that returns a `Promise` resolves, and failures are values, not rejections. The exception is
`attachment`, whose answer has no failure branch: it MAY reject with an `AgentError` of code `unavailable` when the
Agent's storage cannot answer, because `undefined` would be a false answer. Every event, entry and result MUST be
JSON-serializable.

`result` resolves with the message's end whether or not the Caller iterates the events, so a Caller that wants only
the answer awaits it and reads nothing else.

## 3. Invoke

```ts
interface InvokeRequest {
  /** The session. Absent: the Agent creates one and names it in the receipt. */
  sessionId?: string;
  prompt: { text: string; images?: ImageRef[] };
  /** The Caller's key for this message, unique within the session. Requires sessionId. */
  idempotencyKey?: string;
  /** What the message is when the session is busy with another. Default: "queue". */
  whenBusy?: "queue" | "steer" | "reject";
}

type InvokeEvent =
  | { type: "accepted"; sessionId: string; message: MessageStatus; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | SessionEvent;
```

### 3.1 The stream

The first event is `accepted` or `rejected`.

- **`rejected`** is the only event of an invoke that was not accepted. Nothing was taken and nothing was recorded, so
  the same request MAY be sent again.
- **`accepted`** names the session and the message. While the message is queued, only `state` events follow. Once it
  is taken: its entries from its `user_message`, the session's live events while it is taken, and then its `done`
  event, which ends the stream.
- A Caller that stops reading **detaches**: the agent goes on. `abort` stops it (§5).

### 3.2 A busy session

A session is busy while the agent is answering a message in it. `whenBusy` says what a message that arrives then is:

| `whenBusy` | When the session is busy |
|---|---|
| `queue` (default) | Queued. Queued messages are taken in arrival order, each once the agent is done with the one before it, whatever that one's outcome |
| `steer` | Handed to the agent while it is still busy, to take at its next step (after its current tool round) rather than after it stops. Queued ahead of the messages queued with `queue` until taken; a steer the agent did not take before it stopped is taken no later than them |
| `reject` | Rejected with `busy` and `details.reason: "running"` |

An idle session takes a message at once, whatever `whenBusy` says. Until it is taken, a steered message is `queued`
like any other: it has a `position`, is listed in the session's `queued`, counts toward the queued limit (§7.2), and is
withdrawn by `abort`. Every message's answer and outcome are its own: two messages the agent handled together may
share an answer, and nothing more is promised about it.

### 3.3 Sessions and idempotency

- An invoke without `sessionId` creates a session and names it in the receipt. An invoke into a session the Agent
  does not hold answers `not_found`: a Caller cannot name a session (§5).
- An `idempotencyKey` is unique within its session and requires `sessionId` (else `invalid_request`), because a key
  sent while the session is still unnamed could not find its first message again. A Caller that wants a safe retry of
  its first message creates the session first (`createSession`).
- An invoke with a key the session has seen returns that key's message, `duplicate: true`, `message` as it is now,
  and records nothing new. The text is not compared with the first one: the key alone identifies the message. Its
  stream is the same message's stream (§3.1), so a duplicate of a done message delivers its entries from its
  `user_message` through its answer, or its `user_message` alone when it has no answer, and its `done`.
- Looking up the key, recording the message and queueing it are one step per session: concurrent invokes with one key
  produce one message.
- A Caller that lost its stream and wants the message's outcome sends the invoke again with the same key. That is the
  only way to ask for one message: a Caller that needs it sends with a key.

### 3.4 Acceptance is durable

Before `accepted` is sent, the message MUST be recorded durably with its id and key, so that a duplicate finds it after
any later restart.

## 4. Messages

```ts
type MessageStatus =
  | { messageId: string; idempotencyKey?: string; status: "queued"; position: number }
  | { messageId: string; idempotencyKey?: string; status: "taken"; entryId: string; takenAt: number }
  | DoneMessage;

interface DoneMessage {
  messageId: string;
  idempotencyKey?: string;
  status: "done";
  entryId?: string;
  takenAt?: number;
  endedAt: number;
  outcome: Outcome;
  answer?: { entryId: string; text: string };
}

type Outcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "canceled" }        // withdrawn or stopped by abort
  | { status: "failed"; error: AgentError };

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }
```

`entryId` is the message's `user_message` entry, written when it is taken. `answer` is the `assistant_message` the
agent stopped on for it: present when the outcome is `completed`, or `max_tokens`, where it is the cut-off reply, and
absent on every other outcome. A reply whose tool calls ran is never an answer. `position` counts from 0 in the order
the queued messages will be taken, steered ones first. Times are milliseconds since the epoch.

### 4.1 How a message ends

A message ends exactly once, with one outcome, recorded durably before it is reported.

| What happens | A taken message | A queued message |
|---|---|---|
| The Caller stops reading | The agent goes on | Stays queued, and is taken in its turn |
| `abort` | The agent stops: `canceled` | Withdrawn: `canceled`, without an entry |
| The process stops | Answered after the restart | Stays queued, and is taken in its turn |

A process that stops does not lose what was accepted: the Agent continues it when it starts again. A tool cut off
mid-call is not run again unless it declares that a second run is safe; the agent is told it was interrupted and
carries on. An Agent MUST NOT redo a message on its own.

## 5. Sessions

```ts
interface SessionState {
  status: "idle" | "running";
  taken: string[];      // the messages the agent is answering
  queued: string[];     // in the order they will be taken
}
```

The Agent names every session, with an id no one can guess (§8). A Caller gets one from `createSession` or from an
invoke without `sessionId`, and keeps it.

- **`createSession`** creates an empty session, or, with `from`, a fork: the new session starts with the source's
  history up to `entryId`, or all of it. A fork copies history, not messages: the source's messages, queued or done,
  stay the source's, and only recorded entries are copied when the source is busy. An unknown source or entry answers
  `not_found`. `context: "recent"` copies the same history but gives the model only its recent part, as a long session
  is bounded; a `compaction` entry may record the bound. A chat thread starting from its room is the use: it knows
  what the room knew without paying for all of it.
- **`read`** returns the state and one page of entries, after or before an entry cursor, oldest first within the page.
  Without a cursor it returns the newest page, so a Caller coming back to a session reads the latest entries and then
  follows from the last one. `prev` and `next` are the cursors of the adjacent pages, absent at either end.
  `limit: 0` returns the state alone.
- **`follow`** returns the entries after the cursor (from the beginning without one), then live events, without a gap
  or a duplicate between the two, and a `done` event for each message that ends while it follows. It ends only when
  the Caller stops reading.
- **`abort`** stops everything the session does: the agent answering its taken messages, and every queued message,
  steered ones included. It reports the messages it ended; on an idle session it answers `ok` with nothing stopped.
  Messages invoked after it are taken as usual.
- **`attachment`** returns the bytes behind a ref an entry of this session published, or `undefined`.

An unknown session answers `not_found` on every operation, and so does an unknown entry cursor, except `attachment`,
which answers `undefined`.

## 6. Entries and events

```ts
interface Entry {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}
// user_message       { text, images?, messageId?, idempotencyKey? }
// assistant_message  { text, thinking?, toolCalls?, outcome?, usage?: Usage }
// tool_result        { toolCallId, toolName, isError, text, images? }
// compaction         { summary, usage?: Usage }

type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "done"; message: DoneMessage }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; reason: string };
```

- Entries are durable, ordered as appended, and each names its parent, so a fork shares what it inherited. An entry's
  id is the cursor. Images in an entry are refs, read with `attachment`. An Agent MAY publish other kinds; a Caller
  ignores a kind it does not know (§9).
- A `user_message` entry is a message taken, and names it.
- An `assistant_message` carries the `usage` of the model response it is, and a `compaction` the `usage` of the model
  calls that wrote its summary. An entry a fork copied carries none: its cost was the source session's. So the sum over
  a session's entries is what its answers and compactions cost, and the sum over sessions counts each call once.
- `done` reports a message that has ended. It ends an invoke stream; a `follow` delivers one for each message that
  ends while it follows.
- Every other event is live: a Caller that reconnects sees the entries it missed, not the deltas. They are the
  session's, and an invoke stream delivers them while its message is taken.
- `message_delta` events add up to the agent's current message until its `assistant_message` entry arrives.
  `thinking` is the model's reasoning: a Caller MUST NOT fold it into the answer.
- `tool_progress` is the current status line of a running tool, each replacing the last; an Agent MAY drop one its
  Caller has not read. It carries the same trust as the tool's output.
- `retry_scheduled` explains a quiet gap while the agent waits to retry a model call.

## 7. Results, errors and limits

```ts
interface AgentError {
  code: string;
  message: string;
  retryable: boolean;   // whether the same request may succeed if sent again
  details?: Json;
}
```

### 7.1 Error codes

| Code | When | HTTP | `retryable` |
|---|---|---|---|
| `invalid_request` | A malformed request; a key without `sessionId`; `limit` above the maximum | 400 | false |
| `not_found` | An unknown session, fork source or entry cursor | 404 | false |
| `busy` | Admission refused; `details.reason` is `running` (`whenBusy: "reject"`), `queue_full` or `capacity` | 429 | true |
| `missing_model` | The agent has no model | 422 | false |
| `auth_required` | The model provider has no credential | 422 | false |
| `model_error` | The model call failed | 502 | by the provider's answer |
| `unavailable` | The Agent's storage cannot answer now | 503 | true |
| `internal` | Anything else | 500 | false |

A message's `failed` outcome carries `missing_model`, `auth_required`, `model_error` or `internal`. An implementation
MAY add codes under its own prefix. A Caller that meets an unknown code acts on `retryable`.

### 7.2 Limits

| Limit | Value |
|---|---|
| Queued messages per session, steered ones not yet taken included | 20; the next is rejected `busy` / `queue_full` |
| Messages in flight per process, queued and taken together | Implementation-defined (the reference implementation: 100); past it, `busy` / `capacity` |
| `read` page | `limit` defaults to 100; above 500 is `invalid_request`. A page MAY hold fewer entries than `limit` (the reference implementation stops at 4 MiB of JSON) but holds at least one when any exist past the cursor |
| `idempotencyKey` | 1 to 256 characters |

A Caller MUST NOT infer the end of the history from a short page: only an absent `next` (or `prev`) says so.

## 8. Security model

The Agent authenticates no one and lists no sessions. Whoever reaches it may talk to it: who may reach it, and how
often, is decided in front of it (a gateway, a private network, a cloud's IAM, an embedder's own middleware).

- **A session id is the session's key.** Whoever holds one can read and follow the session, invoke into it, abort it
  and fork from it. So the Agent MUST mint session ids that cannot be guessed (at least 122 random bits, as a UUIDv4
  has), and a Caller keeps them as it would keep any credential to its conversation.
- **A browser is a Caller like any other.** Over HTTP, a request with a body MUST carry `content-type:
  application/json`, and anything else is refused with `invalid_request` before it is read: a form or `text/plain`
  POST is sent cross-origin without a preflight, so withholding a response would not stop a run it already started.
  Which origins may read the answers is the deployment's choice.

## 9. Conformance

An invoke stream ends in exactly one of three ways:

- **(a)** the message's `done` event;
- **(b)** a single `rejected`;
- **(c)** the Caller detaches; the agent goes on.

### Agent MUST

1. **One ending.** A stream the Caller reads to its end holds exactly one `rejected`, or one `accepted` and ends with
   its message's `done` event, unless the process stops. Nothing follows either.
2. **Failures are events.** Iterating `invoke` or `follow` MUST NOT throw. A message the agent failed to answer ends
   with a `failed` outcome; a refusal is `rejected`.
3. **Detaching is not stopping.** When the Caller stops reading, the Agent MUST release what it held for that stream
   and MUST NOT stop the agent. Only `abort` stops it.
4. **Durable messages.** An accepted message is recorded before its receipt (§3.4), ends exactly once, recorded
   before it is reported, and survives a restart of the process (§4.1). The Agent never redoes a message on its own.
5. **Unguessable sessions.** Session ids are minted as §8 requires.

### Caller MUST

6. **Forward compatibility.** The stream endings `{ done, rejected }` are frozen. New event types and entry kinds
   are non-ending; a Caller MUST ignore an event type or entry kind it does not know.
7. **Relay passthrough.** Middleware that relays a stream MUST pass unknown events through unchanged.

### Not guaranteed

- **Atomic messages.** A message that ends `failed` or `canceled` may have recorded entries and run tools with
  effects. `retryable` says whether sending again may succeed, not that doing so is free of repeated effects.
- **Paired tools.** A `tool_started` may have no `tool_result` when the agent was stopped.
- **Grouping.** Which messages the agent answers together, and whether they share an answer.

### The conformance suite

One executable suite, run against the Agent in process and through the HTTP binding, checks:

| Area | Checks |
|---|---|
| Invoke | `accepted` first; the stream ends with the message's `done` and nothing follows; a `rejected` stream records nothing; an invoke without `sessionId` gets a new session, and one into an unknown session is `not_found`; `result` resolves with the same `done` whether or not the events are read; iteration never throws; every event is JSON |
| Busy | `queue` messages are taken in arrival order with correct positions; `reject` answers `busy`/`running`; `steer` is `queued` at position 0 until taken, then taken while the session is still busy; a steer the agent did not take before it stopped is taken no later than the messages queued with `queue`; an idle session takes a message for every mode; the 21st queued message is `queue_full`; the process cap is `capacity` |
| Idempotency | A key without `sessionId` is `invalid_request`; a key seen while queued, taken and done returns the same message, `duplicate`, and no second `user_message`; a duplicate's stream ends with the same `done`; concurrent invokes with one key make one message |
| Messages | A detached message is done; `abort` stops the taken message and withdraws the queued ones, all ending `canceled`, reports them, and reports nothing on an idle session; messages invoked after a failed or aborted one are taken; a done message's stream replays its own entry through its answer, or its own entry alone; only a `completed` or `max_tokens` message has an answer, never a reply whose tool calls ran |
| Restart | A message accepted just before a restart is answered after it, and a duplicate finds it; queued messages survive and are taken; no message is redone (a tool's effect count does not grow) |
| Reading | `read` pages by `after`, `before` and `limit`, returns the newest page without a cursor, and `limit: 0` returns the state; a taken message's `user_message` names it; every `assistant_message` and every `compaction` the session wrote carries `usage`, and no entry a fork copied does; `follow` and a reconnect from the last entry deliver each entry exactly once; an unknown session or cursor is `not_found`, a single `rejected` for a follow; the state moves idle → running → idle |
| Sessions | Session ids are unguessable; a fork holds the history up to its entry and none of the messages, and leaves the source unchanged; an unknown fork source is `not_found` |
| HTTP | A body without `content-type: application/json` is refused before it is read; `Accept: application/json` on an invoke answers the `result`; `Last-Event-ID` resumes a follow |

## 10. HTTP binding

| Operation | HTTP |
|---|---|
| `info` | `GET /agent` |
| `invoke` | `POST /invoke` with the `InvokeRequest`: a `text/event-stream` of `InvokeEvent`s. With `Accept: application/json` the server answers once the message is done, with `200` and `{ sessionId, message }`. A rejection is the error's status with `{ "error": AgentError }` |
| `createSession` | `POST /sessions` with `{ from? }`: `201` and `{ sessionId }` |
| `read` | `GET /sessions/{s}?after=&before=&limit=` |
| `follow` | `GET /sessions/{s}/events?after=`: a `text/event-stream`. Each `entry` event's SSE `id` is the entry id, so `Last-Event-ID` resumes. A follow that cannot start is the error's status instead |
| `abort` | `POST /sessions/{s}/abort` |
| `attachment` | `GET /sessions/{s}/attachments/{ref}`: the bytes with their content type, or `404` with no body |

A failed result is answered with its code's status (§7.1) and `{ "error": AgentError }`; a successful one with `200`
and the value without its `ok`.

A connection that fails before the receipt arrives leaves it unknown whether the message was accepted, since the
server answers only once the message is recorded and may still be reading the request. With an `idempotencyKey`,
sending it again settles it: the server answers with the message the key names, or accepts it. Without a key, a
client MUST NOT report the invoke `rejected`: that says nothing was recorded, and a Caller would send it again. The
same holds for a JSON invoke whose connection fails while it waits for the message to end.

## 11. Out of scope

- **Operating the agent**: its model and thinking level, compaction, inspecting or listing sessions, and anything
  else its harness can do. These are the harness's own API, in the process that runs the agent.
- **Listing and deleting sessions**: a Caller keeps the sessions it uses, and nothing is deleted.
- **Identity, authentication, rate limits** (§8).
- **Files other than images in a prompt.**
- **Other transports**: A2A and the like sit outside and call this API.
- **The agent definition, packaging and deployment**: [architecture.md](design/architecture.md).

## 12. Changes from v0.1

| v0.1 | v1 |
|---|---|
| `invoke(scope, prompt)` | `invoke(request)`: an optional `sessionId`, `idempotencyKey`, `whenBusy` |
| `Scope`, Caller-named sessions, `scope.parentSession` | The Agent names sessions; forking is `createSession` with `from` |
| `text`, `thinking` events | `message_delta`, and the settled `assistant_message` entry |
| `tool_ended` | The `tool_result` entry |
| `retrying` | `retry_scheduled` |
| A turn, with no id | A message, with an id, a status and an outcome that outlive the stream |
| `completed`, `failed` endings | The message's `done` event, with its outcome; `rejected` for a refusal |
| `completed.data` | Gone: a structured result waits for a design |
| MUST 3: the Agent stops when the Caller stops reading | The Caller detaches; `abort` stops the agent |
| A busy session rejected with `session_busy` | `whenBusy`; `busy` with a reason |
| The session control extension (`steer`, `followUp`, `abort`, …) | `whenBusy` and `abort` |
| `collect(events)` | `invocation.result`, or `Accept: application/json` |
| Nothing about history | `read`, `follow`, `attachment`, and a durable history of entries |
