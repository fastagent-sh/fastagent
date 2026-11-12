---
title: Agent API — Specification v1
description: "The consumer API of a served FastAgent agent: one model of sessions, messages and entries, bound in process in TypeScript and over HTTP, with an API key that keeps everyone but the instance's customer out."
type: spec
status: current
version: "1.0"
updated: 2026-11-13
---

# Agent API — Specification v1

> **Status: current.** The API every Caller of a FastAgent agent uses: its model, its operations and their behavior,
> its errors, and its two bindings. The schemas in `src/agent-api.ts` define its objects, and `src/http/contract.ts` its
> HTTP binding; the conformance suite (§11) holds the code to this document. Changing its semantics is an explicit
> decision.

> The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## 1. What it is for

A served agent is called the way any service on the internet is: from a program, over HTTP, with a key. One message
can take minutes, the network between a Caller and the agent can drop at any point, and the process that runs the
agent can restart. What the API has to make true is therefore narrow:

- **One accepted message, one end.** A message is recorded before it is acknowledged, ends exactly once, and survives a
  restart.
- **Found again.** A Caller that lost its connection learns what became of its message by id, and its answer.
- **Retried without running twice.** A Caller that does not know whether a send arrived sends it again with the same
  key and gets the same message.
- **Watched as it is written, and picked up again.** A Caller sees the answer as it is written and, after a drop,
  continues from the last thing it saw.

Everything else in this document is naming and shape around those four.

### 1.1 Who calls it

An app that embeds the agent, a program elsewhere over HTTP, a client that shows conversations, and FastAgent's own
channels, schedules and `fastagent invoke`: all of them through this one API, in process or over HTTP.

### 1.2 One model, two bindings

The API is one model: an `Agent` with `sessions` and `messages`. It is bound twice, in process as a TypeScript
interface (§8) and over HTTP (§9), with the same names, the same objects and the same errors. An agent opened in
process and one reached over HTTP are the same interface, so a Caller moves between them by changing the line that
obtains the agent.

## 2. Concepts

| Concept | Is | A Caller |
|---|---|---|
| **Agent** | One served agent, one trust domain (§10) | Asks what it accepts and offers (`info`), and what it has spent (`usage`) |
| **Session** | A conversation: its history of entries, its state, its settings. The Agent names it | Creates, lists, reads, **watches** and configures it; cancels or compacts its work |
| **Message** | One thing a Caller sends into a session, from its acceptance to its end: a status, and the answer | **Sends** it and **checks** on it |
| **Entry** | One durable record in a session's history: what the user said, what the agent wrote, what a tool returned, a compaction | Reads it as history, and receives it as it is written |

```
session s1
├─ message m1 "Where is order 9231?"   completed, answer = e4
│    e1 user · e2 assistant (calls a tool) · e3 tool_result · e4 assistant (the answer)
├─ message m2 "And the refund?"        running
│    e5 user · …
└─ message m3 "Thanks"                 queued, behind m2
```

A session is what a Caller **watches**: one stream of everything that happens in it, picked up again after a drop
(§6). A message is what a Caller **sends and checks**: it exists because the session cannot say what became of one
particular send. Several Callers may write into one session (two browser tabs, a channel and a schedule), so a
session's state says that it is busy, not whether *your* message was answered, and with what.

How the agent answers, in steps, turns or runs, is not part of the API. Two messages the agent handled together may
share an answer; each message's status and answer are its own.

## 3. Objects

Every object, with every field and its type, is defined once: by the schemas in `src/agent-api.ts`, which the package's
type declarations are made from, and over HTTP by the OpenAPI document a server publishes at `/v1/openapi.json`, made
from the same schemas. Fields are camelCase; enum values and discriminators are snake_case; an entry's `timestamp` is
milliseconds since the epoch. What a type does not say:

| Object | Means |
|---|---|
| `AgentInfo` | `name` and `description` are the instance's; `agent.name` and `agent.description` the program's, and neither falls back to the other. `commands` are the names a message may start with (§5.1); `tools`, those a session may enable; `models`, those whose provider has a credential, each with its `contextWindow` (absent when the model declares none) and its `thinkingLevels`, lowest first. `starters`, at most 6, are drafts a client may offer: reading or choosing one sends nothing. `defaultModel` answers a session that names no model |
| `Session` | Named by the Agent. `status` is `idle` or `running`, or a status a later version adds, which a Caller takes for busy (§7.1). Its settings (`model`, `thinkingLevel`, `instructions`, `tools`) are as set; one it leaves out follows the deployment. `reply` is the reply being written, as written so far, present only while one is |
| `Message` | `status` is `queued` or `running` until it ends in one of its four ends: `completed`, `incomplete`, `failed`, `canceled` (§5.4). `entryId` is its `user` entry, once the agent took it. `answer` is the `assistant` entry it stopped on, present when `completed` and when `incomplete`. `error` says why it `failed` |
| `Entry` | `id` is the same in every session that shares it: a fork's history begins with its source's entries, ids and all. `kind` is `user` (the content as sent, and its `messageId`), `assistant` (its text, thinking, tool calls, `usage`, and a `stop` of `max_tokens`, `failed` or `aborted` with its `error`), `tool_result`, or `compaction` (its `summary`) |
| `ContentPart` | Text, or an image: in a message with its bytes (base64), in an entry with a `ref` that `sessions.attachment` resolves |
| `AgentError` | `code` (§7), `message`, `retryable` (whether the same request may succeed if sent again), and `details` |
| `Usage` | Tokens and cost by `provider/model` for model calls, and by tool name for what tools reported |
| `Page` | `data`, and the cursors `next` and `prev` of the adjacent pages, absent at either end |

