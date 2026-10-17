---
title: Agent Handler — Protocol Specification v1
description: "Agent Handler protocol v1: sessions, runs that outlive their callers, durable entries, admission and idempotency, so any caller can work with any served agent without knowing its harness."
type: spec
status: locked
version: 1.0
updated: 2026-10-16
---

# Agent Handler — Protocol Specification v1

> **Status: locked.** This is the protocol the package implements. Changing its semantics needs an explicit decision.
> The design, with its rationale, is [agent-service.md](design/agent-service.md) §7 and §9.

> The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119. This specification is
> harness-neutral and does not depend on any implementation.

## 1. Overview

There are three roles:

- **Agent**: the served agent. It takes messages into sessions, runs them, and records what happened. It is a black
  box to the Caller.
- **Caller**: whoever uses it: an app, a client, another agent, and the implementation's own channels, schedules and
  wake-ups.
- **Middleware**: both a Caller and an Agent. It wraps a downstream Agent while exposing the same interface, for
  authentication, budgets, logging and the like.

The protocol has four concepts:

| Concept | Is | Exposed as |
|---|---|---|
| **Session** | A conversation: the runs of one session share its history | An id, named by the Caller or by the Agent (§3, §5) |
| **Message** | One thing said in a session, by a user or by the agent | Content only, in entries and live text. No id and no operations |
| **Run** | One stretch of the agent working: from taking a message to stopping, across model calls and tool calls | `runId`, with a status, events and a cancel (§4). A session runs one run at a time |
| **Entry** | One record in a session's history | An id that is the cursor for reading and the point for forking (§6) |

A user message is taken by exactly one run. A run takes one user message or more, writes the agent's messages and
tool results, and ends with one outcome. A *step*, one model request and the tool calls it causes, belongs to the
harness and is not part of the protocol. v0.1's *turn* is a run.

Fields are camelCase; enum values and discriminators are snake_case. A field that refers to another object names its
kind: `sessionId`, `runId`, `entryId`, `parentEntryId`.

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
  runs: {
    get(key: { runId: string } | { idempotencyKey: string }): Promise<RunStatus | undefined>;
    follow(runId: string, options?: { after?: string }): AsyncIterable<FollowEvent>;
    cancel(runId: string): Promise<Result>;
  };
}

/** A follow that cannot start (an unknown session, run or cursor) is a single `rejected`. */
type FollowEvent = SessionEvent | { type: "rejected"; error: AgentError };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface ImageRef { mimeType: string; data: string }        // base64
interface Attachment { mimeType: string; data: string }      // base64
interface ModelDescriptor { spec: string; name?: string; thinkingLevels: string[]; contextWindow?: number }
interface AgentCommand { name: string; description?: string; source: string }
```

Every operation that returns a `Promise` resolves, and failures are values, not rejections. The exception is the reads
whose answer has no failure branch: `sessions.list`, `runs.get`, `attachment`, `models` and `commands` MAY reject with
an `AgentError` of code `unavailable` when the Agent's storage cannot answer, because an empty list or `undefined`
would be a false answer (`runs.get` answering `undefined` says the run was never accepted). Over HTTP the rejection is
`503` with `{ "error": AgentError }`. Every event, entry and result MUST be JSON-serializable.

## 3. Invoke

```ts
interface InvokeRequest {
  /** The session. Absent: the Agent creates one and names it in the receipt. */
  sessionId?: string;
  prompt: { text: string; images?: ImageRef[] };
  /** What the message is when the session is running another run. Default: "queue". */
  whenBusy?: "queue" | "steer" | "reject";
  /** The Caller's key for this message, unique within the session. Requires sessionId. */
  idempotencyKey?: string;
  /** What started the run. Set in process only (§3.5). */
  source?: { kind: "channel" | "schedule" | "wake"; name?: string };
}

