---
title: Agent Handler — Protocol Specification v1
description: "Agent Handler protocol v1: sessions, messages whose outcome outlives their callers, durable entries, admission and idempotency, so any caller can work with any served agent without knowing its harness."
type: spec
status: locked
version: 1.0
updated: 2026-10-17
---

# Agent Handler — Protocol Specification v1

> **Status: locked.** This is the protocol the package implements once step 4's change from runs to messages lands
> ([#788](https://github.com/fastagent-sh/fastagent/issues/788)); until then the reference implementation serves the
> run model this text replaced (`runs.*`, `run_started` and `run_ended` entries). Changing its semantics needs an
> explicit decision. The design, with its rationale, is [agent-service.md](design/agent-service.md) §7 and §9.

> The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119. This specification is
> harness-neutral and does not depend on any implementation.

## 1. Overview

There are three roles:

- **Agent**: the served agent. It takes messages into sessions, works on them, and records what happened. It is a
  black box to the Caller.
- **Caller**: whoever uses it: an app, a client, another agent, and the implementation's own channels, schedules and
  wake-ups.
- **Middleware**: both a Caller and an Agent. It wraps a downstream Agent while exposing the same interface, for
  authentication, budgets, logging and the like.

The protocol has three concepts:

| Concept | Is | Exposed as |
|---|---|---|
| **Session** | A conversation: the messages of one session share its history | An id, named by the Caller or by the Agent (§3, §5) |
| **Message** | One message a Caller sends into a session, from its acceptance to its outcome | `messageId`, with a status, events and a cancel (§4) |
| **Entry** | One record in a session's history: a user's message once taken, the agent's messages, tool results | An id that is the cursor for reading and the point for forking (§6) |

A session works on one thing at a time: it takes a message, and the agent works, across model calls and tool calls,
until it answers. Messages steered in while it works are taken by the same work and answered by the same answer
(§3.2). How the agent works, in steps, turns or runs, belongs to the harness and is not part of the protocol. What
the Caller holds is its message: accepted, then queued, taken, and done with one outcome.

Fields are camelCase; enum values and discriminators are snake_case. A field that refers to another object names its
kind: `sessionId`, `messageId`, `entryId`, `parentEntryId`.

The protocol is not a wire protocol. §9 binds it to HTTP; ACP and other transports sit outside it.

## 2. The Agent

```ts
interface Agent {
  invoke(request: InvokeRequest): AsyncIterable<InvokeEvent>;
  sessions: {
    create(options?: {
      sessionId?: string;
      fork?: { sessionId: string; entryId?: string; context?: "full" | "recent" };
    }):
      Promise<{ ok: true; sessionId: string } | { ok: false; error: AgentError }>;
    list(): Promise<SessionSummary[]>;
    get(sessionId: string): Session;
  };
  info(): AgentInfo;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}

interface Session {
  readonly sessionId: string;
  read(options?: { after?: string; before?: string; limit?: number }):
    Promise<{ ok: true; state: SessionState; entries: Entry[]; next?: string; prev?: string } | { ok: false; error: AgentError }>;
  follow(options?: { after?: string }): AsyncIterable<FollowEvent>;
  attachment(ref: string): Promise<Attachment | undefined>;
  abort(): Promise<AbortResult>;
  rewind(entryId: string): Promise<Result>;
  compact(options?: { instructions?: string }): Promise<Result>;
  update(settings: { name?: string; model?: string; thinkingLevel?: string }): Promise<Result>;
  delete(): Promise<Result>;
  messages: {
    get(key: { messageId: string } | { idempotencyKey: string }): Promise<MessageStatus | undefined>;
    follow(messageId: string, options?: { after?: string }): AsyncIterable<FollowEvent>;
    cancel(messageId: string): Promise<Result>;
  };
}

/** A follow that cannot start (an unknown session, message or cursor) is a single `rejected`. */
type FollowEvent = SessionEvent | { type: "rejected"; error: AgentError };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface ImageRef { mimeType: string; data: string }        // base64
interface Attachment { mimeType: string; data: string }      // base64
interface ModelDescriptor { spec: string; name?: string; thinkingLevels: string[]; contextWindow?: number }
interface AgentCommand { name: string; description?: string; source: string }
```

Every operation that returns a `Promise` resolves, and failures are values, not rejections. The exception is the reads
whose answer has no failure branch: `sessions.list`, `messages.get`, `attachment`, `models` and `commands` MAY reject
with an `AgentError` of code `unavailable` when the Agent's storage cannot answer, because an empty list or
`undefined` would be a false answer (`messages.get` answering `undefined` says the message was never accepted). Over
HTTP the rejection is `503` with `{ "error": AgentError }`. Every event, entry and result MUST be JSON-serializable.

## 3. Invoke

```ts
interface InvokeRequest {
  /** The session. Absent: the Agent creates one and names it in the receipt. */
  sessionId?: string;
  prompt: { text: string; images?: ImageRef[] };
  /** What the message is when the session is working on another. Default: "queue". */
  whenBusy?: "queue" | "steer" | "reject";
  /** The Caller's key for this message, unique within the session. Requires sessionId. */
  idempotencyKey?: string;
  /** What sent the message. Set in process only (§3.5). */
  source?: { kind: "channel" | "schedule" | "wake"; name?: string };
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
- **`accepted`** names the session and the message. What follows is `messages.follow(messageId)` without a cursor
  (§4.2), which ends with the message's `done` event. So a duplicate (§3.3) sees the message from where it was taken,
  whether it is queued, taken or done.
- A Caller that stops reading **detaches**: the work goes on, and the Caller can come back to the message with
  `messages.get` and `messages.follow`. Stopping work is `messages.cancel`, `abort` or `delete` (§4.2).

### 3.2 A busy session

`whenBusy` says what a message that arrives while the session works on another is:

| `whenBusy` | When the session is working on another message |
|---|---|
| `queue` (default) | Queued. Queued messages are taken in arrival order, each once the work before it has ended, whatever its outcome |
| `steer` | Taken by the work in progress at its next step, after its current tool round, and answered by that work's answer. A steered message the work has not taken when it answers is taken by the next work, ahead of the queued messages, and answered by that work's answer. An Agent whose `capabilities.steer` is false rejects it with `unsupported` |
| `reject` | Rejected with `busy` and `details.reason: "running"` |

An idle session takes a message at once, whatever `whenBusy` says. Messages taken by the same work are answered by
the same answer and end with the same outcome; the next work MAY take the first queued message together with a
steered one. A message withdrawn before it is taken (`messages.cancel`, `abort`, `delete`) ends `canceled` without an
entry.

### 3.3 Sessions and idempotency

- A Caller that names a session gets it; an invoke into a session that does not exist creates it empty. A Caller that
  names none gets a new session per invoke, named in the receipt. Session ids are opaque strings owned by whoever
  named them; `""`, `.` and `..` are refused with `invalid_request`, because a URL cannot address them.
- An `idempotencyKey` is unique within its session and requires `sessionId` (else `invalid_request`). An invoke with a
  key the session has seen returns that key's message, `duplicate: true`, `message` as it is now, and records nothing
  new. The text is not compared with the first one: the key alone identifies the message.
- Looking up the key, recording the message and queueing it are one step per session: concurrent invokes with one key
  produce one message.
- One exception: when the key's message ended `interrupted` (§4.1), the invoke accepts the text as a new message,
  which the key names from then on, and the receipt says `duplicate: false`. `messages.get({ idempotencyKey })`
  returns the key's newest message.

### 3.4 Acceptance is durable

Before `accepted` is sent, the message MUST be recorded with its id, key and source, so that `messages.get` finds it
after any later restart. `messages.get` answers `undefined` only for a message that was never accepted, or whose
session was deleted.

### 3.5 Source

Channels, schedules and wake-ups name themselves in `source`, in process, and the message records it. A remote
Caller cannot: a transport MUST reject a request that carries `source` with `invalid_request`, and the message
records `{ kind: "api" }`.

## 4. Messages

```ts
type MessageStatus = {
  messageId: string;
  idempotencyKey?: string;
  source?: { kind: "channel" | "schedule" | "wake" | "api"; name?: string };
} & (
  | { status: "queued"; position: number }
  | { status: "taken"; entryId: string; takenAt: number }
  | { status: "done"; entryId?: string; lastEntryId?: string; takenAt?: number; endedAt: number; outcome: Outcome;
      usage?: Usage; answer?: { entryId: string; text: string } }
);

type Outcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "intercepted" }    // a command or extension took the message; no model was called
  | { status: "interrupted" }    // the process stopped before the message was done, taken or queued
  | { status: "canceled"; by: "cancel" | "abort" | "delete" }
  | { status: "failed"; error: AgentError };

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }
```

`entryId` is the message's `user_message` entry, written when it is taken. `lastEntryId` is the last entry the work
that took it wrote, when the Agent recorded one after the message's own entry; with an answer it is the answer's
entry. `answer` is the agent's final
`assistant_message` of the work that took it. `usage` is what that work cost; messages taken together report the same
work, so a Caller adding usage up counts it once per answer. `position` counts from 0 in the order the queued messages
will be taken. Times are milliseconds since the epoch.

### 4.1 How a message ends

A message ends exactly once, with one outcome, recorded durably before it is reported. A message that was accepted,
has not ended, and is neither taken by work in progress nor queued is `interrupted`. The Agent records that the first
time it opens the session after the work stopped, before it answers any operation on that session, so a
`messages.follow` or `follow` that reattaches after a restart reaches the end without the session working again.
Whether work in progress continues after a restart, and whether queued messages survive one, is the Agent's
`durableWork` and `durableQueue` capability (§7.3):

| What happens | A taken message | A queued message |
|---|---|---|
| The Caller stops reading | The work continues | Stays queued, and is taken in its turn |
| `messages.cancel` | The work stops: `canceled` by `cancel` | Withdrawn: `canceled` by `cancel` |
| `abort` | The work stops: `canceled` by `abort` | Withdrawn: `canceled` by `abort` |
| `delete` | The work stops: `canceled` by `delete` | Withdrawn: `canceled` by `delete` |
| The process stops | The work continues with `durableWork`; otherwise `interrupted`, and what it recorded stays | Stays queued with `durableQueue`; otherwise `interrupted` without being taken |

Stopping work ends every message it took. An Agent MUST NOT redo work on its own: its tools may already have had
effects. A Caller that owes an answer may invoke again with the message's key (§3.3).

### 4.2 Operations

- **`messages.get`** returns a message by id or by key, or `undefined` (§3.4).
- **`messages.follow`** is the session's events for one message: the entries after the cursor, or from its
  `user_message` entry without one; while it is taken, the live events of the work; then its `done` event. While it is
  queued nothing is delivered but `state` events. For a message that is already done it delivers the entries after the
  cursor through its `lastEntryId`, or through its own entry when that is absent (from its `entryId` without a cursor,
  and none for a message never taken), and then `done`, so a Caller reattaching later sees what one following it live saw. A Caller that lost its invoke stream reattaches without
  following the whole session.
- **`messages.cancel`** withdraws a queued message or stops the work a taken one is part of; messages queued after it
  are taken as usual. A message that is done answers `conflict`.

## 5. Sessions

```ts
interface SessionState {
  name?: string;
  status: "idle" | "running" | "compacting";
  taken: { messageId: string; takenAt: number }[];
  queued: { messageId: string; idempotencyKey?: string; preview: string }[];
  model?: string; thinkingLevel?: string; thinkingLevels?: string[];
  context?: { tokens?: number; window?: number };
  leafEntryId?: string;
}

