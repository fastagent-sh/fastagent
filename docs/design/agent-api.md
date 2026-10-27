---
title: Agent API v2 (proposed)
description: "The proposed second version of the Agent API: one model of sessions, messages and entries, bound in process in TypeScript and over HTTP, with an API key that keeps everyone but the instance's customer out."
type: spec
status: proposed
version: 2.0-draft
updated: 2026-10-27
---

# Agent API v2 (proposed)

> **Status: proposed, not implemented.** The code implements [v1](../SPEC.md). When this is implemented, it replaces
> `docs/SPEC.md`. Changing its semantics before then is a review of this draft.

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

| Caller | Where | What it does |
|---|---|---|
| An app that embeds the agent | In process | Opens the agent directory and calls it like an SDK |
| A program elsewhere | HTTP | Sends a message and waits, polls, or streams the answer |
| A client that shows conversations | HTTP | Lists sessions, reads history, watches a session |
| A channel (Telegram, Slack, Feishu, custom) | In process | Maps a chat to a session, sends, replies |
| Schedules, wake-ups, `fastagent invoke` | In process | Send into a session and wait for the end |

### 1.2 One model, two bindings

The API is one model: an `Agent` with `sessions` and `messages`. It is bound twice, in process as a TypeScript
interface (§8) and over HTTP (§9), with the same names, the same objects and the same errors. An agent opened from its
directory and one reached over HTTP are the same interface, so a Caller moves between them by changing the line that
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

Fields are camelCase; enum values and discriminators are snake_case. Timestamps are milliseconds since the epoch.

```ts
interface AgentInfo {
  name: string;
  description?: string;
  /** The content part types a message may carry; "text" is always among them. */
  inputs: string[];
  /** What a message may start with as `/<name>`: the agent's prompt templates, and `skill:<name>` per skill (§5.1). */
  commands: { name: string; description?: string }[];
  /** The tools a session may enable (`tools`, §4). */
  tools: { name: string; description?: string }[];
  /** The models a session may name: those whose provider has a credential here. */
  models: { provider: string; modelId: string; name?: string }[];
  /** What a session that names no model answers with. */
  defaultModel?: { provider: string; modelId: string };
}

interface Session {
  id: string;
  status: "idle" | "running";
  /** Its settings, as set at creation or by `update`; a field it does not name follows the deployment. */
  model?: { provider: string; modelId: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  instructions?: string;
  tools?: string[];
  /** The messages the agent is answering, and those waiting, in the order they will be taken. */
  running: string[];
  queued: string[];
  /** The agent's reply being written, as written so far: present only while one is. */
  reply?: { text: string; thinking?: string };
  usage: Usage;
  createdAt: number;
  /** The newest of its creation, the messages it accepted and the entries it wrote. */
  lastActiveAt: number;
}

interface Message {
  id: string;
  sessionId: string;
  idempotencyKey?: string;
  status: "queued" | "running" | "completed" | "incomplete" | "failed" | "canceled";
  /** Its `user` entry, once the agent took it. */
  entryId?: string;
  /** The `assistant` entry the agent stopped on for it: present when `completed`, and when `incomplete`. */
  answer?: { entryId: string; text: string };
  /** Why it is `incomplete`. */
  incompleteReason?: "max_tokens";
  /** Why it `failed`. */
  error?: AgentError;
  createdAt: number;
}

interface Entry {
  id: string;
  /** The session that wrote it: a fork's history begins with entries its source wrote. */
  sessionId: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}
// user         { content: ContentPart[], messageId?, idempotencyKey? }
// assistant    { text, thinking?, toolCalls?: { id, name, args }[], stop?: "max_tokens" | "failed" | "aborted", error?, usage }
// tool_result  { toolCallId, toolName, isError, content: ContentPart[] }
// compaction   { summary }

/** Spend by `provider/model` for model calls, and by tool name for what tools reported. */
interface Usage {
  models: Record<string, Tokens>;
  tools: Record<string, Tokens>;
}
interface Tokens { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }

/** An image in a message carries its bytes; in an entry, a ref (§4's `attachment`). */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }   // base64
  | { type: "image"; mimeType: string; ref: string };

interface AgentError {
  code: string;
  message: string;
  /** Whether the same request may succeed if sent again. */
  retryable: boolean;
  details?: Json;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Page<T> { data: T[]; next?: string; prev?: string }
```