type InvokeEvent =
  | { type: "accepted"; sessionId: string; run: RunStatus; joined: boolean; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | SessionEvent;
```

### 3.1 The stream

The first event is `accepted` or `rejected`.

- **`rejected`** is the only event of an invoke that was not accepted. Nothing ran and nothing was recorded, so the
  same request MAY be sent again.
- **`accepted`** names the session and the run. What follows is `runs.follow(runId)` without a cursor: the entries
  the run has recorded so far, from its `run_started`, then its live events (every `SessionEvent` whose `runId`, or
  whose entry's `runId`, is the run's), and MAY include `state` and `serving_error` events. The stream ends after the
  run's `run_ended` entry. So a duplicate or a steered message (§3.2, §3.3) sees the whole run, whether it is
  queued, running or has ended.
- A Caller that stops reading **detaches**: the run goes on, and the Caller can come back to it with `runs.get` and
  `runs.follow`. Stopping work is `runs.cancel`, `abort` or `delete` (§4.2).

### 3.2 A busy session

`whenBusy` says what a message that arrives while the session runs another run is:

| `whenBusy` | When the session is running another run |
|---|---|
| `queue` (default) | A new run, queued. Queued runs start in arrival order, each when the runs before it end, whatever their outcome |
| `steer` | Joins the running run (`joined: true`, and `run` is that run), which takes the message after its current tool round. A run MUST NOT end while it holds a steered message it has not taken. A run canceled or aborted before taking it withdraws it: the message stays in the run's `messages`, without an entry. An Agent whose `capabilities.steer` is false rejects it with `unsupported` |
| `reject` | Rejected with `busy`, `details.reason: "running"` and `details.runId` |

An idle session starts a run whatever `whenBusy` says.

### 3.3 Sessions and idempotency

- A Caller that names a session gets it; an invoke into a session that does not exist creates it empty. A Caller that
  names none gets a new session per invoke, named in the receipt. Session ids are opaque strings owned by whoever
  named them; `""`, `.` and `..` are refused with `invalid_request`, because a URL cannot address them.
- An `idempotencyKey` is unique within its session and requires `sessionId` (else `invalid_request`). An invoke with a
  key the session has seen returns that key's run, `duplicate: true`, `run` as it is now, and records nothing new. The
  message is not compared with the first one: the key alone identifies it.
- Looking up the key, recording the run and queueing it are one step per session: concurrent invokes with one key
  produce one run.
- One exception: when the key's run ended `interrupted` (§4.1), the invoke starts a new run for the message, which the
  key names from then on, and the receipt says `duplicate: false`. `runs.get({ idempotencyKey })` returns the key's
  newest run.

### 3.4 Acceptance is durable

Before `accepted` is sent, the run MUST be recorded with its id, key and source, so that `runs.get` finds it after any
later restart. `runs.get` answers `undefined` only for a run that was never accepted, or whose session was deleted.

### 3.5 Source

Channels, schedules and wake-ups name themselves in `source`, in process, and the run records it. A remote Caller
cannot: a transport MUST reject a request that carries `source` with `invalid_request`, and the run records
`{ kind: "api" }`.

## 4. Runs

```ts
type RunStatus = {
  runId: string;
  source?: { kind: "channel" | "schedule" | "wake" | "api"; name?: string };
  /** The user messages it took: the one that started it and those steered into it. */
  messages: { entryId?: string; idempotencyKey?: string }[];
} & (
  | { status: "queued"; position: number }
  | { status: "running"; startedAt: number }
  | { status: "done"; startedAt?: number; endedAt: number; outcome: RunOutcome; usage?: Usage;
      answer?: { entryId: string; text: string } }
);

type RunOutcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "intercepted" }    // a command or extension took the message; no model was called
  | { status: "interrupted" }    // the process stopped before the run ended, running or queued
  | { status: "canceled"; by: "cancel" | "abort" | "delete" }
  | { status: "failed"; error: AgentError };

interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number }
```

`answer` is the run's last `assistant_message`. Times are milliseconds since the epoch.

### 4.1 How a run ends

A run's outcome is recorded as exactly one `run_ended` entry. A run that started also has one `run_started` entry
before every other entry it wrote. A queued run withdrawn before it started has a `run_ended` entry and no
`run_started`.

A run that was accepted, has not ended, and is neither running nor queued is `interrupted`. The Agent writes its
`run_ended` entry the first time it opens the session after the run stopped, before it answers any operation on that
session, so a `runs.follow` or `follow` that reattaches after a restart reaches it without the session running again. Whether a running run
continues after a restart, and whether queued runs survive one, is the Agent's `durableRuns` and `durableQueue`
capability (§7.3):

| What happens | A running run | A queued run |
|---|---|---|
| The Caller stops reading | Continues | Stays queued, and runs in its turn |
| `runs.cancel` | Stops: `canceled` by `cancel` | Withdrawn: `canceled` by `cancel` |
| `abort` | Stops: `canceled` by `abort` | Withdrawn: `canceled` by `abort` |
| `delete` | Stops: `canceled` by `delete` | Withdrawn: `canceled` by `delete` |
| The process stops | Continues with `durableRuns`; otherwise `interrupted`, and what it recorded stays | Stays queued with `durableQueue`; otherwise `interrupted` without starting |

An Agent MUST NOT rerun a run on its own: its tools may already have had effects. A Caller that owes an answer may
invoke again with the message's key (§3.3).

### 4.2 Operations

- **`runs.get`** returns a run by id or by key, or `undefined` (§3.4).
- **`runs.follow`** is the session's events for one run, after an entry cursor, or from the run's first entry without
  one: a Caller that lost its invoke stream reattaches without following the whole session. It ends after the run's `run_ended` entry.
- **`runs.cancel`** withdraws a queued run or stops a running one; runs queued after it start as usual. A run that has
  ended answers `conflict`.

## 5. Sessions

```ts
interface SessionState {
  name?: string;
  status: "idle" | "running" | "compacting";
  run?: { runId: string; startedAt: number };
  queued: { runId: string; idempotencyKey?: string; preview: string }[];
  model?: string; thinkingLevel?: string; thinkingLevels?: string[];
  context?: { tokens?: number; window?: number };
  leafEntryId?: string;
}

interface SessionSummary {
  sessionId: string; name?: string; status: "idle" | "running";
  createdAt: number; updatedAt: number; preview?: string;
}

type AbortResult =
  | { ok: true; stopped: { runId?: string; queued: string[]; compaction: boolean } }
  | { ok: false; error: AgentError };
```

- **`sessions.create`** names the session, or lets the Agent name it, and is the only way to fork: the new session
  starts with the source's history up to `entryId`, or all of it. A fork copies history, not runs, and copies only
  recorded entries when the source is running. An existing `sessionId` answers `conflict`, an unknown fork source
  `not_found`, and a fork without `capabilities.fork` `unsupported`. `context: "recent"` copies the same history but
  asks the Agent to give the model only its recent part, as it would bound a long session; a `compaction` entry may
  record the bound. A chat thread starting from its room is the use: it knows what the room knew without paying for
  all of it. An Agent that does not manage context treats it as `"full"`, the default.
- **`sessions.list`** returns every session the Agent holds, or rejects with `unavailable` (§2).
- **`read`** returns the state and one page of entries, after or before an entry cursor, oldest first within the page.
  Without a cursor it returns the newest page, so a client opening a session reads the latest entries and then follows
  from the last one. `next` and `prev` are the cursors of the adjacent pages, absent at either end. `limit: 0` returns
  the state alone.
- **`follow`** returns the entries after the cursor (from the beginning without one), then live events, without a gap
  or a duplicate between the two.
- **`attachment`** returns the bytes behind a ref an entry of this session published, or `undefined`.
- **`abort`** stops everything the session does: the running run, every queued run and a manual compaction. It reports
  what it stopped; on an idle session it answers `ok` with nothing stopped.
- **`rewind`** moves the session's active branch to an entry; the next run continues from there. Nothing is deleted.
  A running session answers `busy`.
- **`compact`** summarizes the history; with nothing to summarize it answers `nothing_to_compact`, and on a running
  session `busy`.
- **`update`** sets the session's name, model and thinking level, applied from the next run. A field outside
  `capabilities.updatable` answers `unsupported`. A multi-field update that wrote some fields and then failed answers
  `partial_update`.
- **`delete`** cancels the session's runs (`canceled` by `delete`), whose open streams still end with their
  `run_ended`, and removes the session.

An unknown session answers `not_found` on every operation but `invoke`, which creates it, and `runs.get` and
`attachment`, which answer `undefined`. So does an unknown entry cursor or entry id. A call beyond the Agent's capabilities answers `unsupported`; it is never ignored.

## 6. Entries and events

```ts
interface Entry {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  runId?: string;      // the run that wrote it
  kind: string;
  data: Json;
}
// user_message       { text, images?, idempotencyKey?, source? }
// assistant_message  { text, thinking?, toolCalls?, outcome? }
// tool_result        { toolCallId, toolName, isError, text, images? }
// run_started        {}
// run_ended          { outcome: RunOutcome, usage?: Usage }
// settings_changed   { name?, model?, thinkingLevel? }
// compaction         { summary, firstKeptEntryId }