interface SessionSummary {
  sessionId: string; name?: string; status: "idle" | "running";
  createdAt: number; updatedAt: number; preview?: string;
}

type AbortResult =
  | { ok: true; stopped: { taken: string[]; queued: string[]; compaction: boolean } }
  | { ok: false; error: AgentError };
```

- **`sessions.create`** names the session, or lets the Agent name it, and is the only way to fork: the new session
  starts with the source's history up to `entryId`, or all of it. A fork copies history, not messages: the source's
  messages, queued or done, stay the source's, and only recorded entries are copied when the source is working. An
  existing `sessionId` answers `conflict`, an unknown fork source `not_found`, and a fork without `capabilities.fork`
  `unsupported`. `context: "recent"` copies the same history but asks the Agent to give the model only its recent
  part, as it would bound a long session; a `compaction` entry may record the bound. A chat thread starting from its
  room is the use: it knows what the room knew without paying for all of it. An Agent that does not manage context
  treats it as `"full"`, the default.
- **`sessions.list`** returns every session the Agent holds, or rejects with `unavailable` (§2).
- **`read`** returns the state and one page of entries, after or before an entry cursor, oldest first within the page.
  Without a cursor it returns the newest page, so a client opening a session reads the latest entries and then follows
  from the last one. `next` and `prev` are the cursors of the adjacent pages, absent at either end. `limit: 0` returns
  the state alone.
- **`follow`** returns the entries after the cursor (from the beginning without one), then live events, without a gap
  or a duplicate between the two.
- **`attachment`** returns the bytes behind a ref an entry of this session published, or `undefined`.
- **`abort`** stops everything the session does: the work in progress, every queued message and a manual compaction.
  It reports the messages it ended; on an idle session it answers `ok` with nothing stopped.
- **`rewind`** moves the session's active branch to an entry; the next work continues from there. Nothing is deleted.
  A working session answers `busy`.
- **`compact`** summarizes the history; with nothing to summarize it answers `nothing_to_compact`, and on a working
  session `busy`.
- **`update`** sets the session's name, model and thinking level, applied from the next work. A field outside
  `capabilities.updatable` answers `unsupported`. A multi-field update that wrote some fields and then failed answers
  `partial_update`.
- **`delete`** ends the session's messages that are not done (`canceled` by `delete`), whose open streams still end
  with their `done` event, and removes the session.

An unknown session answers `not_found` on every operation but `invoke`, which creates it, and `messages.get` and
`attachment`, which answer `undefined`. So does an unknown entry cursor or entry id. A call beyond the Agent's
capabilities answers `unsupported`; it is never ignored.

## 6. Entries and events

```ts
interface Entry {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}
// user_message       { text, images?, messageId, idempotencyKey?, source? }
// assistant_message  { text, thinking?, toolCalls?, outcome? }
// tool_result        { toolCallId, toolName, isError, text, images? }
// settings_changed   { name?, model?, thinkingLevel? }
// compaction         { summary, firstKeptEntryId }

