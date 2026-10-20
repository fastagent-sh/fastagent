---
title: Agent API — Specification v1
description: "The consumer API of a served FastAgent agent: sessions the Agent names, messages whose outcome outlives their callers, durable entries, resumable event streams, in process and over HTTP."
type: spec
status: decided
version: 1.0
updated: 2026-10-20
---

# Agent API — Specification v1

> **Status: decided, not implemented.** This is the API a served agent offers its consumers. It replaces
> [docs/SPEC.md](../SPEC.md), and moves there, when the move lands
> ([#788](https://github.com/fastagent-sh/fastagent/issues/788)); until then the code implements that file. Changing
> its semantics needs an explicit decision. Why it has this shape is [architecture.md](architecture.md).

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
| **Entry** | One record in a session's history: a user's message once taken, the agent's messages, tool results | An id that is the cursor for reading and resuming, and the point for forking (§6) |

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
  getMessage(sessionId: string, key: { messageId: string } | { idempotencyKey: string }): Promise<MessageStatus | undefined>;
  createSession(options?: { from?: ForkSource }): Promise<{ ok: true; sessionId: string } | { ok: false; error: AgentError }>;
  read(sessionId: string, options?: { after?: string; before?: string; limit?: number }): Promise<ReadResult>;
  resume(sessionId: string, options?: { replayFrom?: ReplayFrom }): AsyncIterable<ResumeEvent>;
  abort(sessionId: string): Promise<AbortResult>;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
}

interface AgentInfo {
  protocolVersion: "1.0";
  name: string;
  description?: string;
  /** The content part types a prompt may carry; `text` is always among them. */
  inputs: string[];
  /** What a Caller may offer as `/<name>`: the agent's prompt templates and skills (§3). */
  commands: { name: string; description?: string }[];
}

/** The events of one message, and the message's end as a value. */
type Invocation = AsyncIterable<InvokeEvent> & { result: Promise<InvokeResult> };
type InvokeResult =
  | { ok: true; sessionId: string; message: DoneMessage }
  | { ok: false; error: AgentError }                     // rejected: nothing was recorded
  | { ok: false; unfinished: { sessionId?: string; messageId?: string; reason: string } };

interface ForkSource { sessionId: string; entryId?: string; context?: "full" | "recent" }

type ReplayFrom = { type: "start" } | { type: "after"; entryId: string };

type ReadResult =
  | { ok: true; state: SessionState; entries: Entry[]; prev?: string; next?: string }
  | { ok: false; error: AgentError };

type AbortResult =
  | { ok: true; stopped: { taken: string[]; queued: string[] } }
  | { ok: false; error: AgentError };

/** A resume that cannot start (an unknown session or cursor) is a single `rejected`. */
type ResumeEvent = SessionEvent | { type: "rejected"; error: AgentError };

/** What a prompt and the entries carry. An image in a prompt carries its bytes; in an entry, a ref (§6). */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }      // base64, in a prompt
  | { type: "image"; mimeType: string; ref: string };      // in an entry, read with `attachment`

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Attachment { mimeType: string; data: string }    // base64
```

Every operation that returns a `Promise` resolves, and failures are values, not rejections. The exception is
`getMessage` and `attachment`, whose answers have no failure branch: they MAY reject with an `AgentError` of code
`unavailable` when the Agent's storage cannot answer, because `undefined` would be a false answer. Every event, entry
and result MUST be JSON-serializable.

`result` resolves with the message's end whether or not the Caller iterates the events, so a Caller that wants only
the answer awaits it and reads nothing else. The events are produced as they are read: an `Invocation` that is never
iterated holds nothing but its `result`, and one first iterated later attaches to its message as it is then (§5.1),
from its receipt, with its entries replayed and the snapshot standing for what was missed live. It resolves `unfinished` when the stream stops before the message's end
is known, which a `serving_error` event says (§6): the Agent cannot go on with it (its storage failed), or a client of a
remote Agent lost its connection (§10). `unfinished` names what the receipt said, when
it arrived; it never says the message was refused, so a Caller asks `getMessage`, or sends again with the same key,
and does not send again without one.

## 3. Invoke

```ts
interface InvokeRequest {
  /** The session. Absent: the Agent creates one and names it in the receipt. */
  sessionId?: string;
  content: ContentPart[];
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

`content` holds at least one part. A part whose `type` is not among `info().inputs` is refused with
`invalid_request`, before anything is recorded.

A message whose text starts with `/<name>`, for a `name` among `info().commands`, is a command: the Agent expands it
before the model sees it, a prompt template into its text with the words after the name as its arguments, a skill into
an instruction to use it. The `user_message` entry holds what the Caller sent, so a history shows `/review 123`, not
the expansion. A `/` followed by a name the Agent does not know is sent to the model as written. A chat client shows
`commands` as a menu, and a channel can register them as its platform's commands.

### 3.1 The stream

The first event is `accepted` or `rejected`.

- **`rejected`** is the only event of an invoke that was not accepted. Nothing was taken and nothing was recorded, so
  the same request MAY be sent again.
- **`accepted`** names the session and the message. What follows is the message's own (§5.1): `state` events while
  it is queued; once it is taken, its entries from its `user_message`, a `state` snapshot, and live events while it is
  taken. The stream ends with the message's `done` event. Nothing of another message reaches it: a message queued
  behind another gets none of that one's entries, live events or `done`.
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
  and records nothing new. The content is not compared with the first one: the key alone identifies the message. Its
  stream is the same message's stream (§3.1); a duplicate of a done message replays it and ends with its `done`
  (§5.1).
- Looking up the key, recording the message and queueing it are one step per session: concurrent invokes with one key
  produce one message.

### 3.4 Acceptance is durable

Before `accepted` is sent, the message MUST be recorded durably with its id and key, so that `getMessage` and a
duplicate find it after any later restart.

## 4. Messages

```ts
type MessageStatus =
  | { messageId: string; idempotencyKey?: string; status: "queued"; position: number }
  | { messageId: string; idempotencyKey?: string; status: "taken"; entryId: string }
  | DoneMessage;

interface DoneMessage {
  messageId: string;
  idempotencyKey?: string;
  status: "done";
  entryId?: string;
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
the queued messages will be taken, steered ones first.

**`getMessage`** returns a message's status as it is now, by its id or by the key it was sent with, or `undefined`
for a message the session never accepted or a session the Agent does not hold. A Caller that sent a message and lost
its stream asks it, and resumes the session (§5.1) for what the agent writes. A Caller that keys its messages by
something of its own, such as a chat platform's message id, finds a message by that key without keeping a map of its
own.

### 4.1 How a message ends

A message ends exactly once, with one outcome, recorded durably before it is reported.

| What happens | A taken message | A queued message |
|---|---|---|
| The Caller stops reading | The agent goes on | Stays queued, and is taken in its turn |
| `abort` | The agent stops: `canceled` | Withdrawn: `canceled`, without an entry |
| The process stops | Answered after the restart | Stays queued, and is taken in its turn |
| The process stops after `abort` answered and before the message ended | `canceled` after the restart, never answered | (`abort` withdrew it) |

A process that stops does not lose what was accepted: the Agent continues it when it starts again. A tool cut off
mid-call is not run again unless it declares that a second run is safe; the agent is told it was interrupted and
carries on. An Agent MUST NOT redo a message on its own.

These promises, and that an id is never reused (§5), hold as far as the storage the Agent runs on keeps what it was
given. A host whose storage can lose its newest writes when the machine under it fails can lose the newest accepted
messages then, and hand out again the ids that went with them: AgentCore's session storage, after a host failure
([architecture.md](architecture.md) §4.3). A Caller that must not lose a message keeps it until it sees its `done`.

## 5. Sessions

```ts
interface SessionState {
  status: "idle" | "running";
  taken: string[];      // the messages the agent is answering
  queued: string[];     // in the order they will be taken
  /** The agent's message being written, as written so far: present only while one is. */
  reply?: { text: string; thinking?: string };
}
```

The Agent names every session. A Caller gets an id from `createSession` or from an invoke without `sessionId`, and
keeps it. An id is a name, not a credential (§8).

Session, message and entry ids are opaque strings, and the Agent MUST NOT reuse one: within a deployment, an id names
one thing for as long as the deployment exists, even when its storage is rebuilt from empty. An id a Caller kept from
a storage that is gone answers `not_found` (or `undefined`), never another session, message or entry.

- **`createSession`** creates an empty session, or, with `from`, a fork: the new session starts with the source's
  history up to `entryId`, or all of it. A fork shares that history, not messages: its history begins with the
  source's entries themselves, the same ids and the same data, and what it writes afterwards is its own; the source's
  messages, queued or done, stay the source's, and when the source is busy only its recorded entries are shared. An
  unknown source or entry answers `not_found`. `context: "recent"` shares the same history but gives the model only
  its recent part, as a long session is bounded; a `compaction` entry may record the bound. A chat thread starting from its room is the use: it knows
  what the room knew without paying for all of it.
- **`read`** returns the state and one page of entries, after or before an entry cursor, oldest first within the page.
  Without a cursor it returns the newest page, so a Caller opening a long session shows the latest entries and pages
  back from there. `prev` and `next` are the cursors of the adjacent pages, absent at either end. `limit: 0` returns
  the state alone.
- **`resume`** attaches to the session (§5.1).
- **`abort`** stops everything the session does: the agent answering its taken messages, and every queued message,
  steered ones included. It answers once the stop is recorded, without waiting for a running tool to exit, and
  reports the messages it stopped; on an idle session it answers `ok` with nothing stopped. Each stopped message ends
  `canceled`, with its `done`, once the agent has let go of it, and is `taken` until then. `abort` is idempotent: it
  reports every message that has not ended, including one an earlier `abort` already stopped, so a second `abort` while
  a tool ignores its stop still says what is being stopped. Messages invoked after it are taken as usual, once the
  stopped ones have ended.
- **`attachment`** returns the bytes behind a ref an entry of this session published, or `undefined`.

An unknown session answers `not_found` on every operation, and so does an unknown entry cursor, except `getMessage`
and `attachment`, which answer `undefined`.

### 5.1 Attaching: replay, snapshot, live

`resume` attaches to the session; an invoke stream attaches to its message. Both do it in three parts:

1. **Replay.** `resume` replays what `replayFrom` asks for: nothing without it, every entry with `{ type: "start" }`,
   and the entries after `entryId` with `{ type: "after", entryId }`. An invoke stream, once its message is taken,
   replays the message's entries from its `user_message` (§3.1). Replay holds entries only: no live event, and no
   `state` from the past.
2. **Snapshot.** Then a `state` event with the session as it is now MUST be sent, even when nothing was replayed. It
   is the line between the past and the present: a Caller takes the session's status from it, not from the replay,
   and with `reply` it shows an answer that is being written from where it is.
3. **Live.** Then live events and new entries, without a gap or a duplicate after the snapshot. `resume` delivers the
   session's, with a `done` event for each message that ends, and ends only when the Caller stops reading or with a
   `serving_error` (§6). An invoke stream delivers them while its message is taken, and ends with its message's `done`.

Until its message is taken, an invoke stream delivers only `state` events, without `reply`. A duplicate of a message
that is already done attaches to nothing live, so it sends no snapshot: its entries from its `user_message` through
its answer, or its `user_message` alone when it has no answer, or nothing when it was withdrawn before it was taken,
and then its `done`.

The TypeScript client of the HTTP binding does not reconnect on its own: when its connection is lost, it ends the
stream with a `serving_error`, and the Caller resumes after the last entry it had.

A Caller coming back to a session it showed before resumes after the last entry it has. One opening a long session
it never showed reads the newest page and resumes after its last entry.

## 6. Entries and events

```ts
interface Entry {
  id: string;
  /** The session that wrote it: a fork's history begins with entries its source wrote. */
  sessionId: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}
// user_message       { content: ContentPart[], messageId?, idempotencyKey? }
// assistant_message  { text, thinking?, toolCalls?, outcome?, usage?: Usage }
// tool_result        { toolCallId, toolName, isError, content: ContentPart[] }
// compaction         { summary, usage?: Usage }

type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "done"; message: DoneMessage }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "serving_error"; error: AgentError };
```

- Entries are durable, ordered as appended, and each names its parent and the session that wrote it, so a fork shares
  what it inherited. An entry is the same wherever it is read: the same id and the same data in its session and in
  every fork that shares it. Its id is the cursor; `timestamp` is milliseconds since the epoch. Images in an entry are refs, read with `attachment`.
- A `user_message` entry is a message taken, and names it.
- An `assistant_message` entry is published once it is complete, and gets its id then. While it is being written,
  `state.reply` holds it as written so far and `message_delta` events add to it. A session writes one agent message at
  a time, so the deltas need no id: a Caller that attaches mid-answer shows `reply`, appends the deltas that follow,
  drops what it shows on a `retry_scheduled` (the next attempt starts over), and replaces it with the
  `assistant_message` entry when that arrives. The deltas can stop short of the entry: its text is the message.
- An `assistant_message` carries the `usage` of the model response it is, and a `compaction` the `usage` of the model
  calls that wrote its summary. A session's cost is the sum over the entries it wrote, those whose `sessionId` is its
  own; an entry a fork shares is its source's cost. Summed that way, each model call counts once, within a session or
  across sessions.
- `done` reports a message that has ended.
- Every other event is live: a Caller that attaches again gets the entries it missed and the snapshot, not the missed
  deltas.
- `thinking` is the model's reasoning: a Caller MUST NOT fold it into the answer.
- `tool_progress` is the current status line of a running tool, each replacing the last; an Agent MAY drop one its
  Caller has not read. It carries the same trust as the tool's output.
- `serving_error` is the last event of a stream that stops before its ending, and says why: the Agent cannot go on
  serving it (its storage failed: `unavailable`), or, sent by the client of a remote Agent, the connection was lost
  (`unavailable`). It ends the stream, not the message, which may still end and be read with `getMessage`; a Caller
  resumes the session, or asks again, once the Agent is back. No stream stops silently.
- `retry_scheduled` explains a quiet gap while the agent waits to retry a model call.

### 6.1 Extending

Event types, entry kinds, content part types, `info().inputs`, outcome statuses, session statuses and error codes are
open sets: a later version of this specification may add values. A name this specification defines never contains a
`.`; a name an implementation adds MUST, under a prefix of its own (`fastagent.plan`). A Caller:

- ignores an event type it does not know, and an entry kind or content part type it cannot show;
- treats a session status it does not know as busy, and an outcome status it does not know as an end that is not
  `completed`;
- acts on `retryable` for an error code it does not know.

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
| `invalid_request` | A malformed request; a content part the Agent does not take; a key without `sessionId`; `limit` above the maximum | 400 | false |
| `not_found` | An unknown session, fork source or entry cursor | 404 | false |
| `busy` | Admission refused; `details.reason` is `running` (`whenBusy: "reject"`), `queue_full` or `capacity` | 429 | true |
| `missing_model` | The agent has no model | 422 | false |
| `auth_required` | The model provider has no credential | 422 | false |
| `model_error` | The model call failed | 502 | by the provider's answer |
| `unavailable` | The Agent's storage cannot answer now | 503 | true |
| `internal` | Anything else | 500 | false |

A message's `failed` outcome carries `missing_model`, `auth_required`, `model_error` or `internal`.

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

- **A session id is not a credential.** Ids are the Agent's names, and may be sequential. Whoever reaches the Agent
  can reach every session in it: read and resume it, invoke into it, abort it and fork from it. Keeping one user out
  of another's sessions, when several share one deployment, is the job of the layer in front: a facade that maps
  each user to their sessions and admits only those, including the source of a fork and the session an invoke without
  `sessionId` creates ([security-boundary.md](security-boundary.md) §4).
- **A browser is a Caller like any other.** Over HTTP, every `POST` MUST carry `content-type: application/json`,
  whether or not it has a body, and anything else is refused with `invalid_request` before it is read. A `POST` that
  is a form, `text/plain`, or has no body at all is sent cross-origin without a preflight, so withholding a response
  would not stop what it already did: a run started, a session aborted, a session created. Which origins may read the
  answers is the deployment's choice.

## 9. Conformance

An invoke stream ends in exactly one of four ways:

- **(a)** the message's `done` event;
- **(b)** a single `rejected`;
- **(c)** the Caller detaches; the agent goes on;
- **(d)** a `serving_error`: the Agent cannot go on serving the stream, or a client of a remote Agent lost its
  connection. The message is not ended by it, and `result` is `unfinished`.

### Agent MUST

1. **One ending.** A stream the Caller reads to its end holds exactly one `rejected`, or one `accepted` and ends with
   its message's `done` event, unless it stops with a `serving_error` or the process stops. Nothing follows any of
   them.
2. **Failures are events.** Iterating `invoke` or `resume` MUST NOT throw, and a stream MUST NOT stop without saying
   why: a message the agent failed to answer ends with a `failed` outcome, a refusal is `rejected`, and a stream the
   Agent cannot go on serving ends with `serving_error`.
3. **Detaching is not stopping.** When the Caller stops reading, the Agent MUST release what it held for that stream
   and MUST NOT stop the agent. Only `abort` stops it.
4. **Durable messages.** An accepted message is recorded before its receipt (§3.4), ends exactly once, recorded
   before it is reported, and survives a restart of the process (§4.1). The Agent never redoes a message on its own.
5. **One present.** A `resume`, and an invoke stream while its message is taken, sends its `state` snapshot after
   what it replays and before anything live (§5.1).

### Caller MUST

6. **Forward compatibility.** The stream endings `{ done, rejected }` are frozen. A Caller MUST handle values it does
   not know as §6.1 says.
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
| Invoke | `accepted` first; a `/<name>` among `info().commands` is expanded for the model while its `user_message` holds the text as sent, and an unknown `/<name>` is sent as written; the stream ends with the message's `done` and nothing follows; a `rejected` stream records nothing; an invoke without `sessionId` gets a new session, and one into an unknown session is `not_found`; a content part outside `info().inputs` is `invalid_request`; `result` resolves with the same `done` whether or not the events are read, and an invocation first iterated after its message is taken begins with its receipt and replays its entries; a remote invoke whose connection is lost ends with `serving_error` and resolves `result` as `unfinished`, with the receipt's ids once it arrived, never as a rejection; when the storage fails, an in-process invoke and a `resume` end with `serving_error` instead of hanging, and `result` is `unfinished`; iteration never throws; every event is JSON |
| Busy | `queue` messages are taken in arrival order with correct positions; `reject` answers `busy`/`running`; `steer` is `queued` at position 0 until taken, then taken while the session is still busy; a steer the agent did not take before it stopped is taken no later than the messages queued with `queue`; an idle session takes a message for every mode; the 21st queued message is `queue_full`; the process cap is `capacity` |
| Idempotency | A key without `sessionId` is `invalid_request`; a key seen while queued, taken and done returns the same message, `duplicate`, and no second `user_message`; a duplicate's stream ends with the same `done`; concurrent invokes with one key make one message |
| Messages | `getMessage` by id and by key follows a message through queued, taken and done, and answers `undefined` for an unknown one; a detached message is done; `abort` stops the taken message and withdraws the queued ones, all ending `canceled`, reports them, and reports nothing on an idle session; `abort` answers while a tool that ignores its stop still runs, a second `abort` meanwhile reports the same messages, and a message invoked meanwhile is taken once the stopped ones have ended; messages invoked after a failed or aborted one are taken; a done message's duplicate replays its own entry through its answer, or its own entry alone, with no snapshot, and one withdrawn before it was taken delivers only `accepted` and `done`; only a `completed` or `max_tokens` message has an answer, never a reply whose tool calls ran |
| Restart | A message accepted just before a restart is answered after it, and `getMessage` finds it; queued messages survive and are taken; a message `abort` stopped that had not ended when the process stopped ends `canceled` after the restart, unanswered; no message is redone (a tool's effect count does not grow) |
| Attaching | `resume` without `replayFrom` replays nothing; with `start` it replays every entry, with `after` the entries after the cursor; a `resume`, and an invoke stream once its message is taken, sends one `state` snapshot after the replay and before anything live; an invoke stream queued behind another message gets none of that message's entries, live events or `done`, and no `reply` before its own message is taken; one attached mid-answer gets `state.reply`, and it with the deltas that follow is a prefix of the `assistant_message` entry that ends that answer; a reconnect after the last entry it had delivers each entry exactly once; an unknown session or cursor is a single `rejected` |
| Reading | `read` pages by `after`, `before` and `limit`, returns the newest page without a cursor, and `limit: 0` returns the state; a taken message's `user_message` names it; every `assistant_message` and every `compaction` carries `usage`; an entry a fork shares has the same id, data and `sessionId` read from the fork as from its source, and summing each session's own entries counts each model call once; the state moves idle → running → idle |
| Sessions | A fork shares the history up to its entry and none of the messages, and leaves the source unchanged; an unknown fork source is `not_found` |
| HTTP | A `POST` without `content-type: application/json` is refused before it is read, a body-less `abort` included; `Accept: application/json` on an invoke answers `202` and the receipt; `Last-Event-ID` resumes after its entry, and takes precedence over `replay` and `after`; a stream opened without a cursor and cut before its first entry resumes from its snapshot's id and misses no entry written in between |

## 10. HTTP binding

| Operation | HTTP |
|---|---|
| `info` | `GET /agent` |
| `invoke` | `POST /invoke` with the `InvokeRequest`: a `text/event-stream` of `InvokeEvent`s. With `Accept: application/json` the server answers as soon as the message is accepted, with `202` and the `accepted` event's `{ sessionId, message, duplicate }`; the Caller then asks `getMessage`, or resumes the session. A rejection is the error's status with `{ "error": AgentError }` |
| `getMessage` | `GET /sessions/{s}/messages/{m}`, or `GET /sessions/{s}/messages?idempotencyKey=` by key: `200` and the `MessageStatus`, or `200` and `null` for `undefined` |
| `createSession` | `POST /sessions` with `{ from? }`: `201` and `{ sessionId }` |
| `read` | `GET /sessions/{s}?after=&before=&limit=` |
| `resume` | `GET /sessions/{s}/events`, with `?replay=start` or `?after=<entryId>` for `replayFrom`: a `text/event-stream`. Each `entry` event's SSE `id` is the entry id, and the snapshot's is the newest entry id when it was taken, or `start` when the session has none, so a reconnect's `Last-Event-ID` resumes after where the stream had got to even before any entry arrived (`start`: from the first entry). A `Last-Event-ID` header takes precedence over `replay` and `after`: a browser reconnects with the URL it opened and the header, and the header is where it got to. A resume that cannot start is the error's status instead |
| `abort` | `POST /sessions/{s}/abort` |
| `attachment` | `GET /sessions/{s}/attachments/{ref}`: the bytes with their content type, or `404` with no body |

A failed result is answered with its code's status (§7.1) and `{ "error": AgentError }`; a successful one with `200`
and the value without its `ok`. `getMessage` answers an unknown message with `null` rather than `404`, because any
router answers `404` for a path it does not know, and this answer decides whether a Caller sends again.

A connection that fails before the receipt arrives leaves it unknown whether the message was accepted, since the
server answers only once the message is recorded and may still be reading the request. With an `idempotencyKey`,
sending it again settles it: the server answers with the message the key names, or accepts it. Without a key, a
client MUST NOT report the invoke `rejected`: that says nothing was recorded, and a Caller would send it again.

A JSON invoke does not wait for the message to end: an answer can take minutes, longer than the idle timeout of the
proxies in front of most deployments, and a connection cut while waiting would leave a Caller that sent no key without
even the ids to ask about. A Caller that wants to wait reads the event stream, which the TypeScript client of this
binding does to resolve `result`.

## 11. Out of scope

- **Operating the agent**: its model and thinking level, compaction, inspecting or listing sessions, and anything
  else its harness can do. These are the harness's own API, in the process that runs the agent.
- **Listing and deleting sessions**: a Caller keeps the sessions it uses, and nothing is deleted.
- **Identity, authentication, rate limits** (§8).
- **Asking the user**: an agent that waits for a person's approval or answer mid-message. A later version adds it
  under §6.1's rules.
- **Files other than images in a prompt.**
- **Other transports and protocols**: they sit outside and call this API.
- **The agent definition, packaging and deployment**: [architecture.md](architecture.md).

## 12. Changes

From [SPEC v1](../SPEC.md), which the code implements until this API replaces it:

| SPEC v1 | The Agent API |
|---|---|
| A harness-neutral protocol, implemented through a harness port and `LoopPort` | The consumer API of one harness, pi-durable |
| A Caller names a session, or the Agent does | The Agent names every session; ids are opaque and never reused |
| `sessions.list`, `rewind`, `compact`, `update`, `delete`, the `/control` plane, `models` | Gone; operating the agent is pi-durable's own API |
| `commands()` | `info().commands`, which a Caller reads once |
| `messages.get`, `messages.follow`, `messages.cancel` | `getMessage` by id or key; `resume`; `abort` |
| `follow` | `resume`: replay by `replayFrom`, a snapshot that MUST be sent, live; an answer can be joined mid-way |
| An invoke stream that is `messages.follow` of its message | The same, attached to its message, with a snapshot once it is taken |
| `prompt: { text, images }` | `content` parts, checked against `info().inputs` |
| A fork's entries copied, with ids of their own and no `usage` | A fork shares its source's entries; every entry names the `sessionId` that wrote it, and a session's cost is its own entries' |
| `sessions.create({ sessionId, fork })` | `createSession({ from })` |
| `capabilities`, `durableQueue`, `durableTaken` | Gone: durability is a MUST |
| The `intercepted` and `interrupted` outcomes; `source`; `takenAt`, `endedAt` | Gone |
| `collect`; `Accept: application/json` answering `202` | `invocation.result`, which can be `unfinished`; the same `202` |
| `serving_error { message }` | `serving_error { error }`, the stop of a stream that cannot go on |
| A body-only JSON gate | Every `POST` requires `content-type: application/json` |

From v0.1, the last released protocol:

| v0.1 | v1 |
|---|---|
| `invoke(scope, prompt)` | `invoke(request)`: an optional `sessionId`, `content` parts, `idempotencyKey`, `whenBusy` |
| `Scope`, Caller-named sessions, `scope.parentSession` | The Agent names sessions; forking is `createSession` with `from` |
| `text`, `thinking` events | `message_delta`, adding to `state.reply` until the `assistant_message` entry |
| `tool_ended` | The `tool_result` entry |
| `retrying` | `retry_scheduled` |
| A turn, with no id | A message, with an id, a status (`getMessage`) and an outcome that outlive the stream |
| `completed`, `failed` endings | The message's `done` event, with its outcome; `rejected` for a refusal |
| `completed.data` | Gone: a structured result waits for a design |
| MUST 3: the Agent stops when the Caller stops reading | The Caller detaches; `abort` stops the agent |
| A busy session rejected with `session_busy` | `whenBusy`; `busy` with a reason |
| The session control extension (`steer`, `followUp`, `abort`, …) | `whenBusy` and `abort` |
| `collect(events)` | `invocation.result` |
| Nothing about history | `read`, `resume` (replay, snapshot, live), `attachment`, and a durable history of entries |