**Usage is counted where pi-durable counts it**: per model response (each `assistant` entry's `usage`), per session
(`Session.usage`: every model call, failed and aborted attempts and compactions' summaries included, and what its
tools reported), and for the whole instance (`usage()`, §4). There is no per-message figure: messages the agent
handles together share the calls that answer them, so a per-message figure would be an estimate. A session's entries
add up to less than its `usage`, since no entry records a failed attempt or a compaction's summary.

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
    cancel(sessionId: string): Promise<{ canceled: string[] }>;
    compact(sessionId: string, options?: { instructions?: string }): Promise<void>;
    attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }>;
  };
  messages: {
    send(request: SendRequest & { wait?: number }): Promise<Message>;
    stream(request: SendRequest): AsyncIterable<MessageStreamEvent>;
    get(key: { sessionId: string; messageId: string } | { sessionId: string; idempotencyKey: string },
        options?: { wait?: number }): Promise<Message>;
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

- **`info`** says what the agent accepts and offers.
- **`usage`** is what the instance has spent, across every session (§3).
- **`sessions.create`** creates an empty session, or, with `forkFrom`, a fork: the new session's history begins with
  the source's entries up to `entryId` (all of them without it), the same ids and data, and what it writes afterwards
  is its own. The source's messages stay the source's. A fork takes its source's settings as of that entry, each
  supplied field replacing the inherited one. A setting is stored without checking that the model is available: a
  message into a session whose model is not among `info().models` is refused `missing_model`.
- **`sessions.get`** is the session as it is now.
- **`sessions.list`** lists every session the instance holds, whoever created it (a channel, a schedule, `invoke`, an
  app), most recently active first. `next` is the cursor `after` takes for the next page. A session that becomes active
  while a Caller pages moves to the front, so a later page does not list it. A conversation the harness creates for
  its own work, such as a subagent's, is not a session: it is not listed, and no operation reaches it.
- **`sessions.update`** changes a session's settings, used from its next model request: a message being answered
  continues with them. `instructions` is text added at the end of the agent's system prompt for this session. `tools`
  enables only the named tools, each among `info().tools`; any other name is `invalid_request`.
- **`sessions.entries`** is one page of the history, oldest first within the page, after or before an entry cursor.
  Without a cursor it is the newest page, so a Caller opening a long session shows its latest entries and pages back.
  `prev` and `next` are the cursors of the adjacent pages, absent at either end.
- **`sessions.events`** watches the session (§6).
- **`sessions.cancel`** stops everything the session is doing: the agent answering its running messages, every queued
  message, and a manual compaction not yet placed. It resolves once they have ended, each `canceled`, and lists them;
  on an idle session it lists none. The stop is recorded before it waits, so it holds after a restart. A running tool
  ends when it honors its abort signal, which a tool must; until then `cancel` waits. Messages sent after it are taken
  as usual.
- **`sessions.compact`** asks the agent to summarize the session's older entries now, with `instructions` for the
  summary when given. It resolves once the compaction is accepted. The session keeps working meanwhile; the summary is
  placed at once when the session is idle, otherwise at its next step, and arrives as a `compaction` entry.
- **`sessions.attachment`** is the image behind a ref an entry of this session published.
- **`messages.send`** sends a message (§5). It resolves once the message is recorded, with its status as it is then.
  With `wait`, it resolves once the message has ended, or after `wait` seconds with its status as it is then.
- **`messages.stream`** sends a message and delivers it as it is written (§6.2).
- **`messages.get`** is a message's status, by its id or by the key it was sent with. With `wait`, as `send`'s.

## 5. Messages

### 5.1 Content and commands

`content` holds at least one part, each of a type among `info().inputs`, else `invalid_request`, and nothing is
recorded.

A message whose text starts with `/<name>`, for a `name` among `info().commands`, is a command. The agent expands it
before the model sees it: a prompt template into its text, with the words after the name as its arguments, and
`/skill:<name>` into that skill's instructions, followed by the words after it. The `user` entry holds the message as
sent (`/review 123`), not the expansion. A `/` followed by a name the agent does not have is sent as written.

### 5.2 Idempotency

- A key is unique within its session. A send with a key the session has seen returns that key's message as it is now
  and records nothing; its content is not compared.
- Looking up the key, recording the message and queueing it are one step per session, so concurrent sends with one
  key make one message.
- A Caller that may send again after a failure it cannot read (a timeout, a dropped connection, `unavailable`) sends
  with a key. Without one, such a failure leaves it unknown whether the message was recorded, and sending again may
  record it twice. An `unavailable` rejection carries in `details` the `messageId` when one was recorded.

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
| `incomplete` | The agent's answer was cut off (`incompleteReason`) | The cut-off reply |
| `failed` | It could not be answered: `error` says why (`missing_model`, `auth_required`, `model_error`, `internal`) | None |
| `canceled` | `cancel` stopped it, or withdrew it while it was queued | None |

A reply whose tool calls ran is never an answer.

| What happens | A running message | A queued message |
|---|---|---|
| The Caller stops waiting or watching | The agent goes on | Stays queued |
| `cancel` | Stopped: `canceled` | Withdrawn: `canceled`, without an entry |
| The process stops | Answered after the restart; `canceled` if a `cancel` was stopping it | Stays queued |

A tool cut off by a restart is not run again unless it declares a second run safe; the agent is told it was
interrupted and carries on. The Agent never sends a message again on its own. These promises hold as far as the
storage keeps what it was given: storage that loses its newest writes when its host fails loses the newest messages
with them ([architecture.md](architecture.md) §4.3).

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
  | { type: "error"; error: AgentError };
```

`sessions.events` delivers, in order:

1. **Replay**: the entries after the entry `after` names, every entry with `after: "start"`, none without `after`.
2. **Snapshot**: one `state` event with the session as it is now, even when nothing was replayed. A Caller takes the
   session's status from it, and with `reply` shows an answer being written from where it is.
3. **Live**: everything that happens next, with no gap or repeat after the snapshot. A message's `done` comes before
   the `user` entry of any message taken after it.

It ends when the Caller stops reading, or with an `error` event when the Agent cannot go on serving it; that ends the
stream, not any message. A Caller that comes back passes the id of the last entry it received as `after` and continues
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
session has seen delivers that message the same way: its entries so far, then live, or its entries through its answer
and its `done` when it has ended.

Its entry events carry their ids, so a Caller whose stream dropped continues on the session's events with `after` set
to the last entry it received, and checks the message's end with `messages.get`.

## 7. Errors and limits

| Code | When | `retryable` | HTTP |
|---|---|---|---|
| `invalid_request` | A malformed request; a content part or a tool the agent does not take; a limit exceeded | false | 400 |
| `unauthorized` | No key, or a key the instance does not hold (HTTP only) | false | 401 |
| `not_found` | An unknown session, message, fork source or entry cursor | false | 404 |
| `busy` | Refused by the session or the process: `details.reason` is `running` (`whenBusy: "reject"`) or `queue_full` / `capacity` | true | 409 / 429 |
| `missing_model` | The session names no model the agent has | false | 409 |
| `unavailable` | The Agent's storage cannot answer now | true | 503 |
| `internal` | Anything else | false | 500 |

A message's `failed` status carries `missing_model`, `auth_required`, `model_error` (retryable by the provider's
answer) or `internal` in its `error`.

| Limit | Value |
|---|---|
| Queued messages per session, steered ones not yet taken included | 20, then `busy` / `queue_full` |
| Messages queued and running per process | 100, then `busy` / `capacity` |
| A page (`entries`, `list`) | `limit` defaults to 100, at most 500. An `entries` page MAY hold fewer than `limit` (at most 4 MiB of JSON) but holds at least one when any exist; only an absent `next` or `prev` says the history ends there |
| `idempotencyKey` | 1 to 256 characters |
| `wait` | In seconds. Over HTTP at most 60; a longer wait is a loop of them |

### 7.1 Extending

Event types, entry kinds, content part types, `inputs`, statuses and error codes are open sets: a later version may
add values. A name this specification defines contains no `.`; one an implementation adds MUST, under a prefix of its
own (`fastagent.plan`). A Caller ignores an event type it does not know and an entry kind it cannot show, treats an
unknown session status as busy and an unknown message status as an end that is not `completed`, and acts on
`retryable` for an unknown error code.

## 8. In process (TypeScript)

The interface is §4's. The package's entry points are one per kind of user:

| Import | For | Holds |
|---|---|---|
| `@fastagent-sh/fastagent` | An app or tool on Node or Bun | `openAgent`, the authoring functions (`defineAgent`, `defineChannel`, `defineSchedule`, `needs`), `AgentError` and the types |
| `@fastagent-sh/fastagent/client` | A program anywhere `fetch` runs (Node, Bun, Deno, Workers) | `connectAgent`, `AgentError` and the types |
| `@fastagent-sh/fastagent/<channel>` | An agent's channel file | The first-party channels |

```ts
function openAgent(dir: string, options?: { model?: string; credentials?: CredentialStore }): Promise<LocalAgent>;
function connectAgent(url: string, options: { apiKey: string }): Agent;

interface LocalAgent extends Agent {
  /** Channels, schedules and wake-ups, `/health`, and the HTTP API (§9) when a key is configured. */
  serve(options?: { apiKeys?: string[] }): Promise<Service>;
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  close(): Promise<void>;
}

interface Service {
  fetch(request: Request): Promise<Response>;
  listen(port: number, host?: string): Promise<void>;
  ready: Promise<void>;
  close(): Promise<void>;
}
```

`openAgent` does what `fastagent dev` and `start` do before they serve: it reads the definition, builds its code with
the secrets it declares (a required secret without a value refuses), installs its declared environment, clones its
content and opens the instance's storage, which one process holds at a time. It resolves `dir` to an absolute path.
Nothing reaches the agent until `serve`.

### 8.1 Examples

An app that embeds an agent:

```ts
import { openAgent } from "@fastagent-sh/fastagent";

const agent = await openAgent("./support-agent");
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "Where is order 9231?", wait: 120 });
console.log(message.status, message.answer?.text);
```

The same program against a deployed agent changes one line:

```ts
import { connectAgent } from "@fastagent-sh/fastagent/client";