type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "done"; message: MessageStatus & { status: "done" } }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "serving_error"; message: string };
```

- Entries are durable, ordered as appended, and each names its parent, so branches share what they inherited. An
  entry's id is the cursor. Images in an entry are refs, read with `attachment`.
- A `user_message` entry is a message taken: it names the message, so the history says which entry each message
  became.
- `done` reports a message that has ended, built from its durable record. It ends a `messages.follow` and an invoke
  stream; a session `follow` delivers it as a live event for each message that ends while it follows.
- Every other event is live: a Caller that reconnects sees the entries it missed, not the deltas. A session works on
  one thing at a time, so the live events belong to what it is doing: its work in progress, or a compaction while its
  status is `compacting`, which can also send `retry_scheduled`. A `messages.follow` delivers only those of the work
  that took its message.
- `message_delta` events add up to the agent's current message until its `assistant_message` entry arrives.
  `thinking` is the model's reasoning: a Caller MUST NOT fold it into the answer.
- `tool_progress` is the current status line of a running tool, each replacing the last; an Agent MAY drop one its
  Caller has not read. It carries the same trust as the tool's output.
- `retry_scheduled` explains a quiet gap while the harness waits to retry a model call, the work's or a
  compaction's.

## 7. Results, errors, capabilities and limits

```ts
type Result = { ok: true } | { ok: false; error: AgentError };

