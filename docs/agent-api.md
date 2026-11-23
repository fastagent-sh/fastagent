---
title: Agent API
description: "How to call a FastAgent service from any app, backend, cron job, or CLI: choose between single-call invoke, sessions, streaming, remote provider auth, error handling, and HTTP routes."
status: current
---

# Agent API

Whether your agent runs embedded in your Node app (`openAgent`), behind HTTP (`connectAgent`), or on Amazon Bedrock AgentCore (`connectAgentCore`), you integrate with one contract: the Agent API.

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://support.example.com", {
  apiKey: process.env.SUPPORT_AGENT_KEY!,
});
// In-process instead:
// const agent = await openAgent(support, { root: "/var/lib/myapp/support" });

const reply = await agent.invoke(
  { conversation: "order:9231", content: "Where is my shipment?" },
  { wait: 120 },
);
console.log(reply.status, reply.answer?.text);
```

Full TypeScript types ship in `@fastagent-sh/client` and `@fastagent-sh/fastagent`, and every served instance exposes an OpenAPI 3.1 document at `GET /v1/openapi.json`. This guide explains how to choose the right call pattern and what guarantees you can rely on.

## Choose your call pattern

| Use case | Recommended call | Why |
| --- | --- | --- |
| **Webhooks, cron jobs, scale-to-zero hosts, or stateless backends** | `agent.invoke` / `invokeStream` (`POST /v1/invoke`) | One request creates or reuses a caller-named `conversation`, waits up to 600 s (or streams), and deduplicates retries via `Idempotency-Key`. |
| **Chat UIs with live token & tool progress** | `sessions.create` + `messages.stream` (or `sessions.events`) | Streams text/thinking deltas, tool start/progress, retries, and durable entries; reconnects cleanly after drops using `after`. |
| **Async / background job orchestration** | `messages.send` (without `wait`) + `messages.get(..., { wait })` | Returns immediately once persisted; poll or long-poll by `messageId` or `idempotencyKey` until `hasEnded(message)`. |
| **Signing a deployed instance into a model provider** | `connectAuth` (`/v1/auth/*`) or `fastagent login --remote` | Drives interactive OAuth or API-key login and persists credentials in the instance's durable storage. |

## Reliability guarantees

- **Accepted once, settled once.** Messages are persisted before acknowledgment and reach exactly one terminal state even across crashes or restarts.
- **Safe retries.** Resending with the same `idempotencyKey` returns the existing message without re-running it.
- **Recoverable after disconnects.** If your network drops mid-response, fetch the outcome with `messages.get` or resume the event stream from the last durable `entry.id`.
- **Same contract on every harness.** Both `pi-durable` and `@fastagent-sh/harness-dsh` uphold the exact same semantics.

## Core objects

| Object | What it represents |
| --- | --- |
| **Agent** | One running instance (one trust domain). `info()` lists available models, tools, commands, and starters; `usage()` reports cumulative spend. |
| **Session** | A durable conversation with history entries, `status` (`idle` / `running`), `title`, timestamps, settings (`model`, `thinkingLevel`, `instructions`, `tools`), active `contextUsage`, cumulative `usage`, and live activity (`reply`, `activeTools`, `queuedMessages`, `compacting`). |
| **Message** | One submission into a session, tracking its `status`, `entryId`, `answer`, `error`, `idempotencyKey`, and caller `metadata`. |
| **Entry** | One immutable history record: `user`, `assistant`, `tool_result`, or `compaction`. Forked sessions share entries (with original ids) up to the fork point. |

```text
session s1
├─ message m1 "Where is order 9231?"   completed, answer = e4
│    e1 user · e2 assistant (tool call) · e3 tool_result · e4 assistant (answer)
├─ message m2 "And the refund?"        running
└─ message m3 "Thanks"                 queued, behind m2
```

> Watch a **session** to observe everything happening in a conversation; inspect a **message** to learn what happened to one specific request.

## Single-call invoke (`POST /v1/invoke`)

`invoke()` and `invokeStream()` handle session lookup/creation and message execution in a single round trip—ideal for webhooks, external schedulers, and scale-to-zero containers:

- **Caller-named `conversation`:** Pass `conversation: "daily-digest"` or `"slack:C123:456"`. FastAgent reuses the mapped session, or creates one titled with that name if absent or previously deleted.
- **Strict `sessionId`:** Target an existing session id directly (refuses `not_found` if missing). Mutually exclusive with `conversation`.
- **Ephemeral:** Omit both to create a fresh session automatically. With `idempotencyKey`, retries return the same ephemeral session and message instead of creating duplicates.
- **Session settings:** Optional `session` (`SessionSettings`) configures a new session or updates an existing one when explicitly passed.
- **Extended wait:** HTTP `POST /v1/invoke` supports `wait` up to `600` seconds (`LIMITS.invokeWaitSeconds`) or `"stream": true`.

```ts
const msg = await agent.invoke(
  {
    conversation: "daily-digest",
    content: "/daily-digest",
    whenBusy: "reject",
  },
  { wait: 300 },
);
```

## Working with sessions & messages

| Operation | Purpose |
| --- | --- |
| `info()`, `usage()` | Inspect capabilities (models, tools, commands, starters) and cumulative model/tool usage |
| `sessions.create({ title?, model?, thinkingLevel?, instructions?, tools?, forkFrom? })` | Create a session, or fork an existing session up to `forkFrom.entryId` |
| `sessions.get`, `sessions.list` | Fetch one session, or list sessions ordered by most recent activity (`limit`, `after`) |
| `sessions.update` | Update title or settings for future turns; pass `null` to clear a setting back to default |
| `sessions.delete` | Abort active work and delete the session permanently |
| `sessions.entries` | Paginate history (newest page first, then `prev` / `next`) |
| `sessions.events` | Stream replay + live snapshot + real-time events ([Streaming & reconnection](#streaming-reconnection)) |
| `sessions.cancel` | Stop active and queued work; resolves with `{ stopped: string[] }` once recorded |
| `sessions.compact` | Compact older context (`instructions?`); emits a `compaction` entry |
| `sessions.attachment` | Download binary bytes and `mimeType` for an image `ref` in an entry |
| `messages.send` | Admit a message; returns immediately or waits up to `wait` seconds |
| `messages.stream` | Admit a message and stream its events through `done` |
| `messages.get` | Look up a message by `{ sessionId, messageId }` or `{ sessionId, idempotencyKey }`, with optional `wait` |

Passing an `AbortSignal` (`signal`) stops your client wait or stream without canceling the agent's work—only `sessions.cancel` stops execution. `wait` is an upper bound in seconds, so always check `message.status` (or `hasEnded(message)`) when it returns.

### Sending options & message lifecycle

- **Content:** Pass a string or a non-empty array of `text` and base64 `image` parts. A message starting with `/<name>` matching `info().commands` expands that prompt template or `/skill:<name>` while recording the original text in the `user` entry.
- **Idempotency:** Pass `idempotencyKey` (1–256 chars, unique per session). `connectAgent` generates one automatically when omitted. If a call rejects with `unconfirmed`, retry with the same key.
- **Caller metadata:** Attach up to 16 string key-value pairs (keys 1–64 chars, values ≤ 512 chars) for your own routing/correlation. Returned on `send`, `get`, and `done`, and never shown to the model.
- **Busy sessions (`whenBusy`):**
  - `"queue"` (default): wait in line behind current work.
  - `"steer"`: inject into the running turn at its next step.
  - `"reject"`: refuse with `AgentError("busy")` (`details.reason: "running"`).

| Status | Terminal? | `answer` | Meaning |
| --- | --- | --- | --- |
| `queued` | No | — | Accepted and waiting its turn |
| `running` | No | — | Executing now |
| `completed` | Yes | Final `assistant` entry | Answered normally |
| `incomplete` | Yes | Partial `assistant` entry | Hit model output token limit |
| `failed` | Yes | — | Failed; `message.error` explains why (`missing_model`, `auth_required`, `model_error`, `internal`) |
| `canceled` | Yes | — | Stopped by `sessions.cancel` or withdrawn from queue |

## Streaming & reconnection

`sessions.events(sessionId, { after, signal })` guarantees gapless ordering:

1. **Replay:** Durable `entry` events after `after` (or all entries with `after: "start"`, none when omitted).
2. **Snapshot:** One `state` event with the current `Session` (including in-flight `reply`, `activeTools`, `queuedMessages`, and `compacting`).
3. **Live:** Real-time events starting right after the snapshot. A message's `done` always arrives before the next message's `user` entry.

| Event | Carries |
| --- | --- |
| `entry` | Durable `Entry` (`tool_result` includes optional `details` from the tool) |
| `state` | Current `Session` snapshot (initial snapshot + title/setting updates) |
| `delta` | Live text chunk (`channel: "text"` for answer, `"thinking"` for reasoning) |
| `tool_started` | Tool invocation (`toolCallId`, `name`, `args`) |
| `tool_progress` | Tool status line (`text`) and optional multi-line `output` tail |
| `retrying` | Backoff notice (`attempt`, `maxAttempts`, `delayMs`, `reason`) |
| `compaction_started`, `compaction_failed` | Compaction trigger (`manual` / `threshold` / `overflow`) or failure `error` |
| `done` | Terminal `Message` |
| `stream_error` | Stream interrupted (`error`); the underlying message keeps running |

To reconnect after a drop, reopen `sessions.events` with `after` set to the last `entry.id` you received (HTTP also supports `Last-Event-ID`). Because deltas are live-only, render `state.session.reply` when attaching mid-turn and append subsequent `delta` chunks.

`messages.stream` emits an initial `message` receipt followed by that message's events through `done`.

## Remote provider auth (`/v1/auth/*`)

Served instances expose an Auth API (`connectAuth` from `@fastagent-sh/client`, `connectAgentCoreAuth` from `@fastagent-sh/client-agentcore`, or `fastagent login --remote`) so operators can sign a deployed instance into OAuth or API-key model providers without baking credentials into images. Stored credentials persist in the instance's durable storage across restarts.

| Method | HTTP route | Purpose |
| --- | --- | --- |
| `auth.providers()` | `GET /v1/auth/providers` | List providers, supported methods (`oauth`, `api_key`), and auth status |
| `auth.startLogin({ provider, method? })` | `POST /v1/auth/login` | Start a login flow; returns `AuthFlowState` (`authUrl`, `deviceCode`, `prompt`, `status`) |
| `auth.getLogin(flowId, { wait? })` | `GET /v1/auth/login/{flowId}?wait` | Read or long-poll flow progress (`pending`, `awaiting_input`, `completed`, `failed`, `canceled`) |
| `auth.submitInput(flowId, { promptId, value })` | `POST /v1/auth/login/{flowId}/input` | Submit interactive input (callback URL, code, API key, selection) |
| `auth.cancelLogin(flowId)` | `DELETE /v1/auth/login/{flowId}` | Cancel an active login flow (`204`) |
| `auth.logout(provider)` | `DELETE /v1/auth/providers/{provider}` | Remove the stored credential (`{ removed: boolean }`) |

## Error handling

Refused operations reject with `AgentError` (`{ code, message, retryable, details? }`); failed messages carry the same `AgentErrorData` shape in `message.error`.

| Code | When it happens | Retryable | HTTP |
| --- | --- | --- | --- |
| `invalid_request` | Malformed input or size limit exceeded (`details.reason: "too_large"`) | No | 400, 413 |
| `unauthorized` | Missing or invalid bearer key / AWS IAM credentials | No | 401 |
| `not_found` | Unknown session, message, auth flow, fork source, or cursor | No | 404 |
| `busy` | `details.reason`: `"running"`, `"queue_full"`, or `"capacity"` | Yes | 409, 429, 503 (`Retry-After`) |
| `missing_model` | No valid model selected and no usable default (`info().unusableDefault` explains why) | No | 409 |
| `missing_tool` | Session enables a tool the instance does not have | No | 409 |
| `auth_required` | Model provider lacks a valid credential (in `message.error`) | No | — |
| `model_error` | Upstream model provider error (in `message.error`) | No | — |
| `unconfirmed` | Write outcome uncertain; resend with the same `idempotencyKey` | No | 500 |
| `unavailable` | Transient service/storage outage; safe to retry unchanged | Yes | 503 (`Retry-After`) |
| `internal` | Unexpected internal error | No | 500 |

**Forward compatibility:** Ignore unknown event types or entry kinds, treat unknown session statuses as busy, use `hasEnded(message)` to detect terminal states, and branch on `error.retryable` for unrecognized error codes.

## HTTP binding

All API routes live under `/v1` and require `Authorization: Bearer <key>` (configured via `FASTAGENT_API_KEY` or `serve({ apiKeys })`). Without a key, only `GET /health` is served. CORS is intentionally disabled—call the API from your backend, never directly from a browser.

| Method & path | Operation |
| --- | --- |
| `GET /health` | Public readiness probe (`200 { "status": "ok" }` while ready, `503 { "status": "unavailable" }` once shutting down; no auth) |
| `GET /v1/agent`, `GET /v1/usage`, `GET /v1/openapi.json` | `info`, `usage`, OpenAPI 3.1 schema |
| `POST /v1/sessions`, `GET /v1/sessions?limit&after` | `sessions.create` (`201`), `sessions.list` |
| `GET`, `PATCH`, `DELETE /v1/sessions/{sessionId}` | `sessions.get`, `sessions.update`, `sessions.delete` (`204`) |
| `GET /v1/sessions/{sessionId}/entries?after&before&limit` | `sessions.entries` |
| `GET /v1/sessions/{sessionId}/events?after` | `sessions.events` (SSE; supports `Last-Event-ID`) |
| `POST /v1/sessions/{sessionId}/cancel`, `/compact` | `sessions.cancel`, `sessions.compact` (`202`) |
| `GET /v1/sessions/{sessionId}/attachments/{ref}` | `sessions.attachment` |
| `POST /v1/sessions/{sessionId}/messages` | `messages.send`; `messages.stream` with `"stream": true` |
| `GET /v1/sessions/{sessionId}/messages/{messageId}?wait` | `messages.get` by id |
| `GET /v1/sessions/{sessionId}/messages/by-key/{idempotencyKey}?wait` | `messages.get` by key |
| `POST /v1/invoke` | `invoke` (`wait` up to 600 s); `invokeStream` with `"stream": true` |
| `GET /v1/auth/providers`, `DELETE /v1/auth/providers/{provider}` | `auth.providers`, `auth.logout` |
| `POST /v1/auth/login`, `GET /v1/auth/login/{flowId}?wait` | `auth.startLogin`, `auth.getLogin` |
| `POST /v1/auth/login/{flowId}/input`, `DELETE /v1/auth/login/{flowId}` | `auth.submitInput`, `auth.cancelLogin` (`204`) |

Send `idempotencyKey` in the percent-encoded `Idempotency-Key` header. SSE streams emit `event: <type>`, JSON `data`, `id: <entry.id>` on durable `entry` events, and keepalive comments at least every 15 seconds. Refusals return `{ "error": AgentErrorData }`.

`connectAgent(url, { apiKey, fetch })` and `connectAuth(url, { apiKey, fetch })` accept a custom `fetch` transport for signed cloud protocols (such as [`@fastagent-sh/client-agentcore`](agentcore.md)).

```bash
# Single-call invoke with caller-named conversation (cron, webhooks, scale-to-zero)
curl -s https://support.example.com/v1/invoke \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: daily-2026-04-15" \
  -d '{"conversation": "daily-digest", "content": "/daily-digest", "whenBusy": "reject", "wait": 300}'

# Send to an explicit session
SEND=$(uuidgen)
curl -s https://support.example.com/v1/sessions/$SESSION/messages \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $SEND" \
  -d '{"content": "Where is order 9231?", "wait": 60}'
```

## Security

- **One instance is one trust domain.** An API key grants full access to all sessions and auth endpoints on that instance.
- **Isolating end users.** Give users who must not access each other's data separate instances when coding tools are enabled, or disable coding tools (`codingTools: false`), ensure custom tools cannot access shared storage, and authorize every session id in your backend.
- **Keep keys server-side over HTTPS.** Rotate keys cleanly with comma-separated values (`FASTAGENT_API_KEY=new,old`).
- **A session id is not a credential.** Always verify user ownership of session ids in your application layer.

## Out of scope by design

Per-message token billing (batched/concurrent turns share model calls); structured JSON answer schemas (define a typed tool and read its `tool_result` entry); interactive mid-turn user prompts; outbound completion webhooks (use `POST /v1/invoke`, `messages.get` with `wait`, or `sessions.events`); binary attachments other than images; A2A/MCP server bindings.