const agent = connectAgent("https://support.example.com", { apiKey: process.env.SUPPORT_AGENT_KEY! });
```

An answer as it is written:

```ts
for await (const event of agent.messages.stream({ sessionId, content: "Summarize the ticket" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
  if (event.type === "done") finish(event.message);
}
```

Serving the agent inside an app's own server, on Hono:

```ts
const service = await agent.serve();
app.all("/agent/*", (c) => service.fetch(c.req.raw));
```

A custom channel, from the agent's `src/channels/`:

```ts
import { defineChannel } from "@fastagent-sh/fastagent";

export default defineChannel(({ agent, sessionFor }) => ({
  "POST /my-chat": async (request) => {
    const { chatId, text, messageId } = await verifyAndParse(request); // the platform's signature, checked first
    const sessionId = await sessionFor(chatId); // the chat's session, created and recorded the first time
    const message = await agent.messages.send({ sessionId, content: text, idempotencyKey: messageId, wait: 600 });
    await replyTo(chatId, message.answer?.text ?? "Sorry, that did not work.");
    return new Response("ok");
  },
}));
```

`sessionFor(key, { forkFrom? })` is the channel's map from its conversations to sessions, kept in its own state and
created in one order: the session, then the record, then the message.

## 9. HTTP

### 9.1 Requests

- The base is the deployment's URL; every route is under `/v1`. Requests and responses are JSON, except a session's
  or a message's stream (`text/event-stream`) and an attachment (its own type).
- **Authentication**: `Authorization: Bearer <key>`. The keys are `FASTAGENT_API_KEY` in the instance's environment,
  several separated by commas so a key can be replaced without a gap. A wrong or missing key is `401 unauthorized`.
  With no key configured the API is not served, and the startup report says so. `/health` and the channels' routes
  are outside the API and unchanged: each channel verifies its platform.
- **No CORS**: the key is a credential for the whole instance, so a browser never holds it. A browser app calls its own
  backend, which calls the agent.
- A request body over 32 MiB is `413`.

### 9.2 Routes

| Method and path | Operation | Answers |
|---|---|---|
| `GET /v1/agent` | `info` | `AgentInfo` |
| `GET /v1/usage` | `usage` | `Usage` |
| `POST /v1/sessions` | `sessions.create` | `201` `Session` |
| `GET /v1/sessions?limit&after` | `sessions.list` | `Page<Session>` |
| `GET /v1/sessions/{sessionId}` | `sessions.get` | `Session` |
| `PATCH /v1/sessions/{sessionId}` | `sessions.update` | `Session` |
| `GET /v1/sessions/{sessionId}/entries?after&before&limit` | `sessions.entries` | `Page<Entry>` |
| `GET /v1/sessions/{sessionId}/events?after` | `sessions.events` | An event stream (§9.3) |
| `POST /v1/sessions/{sessionId}/cancel` | `sessions.cancel` | `{ "canceled": [...] }` |
| `POST /v1/sessions/{sessionId}/compact` | `sessions.compact` | `202` |
| `GET /v1/sessions/{sessionId}/attachments/{ref}` | `sessions.attachment` | The image's bytes, with its `Content-Type` |
| `POST /v1/sessions/{sessionId}/messages` | `messages.send`, `messages.stream` | `Message`, or an event stream with `"stream": true` |
| `GET /v1/sessions/{sessionId}/messages/{messageId}?wait` | `messages.get` | `Message` |
| `GET /v1/sessions/{sessionId}/messages?idempotencyKey` | `messages.get` by key | `Page<Message>`: the one message, or none |

`POST …/messages` takes `{ content, whenBusy?, wait?, stream? }` and the key as the `Idempotency-Key` header. A send
whose key the session has seen answers with that message and `Idempotent-Replayed: true`.

### 9.3 Event streams

Server-sent events. Each event is `event: <type>` and `data: <the event as JSON>`. An `entry` event also carries
`id: <entry id>`, and only entry events do, so a client's `Last-Event-ID` is the last entry it received, and
reconnecting `GET …/events` with that header (or `?after=`) continues without a gap. `?after=start` replays the whole
history. The server sends a comment line at least every 15 seconds so that proxies keep the connection open.

### 9.4 Errors

A refused request answers the status of §7 with `{ "error": AgentError }`. `429` and `503` carry `Retry-After`.

```bash
curl -s https://support.example.com/v1/sessions -H "Authorization: Bearer $KEY" -d '{}'
curl -s https://support.example.com/v1/sessions/$SESSION/messages -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"content": "Where is order 9231?", "wait": 60}'
```

### 9.5 Where it is served

Wherever the agent is served on a port of its own: `fastagent dev` and `start`, and the Docker, Fly and Railway
deployments, beside the channels' routes and `/health`. Not on AgentCore in this version: its runtime is reached only
through `/invocations`, and the API there needs its own design (a route through the forwarder Lambda, with response
streaming).

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
- **A session id is a name, not a credential.**

## 11. Conformance

One executable suite runs against the in-process `Agent` and against `connectAgent` over a served one, so both
bindings answer the same way. It checks: acceptance before the answer and a refusal that records nothing; one end per
message, kept across a restart, with no tool run twice; idempotent sends, concurrent ones included; `whenBusy`;
`cancel` and its effect on running and queued messages; `get` by id and by key, with `wait`; the three parts of
`events` and a reconnect without a gap; `stream` for a new, a queued, a running and an ended message; `entries`
paging; forks and their settings; `update`, `compact` and `list`; the errors and limits of §7; and over HTTP, the key,
the status codes and the event stream's ids.

## 12. Out of scope

| | Why |
|---|---|
| Deleting a session | pi-durable deletes nothing. A deployment that must erase a conversation cannot yet |
| A message's own usage | Messages handled together share their calls (§3) |
| A structured result | No Caller needs one yet. An agent whose callers need a typed result defines a tool that takes it as its arguments, and they read that tool's `tool_result` entry |
| Asking the user mid-message | Added later, under §7.1 |
| A webhook when a message ends | Added later: `get` with `wait` covers a Caller that can wait, polling the rest |
| Files other than images | |
| A2A and MCP bindings | Each maps onto this model (a session is A2A's `contextId`, a message its Task; a message is an MCP tool call); designed when a Caller needs one |
| The API on AgentCore | §9.5 |

## 13. Changes from v1

| v1 | v2 | Why |
|---|---|---|
| In process only, no network binding | In process and HTTP, with a key | Agents are called like services |
| Ten functions on `Agent` | `sessions.*`, `messages.*`, `info`, `usage` | Named by what they act on, as the HTTP routes are |
| `invoke` | `messages.send` | Says what it does |
| `invoke` without `sessionId` creates a session; a key then needs a session | A message always names its session | One way to start, and no rule about keys without sessions |
| Results as values: `ok`, `error`, `unknown`, `unfinished` | Resolve, or reject with `AgentError` | One failure shape, as HTTP has; a key makes "unknown" a resend |
| `wait()` on the receipt | `send` and `get` with `wait` | Waiting is an option of a request, and works over HTTP |
| `stream(agent, request)` in the Caller | `messages.stream`, served by the Agent | The hard part (a message that is queued, running or ended) is done once |
| `status: "done"` with `outcome.status` | One `status`; `max_tokens` is `incomplete` | One field to read |
| `taken` | `running` | |
| `read` (state and entries; `limit: 0` for the state) | `sessions.get` and `sessions.entries` | One thing each |
| `resume` with `replayFrom` | `sessions.events` with `after` | Named for what it is; `after` is SSE's `Last-Event-ID` |
| `configure` (model, thinking level) | `sessions.update`, also `instructions` and `tools` | |
| `abort` | `sessions.cancel` | |
| — | `sessions.compact` | A Caller may compact a long session |
| — | `usage()`, `info().models`, `info().tools`, `defaultModel` | Spend, and what a session may be set to |
| `user_message`, `assistant_message`, `message_delta`, `retry_scheduled`, `serving_error` | `user`, `assistant`, `delta`, `retrying`, `error` | "Message" means only what a Caller sends |
| `position`, `duplicate`, `protocolVersion`, `context: "recent"` on a fork, the Middleware role | Gone | Nothing used them |
| `openServing`, `mountAgentService`, `/core`, `/node`, `/pi` | `openAgent`, `serve`, and the entry points of §8 | One entry per kind of user |