interface AgentError {
  code: string;
  message: string;
  retryable: boolean;   // whether the same request may succeed if sent again
  details?: Json;
}

interface AgentInfo {
  protocolVersion: "1.0";
  capabilities: {
    steer: boolean; fork: boolean; rewind: boolean; compaction: boolean; delete: boolean;
    updatable: ("name" | "model" | "thinkingLevel")[];
    durableQueue: boolean;   // queued messages survive a restart
    durableWork: boolean;    // work in progress continues after a restart
    toolProgress: boolean; usage: boolean;
  };
}
```

### 7.1 Error codes

| Code | When | HTTP | `retryable` |
|---|---|---|---|
| `invalid_request` | A malformed request; `source` from a remote Caller; a key without `sessionId`; an id no URL can address; `limit` above the maximum | 400 | false |
| `unsupported` | An operation or option beyond `capabilities` | 501 | false |
| `not_found` | An unknown session, entry or message where one must exist | 404 | false |
| `conflict` | `sessions.create` of an existing id; `messages.cancel` of a message that is done | 409 | false |
| `busy` | Admission refused (`details.reason`: `running`, `queue_full`, `capacity`); `rewind` or `compact` on a working session | 429 | true |
| `missing_model` | Neither the session nor the agent sets a model | 422 | false |
| `auth_required` | The model provider has no credential | 422 | false |
| `model_error` | The model call failed | 502 | by the provider's answer |
| `nothing_to_compact` | `compact` with nothing to summarize | 409 | false |
| `partial_update` | `update` wrote some fields, then failed; the only `ok: false` behind which durable work landed | 500 | false |
| `unavailable` | The Agent's storage cannot answer now | 503 | true |
| `internal` | Anything else | 500 | false |

A message's `failed` outcome carries `missing_model`, `auth_required`, `model_error` or `internal`. An implementation
MAY add codes under its own prefix (`pi.…`). A Caller that meets an unknown code acts on `retryable`.

### 7.2 Limits

| Limit | Value |
|---|---|
| Queued messages per session | 20; the next is rejected `busy` / `queue_full` |
| Messages in flight per process, queued and taken together | Implementation-defined (the reference implementation: 100); past it, `busy` / `capacity` |
| `read` page | `limit` defaults to 100; above 500 is `invalid_request`. A page MAY hold fewer entries than `limit` (the reference implementation stops at 4 MiB of JSON) but holds at least one when any exist past the cursor |
| `idempotencyKey` | 1 to 256 characters |

A Caller MUST NOT infer the end of the history from a short page: only an absent `next` (or `prev`) says so.

### 7.3 Capabilities

`info()` is fixed for the Agent's life, so a Caller may read it once. A capability that is false makes its operation
answer `unsupported`: `steer` (`whenBusy: "steer"`), `fork` (`sessions.create` with `fork`), `rewind`, `compaction`
(`compact`), `delete`, and every field outside `updatable`. `durableQueue` and `durableWork` change no operation;
they say what a restart preserves (§4.1). Without `toolProgress` no `tool_progress` event is sent; without `usage`,
`usage` is absent.

## 8. Conformance

An invoke stream ends in exactly one of four ways:

- **(a)** the message's `done` event;
- **(b)** a single `rejected`;
- **(c)** the Caller detaches; the work goes on;
- **(d)** the process stops; the message is then `durableWork`- or `durableQueue`-continued, or `interrupted`.

### Agent MUST

1. **One ending.** A stream the Caller reads to its end holds exactly one `rejected`, or one `accepted` and ends with
   its message's `done` event, unless the process stops. Nothing follows either.
2. **Failures are events.** Iterating `invoke`, `follow` or `messages.follow` MUST NOT throw. A message whose work
   failed ends with a `failed` outcome; a refusal is `rejected`.
3. **Detaching is not stopping.** When the Caller stops reading, the Agent MUST release what it held for that stream
   and MUST NOT stop the work. Only `messages.cancel`, `abort` and `delete` stop work.
4. **Durable acceptance.** An accepted message is recorded before its receipt (§3.4), and ends exactly once, recorded
   before it is reported (§4.1). The Agent never redoes work on its own.
5. **Capabilities are honest.** An operation beyond `info().capabilities` answers `unsupported`; nothing is silently
   ignored, emulated or downgraded.

### Caller MUST

6. **Forward compatibility.** The stream endings `{ done, rejected }` are frozen. New event types and entry kinds
   are non-ending; a Caller MUST ignore an event type or entry kind it does not know.
7. **Relay passthrough.** Middleware that relays a stream MUST pass unknown events through unchanged.

### Portable conformance (optional)

8. **Process affinity only while a session works.** A session's calls MUST NOT need to reach one process while the
   session is idle: its state is reconstructible from external storage. While a message is taken or queued, they MAY
   need to reach the process working on it; portable deployment therefore needs a session router in front that sends
   a session's calls to that process.

### Not guaranteed

- **Atomic work.** A message that ends `failed`, `canceled` or `interrupted` may have recorded entries and run tools
  with effects. `retryable` says whether sending again may succeed, not that doing so is free of repeated effects.
- **Paired tools.** A `tool_started` may have no `tool_result` when its work was stopped.

### The conformance suite

One executable suite, run against every harness in process and through the HTTP binding, checks:

| Area | Checks |
|---|---|
| Invoke | `accepted` first; the stream ends with the message's `done` and nothing follows; a `rejected` stream records nothing; an invoke without `sessionId` gets a new session; iteration never throws; every event is JSON |
| Busy | `queue` messages are taken in arrival order with correct positions; `reject` answers `busy`/`running`; `steer` is taken by the work in progress and shares its answer, or, arriving after that work's answer, is taken by the next work and shares that work's answer, which answers it alone when nothing was queued (or `unsupported`); an idle session takes a message for every mode; the 21st queued message is `queue_full`; the process cap is `capacity` |
| Idempotency | A key seen while queued, taken and done returns the same message, `duplicate`, and no second `user_message`; a duplicate's stream ends with the same `done`, so `collect` over it returns the same answer as over the first; concurrent invokes with one key make one message; an `interrupted` message's key accepts a new message, and `messages.get` by key returns it |
| Messages | A detached message is done; `messages.follow` resumes from a cursor; `messages.cancel` stops work in progress and withdraws a queued message while the rest are taken; `abort` stops all and reports it, and reports nothing on an idle session; queued messages are taken after work that failed or was canceled |
| Restart | A message accepted just before a restart is found by `messages.get`; work in progress continues or its messages are `interrupted` per `durableWork`; queued messages survive or are `interrupted` per `durableQueue`; after a restart, `messages.follow` of an `interrupted` message ends with its `done` without another invoke; no work is redone (a tool's effect count does not grow) |
| Reading | `read` pages by `after`, `before` and `limit`, returns the newest page without a cursor, and `limit: 0` returns the state; a taken message's `user_message` names it; `follow` and a reconnect from the last entry deliver each entry exactly once; an unknown session or cursor is `not_found`, a single `rejected` for a follow; state moves idle → running → idle |
| Sessions | `create` of an existing id is `conflict`; a fork holds the history up to its entry and none of the messages, and leaves the source unchanged; `rewind` keeps the earlier branch and is `busy` while working; `compact` on an empty history is `nothing_to_compact`; `update`, `delete` and `list` |
| Portable | Two instances over one storage: the second sees the first's history of an idle session |

## 9. HTTP binding

The operations are grouped by audience into planes, served separately so a gateway can treat them differently:

| Plane | For | Operations |
|---|---|---|
| User | People using the agent, and clients acting for them | `invoke`; messages; `sessions.create`, `list`; `read`, `follow`, `attachment`, `abort`, `rewind`, `compact`; `info`, `models`, `commands` |
| Control | Operators | `update`, `delete` |

| Operation | HTTP |
|---|---|
| `invoke` | `POST /invoke`: `text/event-stream` of `InvokeEvent`s; with `Accept: application/json`, `202` and the `accepted` event; a rejection is the error's status with `{ "error": AgentError }` |
| `sessions.create`, `sessions.list` | `POST /sessions`, `GET /sessions` |
| `read`, `follow` | `GET /sessions/{s}?after=&before=&limit=`; `GET /sessions/{s}/follow?after=` (SSE; each entry event's `id` is the entry id, so `Last-Event-ID` resumes; a `rejected` follow is the error's status instead) |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` |
| `abort`, `rewind`, `compact` | `POST /sessions/{s}/abort`, `POST /sessions/{s}/rewind`, `POST /sessions/{s}/compact` |
| `messages.get`, `messages.follow`, `messages.cancel` | `GET /sessions/{s}/messages/{m}`, `GET /sessions/{s}/messages?idempotencyKey=`; `GET /sessions/{s}/messages/{m}/events?after=` (SSE); `POST /sessions/{s}/messages/{m}/cancel` |
| `info`, `models`, `commands` | `GET /agent`, `GET /agent/models`, `GET /agent/commands` |
| `update`, `delete` | `PATCH /control/sessions/{s}`, `DELETE /control/sessions/{s}` |