type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; runId: string; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; runId: string; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; runId: string; toolCallId: string; text: string }
  | { type: "retry_scheduled"; runId?: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "serving_error"; message: string };
```

- Entries are durable, ordered as appended, and each names its parent, so branches share what they inherited. An
  entry's id is the cursor. Images in an entry are refs, read with `attachment`.
- Every other event is live: a Caller that reconnects sees the entries it missed, not the deltas.
- `message_delta` events add up to the run's current agent message until its `assistant_message` entry arrives.
  `thinking` is the model's reasoning: a Caller MUST NOT fold it into the answer.
- `tool_progress` is the current status line of a running tool, each replacing the last; an Agent MAY drop one its
  Caller has not read. It carries the same trust as the tool's output.
- `retry_scheduled` explains a quiet gap while the harness waits to retry; `runId` is absent for a retry outside a run.

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
    durableQueue: boolean;   // queued runs survive a restart
    durableRuns: boolean;    // a running run continues after a restart
    toolProgress: boolean; usage: boolean;
  };
}
```

### 7.1 Error codes

| Code | When | HTTP | `retryable` |
|---|---|---|---|
| `invalid_request` | A malformed request; `source` from a remote Caller; a key without `sessionId`; an id no URL can address; `limit` above the maximum | 400 | false |
| `unsupported` | An operation or option beyond `capabilities` | 501 | false |
| `not_found` | An unknown session, entry or run where one must exist | 404 | false |
| `conflict` | `sessions.create` of an existing id; `runs.cancel` of an ended run | 409 | false |
| `busy` | Admission refused (`details.reason`: `running` with `runId`, `queue_full`, `capacity`); `rewind` or `compact` on a running session | 429 | true |
| `missing_model` | Neither the session nor the agent sets a model | 422 | false |
| `auth_required` | The model provider has no credential | 422 | false |
| `model_error` | The model call failed | 502 | by the provider's answer |
| `nothing_to_compact` | `compact` with nothing to summarize | 409 | false |
| `partial_update` | `update` wrote some fields, then failed; the only `ok: false` behind which durable work landed | 500 | false |
| `unavailable` | The Agent's storage cannot answer now | 503 | true |
| `internal` | Anything else | 500 | false |

A run's `failed` outcome carries `missing_model`, `auth_required`, `model_error` or `internal`. An implementation MAY
add codes under its own prefix (`pi.…`). A Caller that meets an unknown code acts on `retryable`.

### 7.2 Limits

| Limit | Value |
|---|---|
| Queued runs per session | 20; the next is rejected `busy` / `queue_full` |
| Runs in flight per process, queued and running together | Implementation-defined (the reference implementation: 100); past it, `busy` / `capacity` |
| `read` page | `limit` defaults to 100; above 500 is `invalid_request`. A page MAY hold fewer entries than `limit` (the reference implementation stops at 4 MiB of JSON) but holds at least one when any exist past the cursor |
| `idempotencyKey` | 1 to 256 characters |

A Caller MUST NOT infer the end of the history from a short page: only an absent `next` (or `prev`) says so.

### 7.3 Capabilities

`info()` is fixed for the Agent's life, so a Caller may read it once. A capability that is false makes its operation
answer `unsupported`: `steer` (`whenBusy: "steer"`), `fork` (`sessions.create` with `fork`), `rewind`, `compaction`
(`compact`), `delete`, and every field outside `updatable`. `durableQueue` and `durableRuns` change no operation;
they say what a restart preserves (§4.1). Without `toolProgress` no `tool_progress` event is sent; without `usage`,
`usage` is absent.

## 8. Conformance

An invoke stream ends in exactly one of four ways:

- **(a)** the run's `run_ended` entry;
- **(b)** a single `rejected`;
- **(c)** the Caller detaches; the run goes on;
- **(d)** the process stops; the run is then `durableRuns`-continued or `interrupted`.

### Agent MUST

1. **One ending.** A stream the Caller reads to its end holds exactly one `rejected`, or one `accepted` and ends with
   its run's `run_ended` entry, unless the process stops. Nothing follows either.
2. **Failures are events.** Iterating `invoke`, `follow` or `runs.follow` MUST NOT throw. A failed run ends with a
   `failed` outcome; a refusal is `rejected`.