**Usage is counted where the calls are**: per model response (each `assistant` entry's `usage`), per session
(`Session.usage`: every model call, failed and aborted attempts and compactions' summaries included, and what its tools
reported), and for the whole instance (`usage()`). There is no per-message figure: messages the agent handles together
share the calls that answer them. A session's entries add up to less than its `usage`, since no entry records a failed
attempt or a compaction's summary.

## 4. Operations

```ts
interface Agent {
  info(): Promise<AgentInfo>;
  usage(): Promise<Usage>;
  sessions: {
    create(options?: SessionSettings & { forkFrom?: { sessionId: string; entryId?: string } }): Promise<Session>;
    get(sessionId: string): Promise<Session>;
    list(options?: { limit?: number; after?: string }): Promise<Page<Session>>;
    update(sessionId: string, changes: SessionChanges): Promise<Session>;
    entries(sessionId: string, options?: { after?: string; before?: string; limit?: number }): Promise<Page<Entry>>;
    events(sessionId: string, options?: { after?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent>;
    cancel(sessionId: string): Promise<{ stopped: string[] }>;
    compact(sessionId: string, options?: { instructions?: string }): Promise<void>;
    attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }>;
  };
  messages: {
    send(request: SendRequest, options?: { wait?: number; signal?: AbortSignal }): Promise<Message>;
    stream(request: SendRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent>;
    get(key: { sessionId: string; messageId: string } | { sessionId: string; idempotencyKey: string },
        options?: { wait?: number; signal?: AbortSignal }): Promise<Message>;
  };
}

interface SessionSettings {
  model?: { provider: string; modelId: string };
  thinkingLevel?: Session["thinkingLevel"];
  instructions?: string;
  tools?: string[];
}
/** `null` clears a field back to the deployment's. */
type SessionChanges = { [K in keyof SessionSettings]?: SessionSettings[K] | null };

interface SendRequest {
  sessionId: string;
  /** A string is one text part. */
  content: string | ContentPart[];
  /** The Caller's key for this message, unique within the session (§5.2). */
  idempotencyKey?: string;
  /** What the message is when the session is busy with another (§5.3). Default: "queue". */
  whenBusy?: "queue" | "steer" | "reject";
}
```

Every operation either resolves with what it names or rejects with an `AgentError` (§7). An unknown session, message
or entry cursor rejects `not_found`.

A `signal` lets go of a wait, never of what it waits for. The call rejects with the signal's reason, and what it asked
for goes on: a send that reached the agent is recorded and answered (with a key, sending again finds it, §5.2). A
Caller that stops reading `events` or `stream` detaches the same way. Only `cancel` stops the
agent.

- **`info`** says what the agent accepts and offers.
- **`usage`** is what the instance has spent, across every session (§3).
- **`sessions.create`** creates an empty session, or, with `forkFrom`, a fork: the new session's history begins with
  the source's entries up to `entryId` (all of them without it), the same ids and data, and what it writes afterwards
  is its own. The source's messages stay the source's. A fork takes its source's settings as of that entry, each
  supplied field replacing the inherited one. Settings are stored without checking them against the agent: a message
  into a session whose model the agent does not have is refused `missing_model` (one it has, whose provider has no
  credential here, is taken and fails `auth_required`), and one whose `tools` names a tool not among `info().tools`
  (a later deployment removed it) is refused `missing_tool`, naming it, until `update` changes the setting. A session
  never runs with fewer tools than it names.
- **`sessions.get`** is the session as it is now.
- **`sessions.list`** lists every session the instance holds, whoever created it (a channel, a schedule, `invoke`, an
  app), most recently active first. `next` is the cursor `after` takes for the next page. A session that becomes active
  while a Caller pages moves to the front, so a later page does not list it. A conversation the implementation
  creates for its own work, such as a subagent's, is not a session: it is not listed, and no operation reaches it.
- **`sessions.update`** changes a session's settings, used from its next model request: a message being answered
  continues with them. `instructions` is text added at the end of the agent's system prompt for this session. `tools`
  enables only the named tools, each among `info().tools`; any other name is `invalid_request`.
- **`sessions.entries`** is one page of the history, oldest first within the page, after or before an entry cursor.
  Without a cursor it is the newest page, so a Caller opening a long session shows its latest entries and pages back.
  `prev` and `next` are the cursors of the adjacent pages, absent at either end.
- **`sessions.events`** watches the session (§6).
- **`sessions.cancel`** stops everything the session is doing: the agent answering its running messages, every queued
  message, and a manual compaction not yet placed. It resolves once the stop is recorded, with the messages it stops
  (none on an idle session); each ends `canceled`, which `get` and `events` report. The stop holds after a restart. A running tool
  ends when it honors its abort signal, which a tool must. Messages sent after it are taken as usual.
- **A `cancel` whose answer did not arrive** (a dropped connection, `unavailable`) may or may not have been recorded,
  and sending it again is not the way to find out: it would also stop what was sent since. The Caller reads the
  session (`get`) and the messages it meant to stop, and cancels again only if it still wants everything stopped.
- **`sessions.compact`** asks the agent to summarize the session's older entries now, with `instructions` for the
  summary when given. It resolves once the compaction is accepted. The session keeps working meanwhile; the summary is
  placed at once when the session is idle, otherwise at its next step, and arrives as a `compaction` entry.
- **`sessions.attachment`** is the image behind a ref an entry of this session published.
- **`messages.send`** sends a message (§5). It resolves once the message is recorded, with its status as it is then.
  With `wait`, it resolves once the message has ended, or after `wait` seconds with its status as it is then. Over
  HTTP a wait is at most 60 seconds; `connectAgent` meets a longer one by asking `get` again with what remains, so the
  same `wait` means the same in both bindings.
- **`messages.stream`** sends a message and delivers it as it is written (§6.2).
- **`messages.get`** is a message's status, by its id or by the key it was sent with. With `wait`, as `send`'s.

## 5. Messages

### 5.1 Content and commands

`content` holds at least one part: text, or an image. A part of another type is `invalid_request`, and nothing is
recorded. An image sent to a model that takes none reaches it as a placeholder.

A message whose text starts with `/<name>`, for a `name` among `info().commands`, is a command. The agent expands it
before the model sees it: a prompt template into its text, with the words after the name as its arguments, and
`/skill:<name>` into that skill's instructions, followed by the words after it. The `user` entry holds the message as
sent (`/review 123`), not the expansion.
A `/` followed by a name the agent does not have is sent as written.

### 5.2 Idempotency

- A key is unique within its session. A send with a key the session has seen returns that key's message as it is now
  and records nothing; its content is not compared.
- Looking up the key, recording the message and queueing it are one step per session, so concurrent sends with one
  key make one message.
- A send that may have been recorded and could not be confirmed (the storage failed while recording it, or after)
  rejects `unconfirmed`, never `unavailable`, with the `sessionId` and any `messageId` already known in `details`.
  It is not `retryable`: sending again records a second message unless the send carries a key. With a key, the same
  send is the way to find out; with a `messageId`, `get` is. A dropped connection is the same case, seen from the
  Caller.
- `connectAgent` gives a send without a key one of its own, so that one whose answer was lost rejects `unconfirmed`
  with that key in `details`, which finds it; the Message's `idempotencyKey` shows it. A Caller that retries itself
  passes its own key.
- Only a send is idempotent: it is the one request whose repetition does harm (the agent answers it again, its tools
  act again). A session created twice is an empty session more, which nothing refers to.

### 5.3 A busy session

A session is busy while the agent is answering a message in it. `whenBusy` says what a message that arrives then is:

| `whenBusy` | When the session is busy |
|---|---|
| `queue` (default) | Waits, and is taken once the agent is done with the messages before it, whatever their outcome |
| `steer` | Handed to the agent while it is still busy, to take at its next step (after its current tool calls) rather than after it stops. Ahead of the queued messages until taken |
| `reject` | Rejected `busy`, `details.reason: "running"` |

An idle session takes a message at once, whatever `whenBusy` says. Until it is taken, a steered message is `queued`
like any other.

### 5.4 How a message ends

A message ends exactly once, and its end is recorded before it is reported.

| Status | Means | `answer` |
|---|---|---|
| `completed` | The agent answered it | The `assistant` entry it stopped on |
| `incomplete` | The agent's answer was cut off at its token limit | The cut-off reply |
| `failed` | It could not be answered: `error` says why (`missing_model`, `auth_required`, `model_error`, `internal`) | None |
| `canceled` | `cancel` stopped it, or withdrew it while it was queued | None |

A reply whose tool calls ran is never an answer.

| What happens | A running message | A queued message |
|---|---|---|
| The Caller stops waiting or watching | The agent goes on | Stays queued |
| `cancel` | Stopped: `canceled` | Withdrawn: `canceled`, without an entry |
| The process stops | Answered after the restart; `canceled` if a `cancel` was stopping it; `failed` when no retry is left for what the stop cut off (below) | Stays queued |

A tool cut off by a restart is not run again unless it declares a second run safe; the agent is told it was
interrupted and carries on. A model call cut off by a process that dies counts as one failed attempt of the agent's
model retries, the budget a failing model call spends; a process that closes cleanly is not charged. With no retry
left, or once the same step was cut off by restarts too many times in a row, the message ends `failed` with
`internal`, `details.reason` `interrupted` or `restart_limit`. The Agent never sends a message again on its own. These
promises hold as far as the storage keeps what it was given: storage that loses its newest writes when its host fails
loses the newest messages with them.

## 6. Watching

### 6.1 A session's events

```ts
type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "state"; session: Session }
  | { type: "delta"; channel: "text" | "thinking"; text: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "done"; message: Message }
  | { type: "stream_error"; error: AgentError };
```

`sessions.events` delivers, in order:

1. **Replay**: the entries after the entry `after` names, every entry with `after: "start"`, none without `after`.
2. **Snapshot**: one `state` event with the session as it is now, even when nothing was replayed. A Caller takes the
   session's status from it, and with `reply` shows an answer being written from where it is.
3. **Live**: everything that happens next, with no gap or repeat after the snapshot. A message's `done` comes before
   the `user` entry of any message taken after it.

It ends when the Caller stops reading, or with a `stream_error` event when the Agent cannot go on serving it; that
ends the stream, not any message. (Not `error`: an `EventSource` delivers an event of that name to the same listener
as a dropped connection.) A Caller that comes back passes the id of the last entry it received as `after` and continues
without a gap. What it receives:

- **Entries** are durable: the same id and data wherever they are read, a fork included.
- **`delta`** adds to the reply being written. Deltas are live only: a Caller that attaches mid-answer shows
  `state.session.reply`, appends the deltas that follow, drops what it shows on `retrying` (the next attempt starts
  over), and replaces it with the `assistant` entry when that arrives. `thinking` is the model's reasoning, never part
  of the answer.
- **`tool_started`** and **`tool_progress`** are live: a running tool's call, then its current status line, each
  replacing the last. A `tool_started` may have no `tool_result` when the agent was stopped.
- **`retrying`** explains a pause while a model call waits to be tried again.
- **`done`** reports a message that has ended.

### 6.2 A message as it is written

```ts
type MessageStreamEvent = { type: "message"; message: Message } | SessionEvent;
```

`messages.stream` sends the message and delivers, first, a `message` event with it as recorded, then the session's
events that belong to it: from its `user` entry, once the agent takes it, through its `done`. A send whose key the
session has seen delivers that message the same way: one still running, its entries so far, then a `state` event
whose `reply` holds what is being written, then live; one that has ended, its entries through its answer, then its
`done`.

Its entry events carry their ids, so a Caller whose stream dropped continues on the session's events with `after` set
to the last entry it received, and checks the message's end with `messages.get`.

## 7. Errors and limits

| Code | When | `retryable` | HTTP |
|---|---|---|---|
| `invalid_request` | A malformed request; a content part or a tool the agent does not take; a limit exceeded. A body over the HTTP limit is this code with `details.reason: "too_large"` | false | 400; 413 for a body too large |
| `unauthorized` | No key, or a key the instance does not hold (HTTP only) | false | 401 |
| `not_found` | An unknown session, message, fork source or entry cursor | false | 404 |
| `busy` | `details.reason: "running"`: refused by a busy session (`whenBusy: "reject"`) | true | 409 |
| `busy` | `details.reason: "queue_full"`: the session's queue is full | true | 429, with `Retry-After` |
| `busy` | `details.reason: "capacity"`: the process holds as many messages as it takes | true | 503, with `Retry-After` |
| `missing_model` | The session names no model the agent has | false | 409 |
| `missing_tool` | The session's `tools` names a tool the agent no longer has (`details.tools`) | false | 409 |
| `unconfirmed` | A send may have been recorded and could not be confirmed (§5.2); `details` holds what is known | false | 500 |
| `unavailable` | The Agent cannot answer now (its storage, or over HTTP the connection or a server on the way), and the same request may be sent again: nothing was recorded, or repeating it does no harm (an update or a cancel again, another compaction, an empty session a lost `create` left behind). A send that may have been recorded is `unconfirmed` instead (§5.2) | true | 503, with `Retry-After` |
| `internal` | Anything else | false | 500 |

A message's `failed` status carries `missing_model`, `auth_required`, `model_error` (retryable by the provider's
answer) or `internal` in its `error`.