A failed `Result` is answered with its code's status (§7.1) and `{ "error": AgentError }`. `messages.get` answering
`undefined` is `200` with the body `null`, because a `404` is also what any router answers for a path it does not
know, and this answer decides whether a Caller sends again; `attachment` answering `undefined` is `404` with no body.
Authentication is not part of the protocol: it belongs to a gateway in front, or to middleware per plane.

A connection that fails before the receipt arrives leaves it unknown whether the message was accepted, since the
server answers only once the message is recorded, and may still be reading the request. With an `idempotencyKey`,
sending it again with the key settles it: the server answers with the message the key names, or accepts it. Asking
`messages.get` does not, since the first request may be accepted after the answer. Without a key, a client MUST NOT
report the invoke `rejected`: that says nothing was recorded, and a Caller would send it again.

## 10. Consumption: streaming and buffered

A Caller either reads the events as they arrive (a chat UI, an SSE endpoint), or wants only the answer. The buffered
form is a Caller-side reducer and adds nothing to the protocol:

```ts
async function collect(events: AsyncIterable<InvokeEvent>): Promise<{ sessionId: string; messageId: string; text: string }> {
  let receipt: { sessionId: string; messageId: string } | undefined;
  for await (const e of events) {
    if (e.type === "rejected") throw new AgentRejected(e.error);
    if (e.type === "accepted") receipt = { sessionId: e.sessionId, messageId: e.message.messageId };
    if (e.type === "done" && receipt && e.message.messageId === receipt.messageId) {
      if (e.message.outcome.status !== "completed") throw new MessageNotCompleted(e.message.outcome);
      return { ...receipt, text: e.message.answer?.text ?? "" };
    }
  }
  throw new Error("stream ended without done"); // the process stopped, or MUST 1 was violated
}
```

