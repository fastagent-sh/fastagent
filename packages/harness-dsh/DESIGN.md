# @fastagent-sh/harness-dsh — Architecture & Design

This document specifies how FastAgent integrates [DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness) as a second, optional runtime harness alongside `pi-durable`. Every assumption below is backed by an empirical spike against `@deepseek-ai/dsh@0.2.2-rc.5`.

## 1. Core Architectural Principle: Boundary at the Agent API

FastAgent previously tried and dropped an internal `LoopPort` abstraction because internal loop, extension, and storage models differ fundamentally across harnesses. To avoid repeating that mistake:

- **Single contract boundary**: `@fastagent-sh/client` `Agent` (`info`, `usage`, `sessions`, `messages`) + `test/harnesses/agent-api-conformance.ts`.
- **Portable authoring layer**: `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `mcpServers`, `needs()`, and tools written with `defineTool` from `@fastagent-sh/fastagent` (Standard JSON Schema / Zod v4 / plain JSON Schema) run unmodified on both `pi-durable` and `dsh`.
- **Harness-native extensions stay native**: `pi-durable` extensions remain `pi-durable`-specific; Cordis plugins remain `dsh`-specific. No lowest-common-denominator extension wrapper is introduced.
- **Zero core bloat**: `@fastagent-sh/fastagent` never imports `@deepseek-ai/*`; `@fastagent-sh/harness-dsh` never imports `@earendil-works/pi-durable`. Both may share `@earendil-works/pi-ai` (DSH ships `@deepseek-ai/dsh-llm-pi-ai`, which depends directly on `@earendil-works/pi-ai`).

## 2. Empirical Spike Summary (`@deepseek-ai/dsh@0.2.2-rc.5`)

Measured against a minimal 9-plugin Cordis composition (`SessionStore`, `SessionProjectionRegistry`, `LlmRuntime`, `ToolsService`, `NativeToolExecutor`, `SystemPrompt`, `AgentRegistry`, `AgentLoop`, custom `SessionPersistence`):

| Dimension | Measured behavior |
|---|---|
| Cold boot (9 core plugins) | 2.2–5.3 ms per isolated Cordis `Context` |
| Multi-instance isolation | Multiple `Context` instances boot concurrently in one process and tear down cleanly via `await ctx.fiber.dispose()` |
| Streaming deltas | `agent/assistant-stream` emits `reasoning-delta`, `text-delta`, `tool-call-delta` |
| `whenBusy: "steer"` vs `"queue"` | `agent.steer()` (`next-step`) preempts `agent.followup()` (`next-turn`) at the next step boundary; `followup` runs in its own subsequent turn |
| Forking | `buildForkSeed(events, SessionSeq)` + `ctx.agents.create({ seed, inheritedEventCount, meta: { isSeeded: true } })` |
| Persistence seam | Abstract `@deepseek-ai/dsh-session-persistence` (`SessionPersistence` + `SessionHandle`); avoids native `koffi`/`zstd` JSONL backend completely |
| Crash mid-tool (SIGKILL) | `ctx.agents.resume()` appends `interruptedTurnClosers()` (`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` + `step/end` + `turn/end (interrupted)`) and leaves status `idle` |
| Crash with queued inbox (SIGKILL) | `agent/inbox/spliced` survives in log; `resumed.agent.inbox.nextTurn` restores queued messages, leaving status `idle` until woken |
| OS Sandbox (`LocalSandboxProvider`) | macOS `sandbox-exec` (`enforcement: "full"`); Linux `bwrap` → `Landlock`; Windows ACL restricted-token; fails closed when unavailable |

## 3. Contract Mapping: FastAgent Agent API ↔ DSH

| FastAgent Agent API | DSH Primitive / Adapter Responsibility |
|---|---|
| `info()` | Program presentation + `ctx.llm.listProviders()` + `ctx.tools.schemas()` + `readCommands(dir)` |
| `usage()` | Aggregated `usage` chunks / `@deepseek-ai/dsh-token-meter` across instance sessions |
| `sessions.create({ model, thinkingLevel, instructions, tools, forkFrom })` | `ctx.agents.create({ sessionId, agentOptions, seed?, inheritedEventCount?, setup })`; scoped `ctx.tools.restrict({ allow })` and scoped `ctx.systemPrompt.section(...)` |
| `sessions.get / list / update / delete` | Session metadata index stored beside `SessionPersistence`; `update` calls `agent.model.select(...)` and updates scoped settings; `delete` marks deleted, cancels active driver, and disposes handle |
| `sessions.entries({ after, before, limit })` | Cursor pagination over committed `SessionEvent` log projected to FastAgent `Entry` (`user`, `assistant`, `tool_result`, `compaction`) |
| `sessions.events({ after })` | Replay committed entries after `after` → emit `state` snapshot (including live reply/tools/queued messages) → subscribe to `session/event`, `agent/assistant-stream`, `agent/status`, and tool progress events |
| `sessions.cancel()` | `agent.cancel({ kind: "user" })` (clears pending inbox and aborts active turn); record `canceled` status for stopped messages |
| `sessions.compact()` | Trigger `@deepseek-ai/dsh-compaction-basic` inside `agent.runMaintenance(...)` |
| `messages.send({ whenBusy, idempotencyKey, metadata })` | Adapter-owned admission ledger (single-writer per instance): check `idempotencyKey`, enforce `whenBusy: "reject"` when `agent.status === "running"`, record durable message row before calling `agent.followup()` or `agent.steer()` |
| `messages.stream()` | Subscribe to `sessions.events` before admission, then emit `message` + own entries/deltas through `done` (identical to `pi-durable/stream.ts`) |
| `messages.get({ messageId | idempotencyKey }, { wait })` | Read from adapter message ledger; wait on terminal transition signal |

## 4. Storage Design: SQLite & PostgreSQL `SessionPersistence`

Rather than porting `pi-durable`'s multi-table document/task/revision engine (~2,000 LOC), a DSH SQLite/PostgreSQL backend needs only 4 small tables keyed by `instance`:

```sql
CREATE TABLE IF NOT EXISTS dsh_leases (
  instance    text PRIMARY KEY,
  owner       text,
  lease_until timestamptz
);

CREATE TABLE IF NOT EXISTS dsh_sessions (
  instance              text NOT NULL,
  session_id            text NOT NULL,
  header_json           text NOT NULL,
  inherited_event_count integer NOT NULL DEFAULT 0,
  title                 text,
  deleted               boolean NOT NULL DEFAULT false,
  created_at            bigint NOT NULL,
  updated_at            bigint NOT NULL,
  PRIMARY KEY (instance, session_id)
);

CREATE TABLE IF NOT EXISTS dsh_events (
  instance    text NOT NULL,
  session_id  text NOT NULL,
  seq         integer NOT NULL,
  event_json  text NOT NULL,
  PRIMARY KEY (instance, session_id, seq)
);

CREATE TABLE IF NOT EXISTS dsh_messages (
  instance        text NOT NULL,
  session_id      text NOT NULL,
  message_id      text NOT NULL,
  idempotency_key text,
  status          text NOT NULL,
  when_busy       text NOT NULL,
  metadata_json   text,
  answer_seq      integer,
  error_json      text,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL,
  PRIMARY KEY (instance, session_id, message_id),
  UNIQUE (instance, session_id, idempotency_key)
);
```

- **Single-writer fencing**: reuses FastAgent's `dsh_leases` / fencing-token pattern (same as `pi-durable/postgres/storage.ts`) and supports `openPostgresDatabase` shared pools.
- **Durability barrier**: `SessionHandle.append(events)` buffers or writes contiguously from `nextSeq`; `SessionHandle.flush()` commits all buffered events atomically in one transaction.

## 5. Crash Recovery & Restart Semantics

DSH intentionally does **not** auto-drive an agent on `resume()`, whereas FastAgent's conformance suite requires:
1. A message accepted before a crash is answered after restart;
2. An interrupted side-effecting tool is **not** re-executed;
3. Queued messages survive restart and execute in order.

Adapter recovery algorithm on `openDshAgent()`:
1. On graceful `close()`: cancel active drivers with `{ keepInbox: true }` so queued messages remain in the durable log, then flush `SessionPersistence` and dispose the Cordis `Context`.
2. On startup (`unfinished: "resume"`): query `dsh_messages` for unsettled (`queued` / `running`) rows grouped by `session_id`.
   - Call `ctx.agents.resume({ resumeSessionId })`. DSH automatically appends `interruptedTurnClosers` (injecting `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` and closing the interrupted turn without re-running the interrupted tool).
   - If the session had an active `running` message whose turn was closed as `interrupted`, wake the driver with a continuation step so the model observes the synthetic tool-interruption result and produces the final answer for that message.
   - If `resumed.agent.inbox.nextTurn.length > 0` (messages queued before SIGKILL), trigger a driver wake so queued turns drain in order.

## 6. Tool Bridge & Native OS Sandbox

- **Tool bridge (`src/tools.ts`)**: adapts any FastAgent `defineTool` output (`{ name, description, parameters (JSON Schema), execute }`) into DSH's `ToolDefinition` (`{ name, description, parameters, output: { schema, render }, execute }`). Standard Schema validation/transforms already run inside FastAgent's `defineTool` wrapper.
- **OS sandbox (`src/sandbox.ts`)**: translates `sandbox: "off" | "workspace" | "read-only"` + `workdir` into DSH's `SandboxPolicy` (`workspace`, `writablePaths`, `readablePaths`, `network: "none"`). When `sandbox !== "off"`, `LocalSandboxProvider` fails closed (`SANDBOX_UNAVAILABLE`) rather than running unconfined commands.

## 7. Implementation Milestones

1. **Phase 0 (Done — PR #1115)**: package setup (`private: true`), `DshEventStoreBackend` + `MemoryDshEventStore`, `toDshToolDefinition` bridge, `buildDshSandboxPolicy`, `openDshAgent` boundary, package-boundary guard, unit tests.
2. **Phase 1 (Done — Live DSH Runtime & Full Conformance)**: wired Cordis `Context` + `AgentLoop` + `PiAiModelsAdapter` over `@earendil-works/pi-ai` `Models` + message ledger + event streaming + fork/compaction + in-memory restart recovery; passes all 61 tests in `test/harnesses/agent-api-conformance.ts`.
3. **Phase 2 (Done — Durable Persistence & Crash Recovery)**: implemented `openSqliteDshStore` (`node:sqlite` WAL) and `openPostgresDshStore` (structural `DshPgDatabase` compatible with `openPgDatabase` / `SharedPostgresDatabase`, with `dsh_leases` single-writer fencing and multi-instance isolation), wired `dshSubject` to real SQLite for all 61 conformance tests, and verified cross-process `SIGKILL` crash recovery in L2 integration tests.
4. **Phase 3 (Done — PR #1119)**: wired `@deepseek-ai/dsh-sandbox-local` (`LocalSandboxProvider`), built-in sandboxed coding tools (`read`, `write`, `edit`, `bash`) gated by `codingTools`, `resolveConfinedPath` symlink/traversal defense, `openDshAgentFromDir()` directory loader, and real OS-kernel sandbox integration tests.
5. **Phase 4 & 5 (Done — PR #1120 & publish prep)**: unified `harness` / `sandbox` selection across `fastagent.config.ts`, CLI (`dev`, `start`, `invoke`, `schedules`, `info`), and `openAgent()`, sharing `agent.sqlite` / PostgreSQL via `dsh_*` tables, warning-and-skipping `src/extensions/*`, and publishing `@fastagent-sh/harness-dsh` as an optional experimental package.