The limits are an implementation's. A Caller handles the refusal each one answers, and does not depend on its value;
these are FastAgent's:

| Limit | Value |
|---|---|
| Queued messages per session, steered ones not yet taken included | 20, then `busy` / `queue_full` |
| Messages queued and running per process | 100, then `busy` / `capacity` |
| A page (`entries`, `list`) | `limit` defaults to 100, at most 500. An `entries` page MAY hold fewer than `limit` (at most 4 MiB of JSON) but holds at least one when any exist; only an absent `next` or `prev` says the history ends there |
| `idempotencyKey` | 1 to 256 characters |
| `wait` | In seconds. Over HTTP the server waits at most 60, a larger value included, and answers with the message as it is then; `connectAgent` asks again until the Caller's `wait` is met |

### 7.1 Versions and extending

This is version 1 of the API, and its HTTP binding is served under `/v1`. Within a version the API changes only by
the additions this section allows; a change that would break a Caller who follows it is a new version, under a new
path prefix.


Event types, entry kinds, content part types, statuses and error codes are open sets: a later version may
add values. A name this specification defines contains no `.`; one an implementation adds MUST, under a prefix of its
own (`fastagent.plan`). A Caller ignores an event type it does not know and an entry kind it cannot show, treats an
unknown session status as busy, and acts on `retryable` for an unknown error code.