## 11. Extension points

| Extension | Attachment point |
|---|---|
| Identity and permissions | A principal on the request, asserted only by a trusted gateway or an in-process channel; designed with permissions |
| Execution constraints such as deadline or budget | Middleware; exceeding one ends the message `failed` |
| New kinds of output | New event types and entry kinds; never a new stream ending (MUST 6) |
| Structured result | Not in v1; a design must keep the endings frozen |
| Failure subdivision | Codes under an implementation prefix (§7.1) |

Session storage, the tool execution environment, model selection and loading the agent's definition are injected
inside the Agent and are not specified here. So are the harness and the port the implementation runs it through: a
harness conforms by passing the suite (§8) through that implementation.

## 12. Out of scope

- **Transports other than §9**: ACP, A2A and the like sit outside and call the protocol.
- **Harness internals**: the loop, its steps and runs, tool execution, model calls and context management.
- **The agent definition format**: existing standards such as `AGENTS.md`, Agent Skills and MCP.
- **Packaging and deployment**.

## 13. Changes from v0.1

| v0.1 | v1 |
|---|---|
| `invoke(scope, prompt)` | `invoke(request)`: an optional `sessionId`, `whenBusy`, `idempotencyKey`, and in-process `source` |
| `Scope`, `scope.parentSession` | Gone; forking is `sessions.create` with `fork` |
| `text`, `thinking` events | `message_delta`, and the settled `assistant_message` entry |
| `tool_ended` | The `tool_result` entry |
| `retrying` | `retry_scheduled` |
| A turn, with no id | A message, with an id, a status and an outcome that outlive the stream |
| `completed`, `failed` endings | The message's `done` event, with its outcome; `rejected` for a refusal |
| `completed.data` | Gone: no harness produced it; a structured result waits for a design |
| MUST 3: the Agent stops when the Caller stops reading | The Caller detaches; `messages.cancel`, `abort` and `delete` stop work |
| MUST 6: no location dependence | Location dependence only while a session works (MUST 8) |
| A busy session rejected with `session_busy` | `whenBusy`; `busy` with a reason |
| The session control extension (`steer`, `followUp`, `abort`, …) | `whenBusy`, `messages.cancel`, and the session operations of §5 |
| `collect` returns `{ text, data }` | `collect` returns the message's answer, and throws on any other outcome or a rejection |