3. **Detaching is not stopping.** When the Caller stops reading, the Agent MUST release what it held for that stream
   and MUST NOT stop the run. Only `runs.cancel`, `abort` and `delete` stop work.
4. **Durable acceptance.** An accepted run is recorded before its receipt (§3.4), and ends with one `run_ended` entry
   (§4.1). The Agent never reruns a run on its own.
5. **Capabilities are honest.** An operation beyond `info().capabilities` answers `unsupported`; nothing is silently
   ignored, emulated or downgraded.

### Caller MUST

6. **Forward compatibility.** The stream endings `{ run_ended, rejected }` are frozen. New event types and entry kinds
   are non-ending; a Caller MUST ignore an event type or entry kind it does not know.
7. **Relay passthrough.** Middleware that relays a stream MUST pass unknown events through unchanged.

### Portable conformance (optional)

8. **Process affinity only while a run is active.** A session's calls MUST NOT need to reach one process while the
   session is idle: its state is reconstructible from external storage. While a run is active or queued, they MAY
   need to reach the process running it; portable deployment therefore needs a session router in front that sends a
   session's calls to that process.

### Not guaranteed

- **Atomic runs.** A run that ends `failed`, `canceled` or `interrupted` may have recorded entries and run tools with
  effects. `retryable` says whether sending again may succeed, not that doing so is free of repeated effects.
- **Paired tools.** A `tool_started` may have no `tool_result` when its run was stopped.

### The conformance suite

One executable suite, run against every harness in process and through the HTTP binding, checks:

| Area | Checks |
|---|---|
| Invoke | `accepted` first; the stream ends after the run's `run_ended` and nothing follows; a `rejected` stream records nothing; an invoke without `sessionId` gets a new session; iteration never throws; every event is JSON |
| Busy | `queue` runs in arrival order with correct positions; `reject` answers `busy`/`running`; `steer` joins the running run (or `unsupported`); an idle session starts a run for every mode; the 21st queued run is `queue_full`; the process cap is `capacity` |
| Idempotency | A key seen while queued, running and done returns the same run, `duplicate`, and no second `user_message`; a duplicate's stream replays the run from its `run_started`, so `collect` over it returns the same answer as over the first; concurrent invokes with one key make one run; an `interrupted` run's key starts a new run, and `runs.get` by key returns it |
| Runs | A detached run completes; `runs.follow` resumes from a cursor; `runs.cancel` stops a running run and withdraws a queued one while the rest run; `abort` stops all and reports it, and reports nothing on an idle session; the queue continues after a failed run |
| Restart | A run accepted just before a restart is found by `runs.get`; a running run continues or is `interrupted` per `durableRuns`; queued runs survive or are `interrupted` per `durableQueue`; after a restart, `runs.follow` of an `interrupted` run ends with its `run_ended` without another invoke; no run is rerun (a tool's effect count does not grow) |
| Reading | `read` pages by `after`, `before` and `limit`, returns the newest page without a cursor, and `limit: 0` returns the state; a run's entries carry its `runId` between its `run_started` and `run_ended`; `follow` and a reconnect from the last entry deliver each entry exactly once; an unknown session or cursor is `not_found`, a single `rejected` for a follow; state moves idle → running → idle |
| Sessions | `create` of an existing id is `conflict`; a fork holds the history up to its entry and none of the runs, and leaves the source unchanged; `rewind` keeps the earlier branch and is `busy` while running; `compact` on an empty history is `nothing_to_compact`; `update`, `delete` and `list` |
| Portable | Two instances over one storage: the second sees the first's history of an idle session |

## 9. HTTP binding

The operations are grouped by audience into planes, served separately so a gateway can treat them differently:

| Plane | For | Operations |
|---|---|---|
| User | People using the agent, and clients acting for them | `invoke`; runs; `sessions.create`, `list`; `read`, `follow`, `attachment`, `abort`, `rewind`, `compact`; `info`, `models`, `commands` |
| Control | Operators | `update`, `delete` |

| Operation | HTTP |
|---|---|
| `invoke` | `POST /invoke`: `text/event-stream` of `InvokeEvent`s; with `Accept: application/json`, `202` and the `accepted` event; a rejection is the error's status with `{ "error": AgentError }` |
| `sessions.create`, `sessions.list` | `POST /sessions`, `GET /sessions` |
| `read`, `follow` | `GET /sessions/{s}?after=&before=&limit=`; `GET /sessions/{s}/follow?after=` (SSE; each entry event's `id` is the entry id, so `Last-Event-ID` resumes; a `rejected` follow is the error's status instead) |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` |
| `abort`, `rewind`, `compact` | `POST /sessions/{s}/abort`, `POST /sessions/{s}/rewind`, `POST /sessions/{s}/compact` |
| `runs.get`, `runs.follow`, `runs.cancel` | `GET /sessions/{s}/runs/{r}`, `GET /sessions/{s}/runs?idempotencyKey=`; `GET /sessions/{s}/runs/{r}/events?after=` (SSE); `POST /sessions/{s}/runs/{r}/cancel` |
| `info`, `models`, `commands` | `GET /agent`, `GET /agent/models`, `GET /agent/commands` |
| `update`, `delete` | `PATCH /control/sessions/{s}`, `DELETE /control/sessions/{s}` |

A failed `Result` is answered with its code's status (§7.1) and `{ "error": AgentError }`. `runs.get` answering
`undefined` is `200` with the body `null`, because a `404` is also what any router answers for a path it does not
know, and this answer decides whether a Caller sends again; `attachment` answering `undefined` is `404` with no body.
Authentication is not part of the protocol: it belongs to a gateway in front, or to middleware per plane.

A connection that fails before the receipt arrives leaves it unknown whether the run was accepted, since the server
answers only once the run is recorded, and may still be reading the request. With an `idempotencyKey`, sending it again
with the key settles it: the server answers with the run the key names, or starts one. Asking `runs.get` does not,
since the first request may be accepted after the answer. Without a key, a client MUST NOT report the invoke
`rejected`: that says nothing was recorded, and a Caller would send it again.

## 10. Consumption: streaming and buffered

A Caller either reads the events as they arrive (a chat UI, an SSE endpoint), or wants only the answer. The buffered
form is a Caller-side reducer and adds nothing to the protocol:

```ts
async function collect(events: AsyncIterable<InvokeEvent>): Promise<{ sessionId: string; runId: string; text: string }> {
  let receipt: { sessionId: string; runId: string } | undefined;
  let text = "";
  for await (const e of events) {
    if (e.type === "rejected") throw new AgentRejected(e.error);
    if (e.type === "accepted") receipt = { sessionId: e.sessionId, runId: e.run.runId };
    if (e.type !== "entry" || e.entry.runId !== receipt?.runId) continue;
    if (e.entry.kind === "assistant_message") text = (e.entry.data as { text: string }).text;
    if (e.entry.kind === "run_ended") {
      const { outcome } = e.entry.data as { outcome: RunOutcome };
      if (outcome.status !== "completed") throw new RunNotCompleted(outcome);
      return { ...receipt, text };
    }
  }
  throw new Error("stream ended without run_ended"); // the process stopped, or MUST 1 was violated
}
```

## 11. Extension points

| Extension | Attachment point |
|---|---|
| Identity and permissions | A principal on the request, asserted only by a trusted gateway or an in-process channel; designed with permissions |
| Execution constraints such as deadline or budget | Middleware; exceeding one ends the run `failed` |
| New kinds of output | New event types and entry kinds; never a new stream ending (MUST 6) |
| Structured result | Not in v1; a design must keep the endings frozen |
| Failure subdivision | Codes under an implementation prefix (§7.1) |

Session storage, the tool execution environment, model selection and loading the agent's definition are injected
inside the Agent and are not specified here. So are the harness and the port the implementation runs it through: a
harness conforms by passing the suite (§8) through that implementation.

## 12. Out of scope

- **Transports other than §9**: ACP, A2A and the like sit outside and call the protocol.
- **Harness internals**: the loop, tool execution, model calls and context management.
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
| `completed`, `failed` endings | The `run_ended` entry, with an outcome; `rejected` for a refusal |
| `completed.data` | Gone: no harness produced it; a structured result waits for a design |
| MUST 3: the Agent stops when the Caller stops reading | The Caller detaches; `runs.cancel`, `abort` and `delete` stop work |
| MUST 6: no location dependence | Location dependence only while a run is active (MUST 8) |
| A busy session rejected with `session_busy` | `whenBusy`; `busy` with a reason |
| The session control extension (`steer`, `followUp`, `abort`, …) | `whenBusy`, `runs.cancel`, and the session operations of §5 |
| `collect` returns `{ text, data }` | `collect` returns the run's answer, and throws on any other outcome or a rejection |