A message's ends are a closed set: `completed`, `incomplete`, `failed` and `canceled`, and no later version adds one.
Any other status, known or not, is a message that has not ended, which a Caller goes on waiting for or watching. So a
later version can add a state in which a message waits (for a person's answer, say) without an older Caller taking it
for an end.

## 8. In process (TypeScript)

The in-process binding is §4's `Agent` interface, with §3's objects, and every refusal an `AgentError` (§7), which
`instanceof AgentError` tells apart. `openAgent` (from `@fastagent-sh/fastagent`) answers one for an agent opened in
the Caller's process; `connectAgent(url, { apiKey })` (from `@fastagent-sh/fastagent/client`) answers one over HTTP
(§9), so a Caller moves between the two by changing the line that obtains the agent. How an agent is opened and
served in process is FastAgent's own API, described by its declarations and by [Embedding](embedding.md).

```ts
const agent = connectAgent("https://support.example.com", { apiKey: process.env.SUPPORT_AGENT_KEY! });
// or: const agent = await openAgent(support, { root: "/var/lib/myapp/support" });
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "Where is order 9231?" }, { wait: 120 });
console.log(message.status, message.answer?.text);
```

Over HTTP, its 120-second wait is two requests of 60 (§4).

## 9. HTTP

### 9.1 Requests

- The base is the deployment's URL; every route is under `/v1`. Requests and responses are JSON, except a session's
  or a message's stream (`text/event-stream`) and an attachment (its own type).
- **Authentication**: `Authorization: Bearer <key>`. A server holds one or more keys, so a key can be replaced without
  a gap; a wrong or missing key is `401 unauthorized`. A server with no key does not serve the API.
- **No CORS**: the key is a credential for the whole instance, so a browser never holds it. A browser app calls its own
  backend, which calls the agent.
- A request body over 32 MiB is `413`, `invalid_request` with `details.reason: "too_large"`. A request the API
  cannot read (its path, query, headers or body, or a body sent as another type than `application/json`) is
  `400 invalid_request`, and a route it does not have is `404 not_found`.

### 9.2 Routes

| Method and path | Operation | Answers |
|---|---|---|
| `GET /v1/agent` | `info` | `AgentInfo` |
| `GET /v1/usage` | `usage` | `Usage` |
| `GET /v1/openapi.json` | — | This API as an OpenAPI 3.1 document, generated from the contract the server and `connectAgent` are built from, so it cannot describe another API than the one served |
| `POST /v1/sessions` | `sessions.create` | `201` `Session` |
| `GET /v1/sessions?limit&after` | `sessions.list` | `Page<Session>` |
| `GET /v1/sessions/{sessionId}` | `sessions.get` | `Session` |
| `PATCH /v1/sessions/{sessionId}` | `sessions.update` | `Session` |
| `GET /v1/sessions/{sessionId}/entries?after&before&limit` | `sessions.entries` | `Page<Entry>` |
| `GET /v1/sessions/{sessionId}/events?after` | `sessions.events` | An event stream (§9.3) |
| `POST /v1/sessions/{sessionId}/cancel` | `sessions.cancel` | `{ "stopped": [...] }`, once the stop is recorded |
| `POST /v1/sessions/{sessionId}/compact` | `sessions.compact` | `202` |
| `GET /v1/sessions/{sessionId}/attachments/{ref}` | `sessions.attachment` | The image's bytes, with its `Content-Type` |
| `POST /v1/sessions/{sessionId}/messages` | `messages.send`, `messages.stream` | `Message`, or an event stream with `"stream": true` |
| `GET /v1/sessions/{sessionId}/messages/{messageId}?wait` | `messages.get` | `Message` |
| `GET /v1/sessions/{sessionId}/messages/by-key/{idempotencyKey}?wait` | `messages.get` by key | `Message`; `404` when the session has seen no such key |

`POST …/messages` takes the `SendRequest` without its `sessionId`, which is in the path, plus `wait` (§4's option)
and `stream: true` for `messages.stream`: `{ content, whenBusy?, wait?, stream? }`; a streamed message is watched,
so `wait` beside `stream: true` is refused, `invalid_request`. A request whose options may be left out
(`POST /v1/sessions`, `…/compact`) may come without a body. Its key is the `Idempotency-Key`
header, percent-encoded there as in the `by-key` path, since a header holds neither every character a key may have
nor the spaces around it (a key of letters, digits and `-_.~` reads the same either way). A send whose key the session has seen answers with that message, as
§5.2 says. Every `wait` is in seconds, and the server waits at most 60 (§7).

### 9.3 Event streams

Server-sent events. Each event is `event: <type>` and `data: <the event as JSON>`. An `entry` event also carries
`id: <entry id>`, and only entry events do, so a client's `Last-Event-ID` is the last entry it received, and
reconnecting `GET …/events` with that header continues without a gap. A `Last-Event-ID` header takes precedence over
`?after=`: an `EventSource` reconnects to the URL it opened, `?after=start` included, and adds the header, and the
header is where it got to. `?after=start` replays the whole history. The server sends a comment line at least every
15 seconds so that proxies keep the connection open.

### 9.4 Errors

A refused request answers the status §7 gives its code, with `{ "error": AgentError }`. `Retry-After` is on the
`429` and `503` answers §7 names.

```bash
curl -s https://support.example.com/v1/sessions -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{}'
SEND=$(uuidgen)   # one key per message: running the next line again is the same message
curl -s https://support.example.com/v1/sessions/$SESSION/messages -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $SEND" \
  -d '{"content": "Where is order 9231?", "wait": 60}'
```

## 10. Security model

- **One instance is one trust domain.** Whoever holds a key can do everything the API can, in every session, and the
  agent's tools act with the authority of the process that runs them. Sessions in one instance are not kept from each
  other.
- **One instance per customer.** People who must not read each other's conversations get an instance each. The key
  keeps everyone else out; it does not divide an instance.
- **A key is a credential for the instance**, kept server-side, sent only over HTTPS, and replaced by adding the new
  one, moving the Callers, and removing the old.
- **Everyone a channel lets through is inside the trust domain.** A platform's signature proves the platform, not the
  person: everyone who can message a channel's bot can ask the agent for anything its tools reach.
- **A session id is a name, not a credential.** A Caller that serves people of its own over one instance checks every
  session id their requests name, the source of a fork included.

## 11. Conformance

The conformance suite, `test/agent-api-conformance.ts`, runs against the in-process `Agent` and against `connectAgent`
over a served one, so both bindings answer the same way; `test/http-api.test.ts` checks what only the HTTP binding has.
They are this document in executable form: a promise here that no test there checks is a gap to close.

## 12. Out of scope

| | Why |
|---|---|
| Deleting a session | Not yet: a deployment that must erase a conversation cannot |
| A message's own usage | Messages handled together share their calls (§3) |
| A structured result | No Caller needs one yet. An agent whose callers need a typed result defines a tool that takes it as its arguments, and they read that tool's `tool_result` entry |
| Asking the user mid-message | Added later, under §7.1 |
| A webhook when a message ends | Added later: `get` with `wait` covers a Caller that can wait, polling the rest |
| Files other than images | |
| A2A and MCP bindings | Each maps onto this model (a session is A2A's `contextId`, a message its Task; a message is an MCP tool call); designed when a Caller needs one |
