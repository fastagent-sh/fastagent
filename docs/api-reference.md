---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent contract, assembly functions, channel and host kit, typed tools, sessions, and providers."
status: current
---

# API reference

This is a compact reference for the all-in-one `@fastagent-sh/fastagent` surface. The same exports are grouped into `@fastagent-sh/fastagent/core` (engine-neutral) and `@fastagent-sh/fastagent/pi` (the pi reference implementation).

FastAgent is pre-1.0. The Agent Handler contract is the stable design center; implementation-specific APIs may still tighten before 1.0.

## Contract

```ts
interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}

interface Scope {
  session: string;
}

interface Prompt {
  text: string;
  images?: ImageRef[];
}

interface ImageRef {
  mimeType: string;
  data: string; // base64
}
```

`AgentEvent`:

```ts
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  | { type: "completed"; data?: Json }
  | { type: "failed"; details: string; retryable: boolean; code?: string };
```

See [Agent Handler SPEC](SPEC.md) for normative behavior.

## `collect`

```ts
function collect(events: AsyncIterable<AgentEvent>): Promise<CollectResult>;

interface CollectResult {
  text: string;
  data?: Json;
}

class AgentFailure extends Error {
  details: string;
  retryable: boolean;
  code?: string;
}
```

Buffers text deltas until `completed`. Throws `AgentFailure` on `failed`. Throws a regular error if the stream ends without a terminal event.

## HTTP/host helpers

```ts
function createInvokeHandler(agent: Agent): (req: Request) => Promise<Response>;
```

Fetch-shaped HTTP/SSE handler. Accepts `POST` JSON:

```json
{ "session": "s1", "text": "hello" }
```

Returns Server-Sent Events with one JSON `AgentEvent` per `data:` line. The stream also carries
SSE comment heartbeats (`: ping`, every 30s) so remote consumers can distinguish a quiet run from
a dead connection — parse per the SSE spec (only `data:` lines carry events), not line-by-line
JSON.

```ts
function nodeListener(handler: (req: Request) => Promise<Response>): (req, res) => void;
function router(routes: Routes): ChannelHandler;
function serveNode(handler: ChannelHandler, options: { port: number }): {
  listening: Promise<number>;
  close(): Promise<void>;
};
```

Route types:

```ts
type ChannelHandler = (req: Request) => Response | Promise<Response>;
type Routes = Record<string, ChannelHandler>;
```

Route keys are `"/path"` or `"METHOD /path"`.

## pi assembly

### `createPiAgent`

```ts
function createPiAgent(options: CreatePiAgentOptions): Agent;
```

Assemble an agent from typed parts:

```ts
createPiAgent({
  model: "openai-codex/gpt-5.5",
  instructions: "You are a support assistant.",
  tools: [lookupOrder],
});
```

Common options:

| Option | Meaning |
|---|---|
| `model` | Required `provider/modelId` spec string. |
| `instructions` | String or function returning the system prompt. |
| `tools` | Agent tools. |
| `skills` | Loaded Agent Skills. |
| `sessions` | `PiSessionStore`. |
| `env` | Harness `ExecutionEnv`. This alone does not sandbox the pi coding tools or project-context loader. |
| `lease` | Same-session concurrency lease. |
| `providers` | Extra model providers. |

### `createPiAgentFromDefinition`

```ts
function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }>;
```

Load `persona.md`/`skills/` from `dir` (the agent-definition dir) and assemble the pi prompt. `②` project context is sourced via pi's `loadProjectContextFiles({ cwd, agentDir: dir })` — the dir's own `AGENTS.md` plus every `AGENTS.md` walking `cwd` (option; default `dir`) up to root. Pass `cwd` to decouple the run/working directory (where tools operate, whose repo `AGENTS.md` is context) from the definition dir.

`LoadedDefinition` carries `contextFiles: Array<{ path; content }>` (the ② files), `persona?` (from `persona.md`, ①), `skills`, and diagnostics/collisions (`SkillDiagnostic[]` / `SkillCollision[]` — both exported).

### `createPiAgentFromWorkspace`

```ts
function createPiAgentFromWorkspace(
  dir: string,
  options?: { model?: string; sessionsDir?: string; authPath?: string; serving?: boolean },
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  modelSpec: string;
  agentDir: string;
  stateRoot: string;
  sessionsDir: string;
  authPath: string;
  toolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}>;
```

The same opener used by `fastagent dev`, `invoke`, and `start`: load config, resolve model/tools, pick session storage, and assemble the directory. Set `serving: true` only for a long-running host that also runs the scheduler; it allows an opted-in workspace to mount its `wake` tool.

## Tool authoring

```ts
function defineTool<I extends z.ZodType>(options: DefineToolOptions<I>): AgentTool;
```

Use the re-exported `z`:

```ts
import { defineTool, z } from "@fastagent-sh/fastagent";

export default defineTool({
  description: "Look up an order.",
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return await db.find(orderId);
  },
});
```

`tools/<name>.ts` files are discovered with `loadTools(dir)`, and the filename becomes the tool name.

The second `execute` argument is a `ToolContext`: `{ signal?, session?, tools? }`. `session` is the id of
the current turn's conversation (undefined outside a turn, e.g. a bare `fastagent tool` run) — a per-turn
value carried via `AsyncLocalStorage`, not a closure (a tool is built once and reused across sessions).
The built-in **`wake`** tool uses it to self-schedule: `wake({ in, prompt })` records a one-shot wake-up
that the scheduler fires back into THIS session after the delay (see [Schedule authoring](#schedule-authoring)).

### Deferred tools

For tool-heavy agents, `defineTool({ ..., deferred: true })` registers a tool without activating it:
its schema stays out of every request (and the model's sight) until discovered. When any deferred tool
is mounted, fastagent automatically mounts the built-in **`search_tools`** loader (a workspace tool
named `search_tools` wins — the author owns the concept then): the model searches by keywords, matching
tools are activated mid-turn, and the activation is recorded in the session, so it survives fastagent's
per-invoke harness rebuild for the rest of that conversation.

Costs and behavior to know:

- **Discovery rides on the `description`** — a deferred tool the model never searches for effectively
  does not exist. Write descriptions with the search in mind.
- On models with native deferred tool loading, an activation preserves the provider's prompt-cache
  prefix; everywhere else activation still works but may pay a cache miss. The supported-model matrix
  is pi's (see its Dynamic Tool Loading docs) and evolves with pi releases — fastagent adds no
  restriction of its own.
- `ToolContext.tools` (`{ active(), registered(), activate(names) }`) is the activation bridge a custom
  loader can use; `activate` is additive and ignores unknown names. A custom loader must also declare
  `executionMode: "sequential"` (a `defineTool` option; pi then serializes the batch — in chat, pi's
  own before/after diff around SDK tools would otherwise attribute one activation to two parallel
  calls). A workspace `search_tools` missing the mode gets it forced, with a warning.
  Both types are exported: `ToolActivation`, and `FastagentTool` (`AgentTool` + the `deferred` marker —
  the type `config.tools` and the L1/L2 `tools` options accept, so a raw object literal with
  `deferred: true` type-checks).
- At L1 (`createPiAgent`) the `instructions` are verbatim by contract — fastagent does not inject the
  discovery note the directory path's base prompt carries. When passing deferred tools at L1, tell the
  model about `search_tools` in your own instructions (or rely on the loader's description alone,
  which is weaker).
- An activation is persisted as a dedicated DELTA entry in the session ("this conversation activated
  these deferred tools"): on reopen the active set is rebuilt as the initial set (current non-deferred
  tools) plus the accumulated deltas. A tool you add to the workspace later joins existing
  conversations, and a tool you later flip to `deferred` drops out of sessions that never discovered
  it.
- **`fastagent chat` emulates deferral** like the serving path (what you iterate is what you serve):
  the session starts with deferred tools inactive, the same `search_tools` loader discovers and
  activates them (bridged to pi's session instead of the serving harness), and the prompt is
  identical. One divergence: chat activations do not survive `/new`/`/resume` — pi's chat session
  does not record them, so a resumed conversation re-discovers via `search_tools` (on the serving
  path activations persist in the session for the conversation's life).

## Channel authoring

```ts
interface ChannelContext {
  agent: Agent;
  stateRoot: string; // resolved state root (FASTAGENT_STATE_DIR > <dir>/.fastagent), absolute
}
type ChannelModule = (ctx: ChannelContext) => Routes;
function loadChannels(
  dir: string,
  ctx: ChannelContext,
): Promise<{ routes: Routes; collisions: ChannelCollision[]; failures: ModuleLoadFailure[] }>;
```

A workspace channel default-exports a `ChannelModule` from `channels/<name>.ts`. Bundled adapters
(`telegramChannel(opts)`, `githubChannel(opts)`) take policy options and return a `ChannelModule`, so
the channel file is one expression; a channel persisting durable state derives its home from
`ctx.stateRoot` (`<stateRoot>/channels/<kind>`), never `process.cwd()`. Enabled files end in `.ts`,
`.js`, or `.mjs`; rename one to `<name>.ts.disabled` to disable it. Serving fails if any enabled channel
cannot load.

Channel adapters can also use:

```ts
function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response;
const textHeaders: { readonly "content-type": "text/plain" };
```

See [Channel development](channel-development.md).

## Schedule authoring

```ts
interface Schedule {
  cron: string; // 5-field cron expression
  tz?: string; // IANA timezone (default "UTC")
  prompt: string; // the turn's text = the job's instruction
}
function defineSchedule(schedule: Schedule): Schedule;
function loadSchedules(dir: string): Promise<{ schedules: LoadedSchedule[]; failures: ModuleLoadFailure[] }>;
function discoverScheduleFiles(dir: string): Promise<string[]>; // existence probe: file basenames, no import
// (deploy preflight's time-trigger detection; prefer loadSchedules to also surface broken files)
function createScheduler(opts: SchedulerOptions): Scheduler; // { start(): void; stop(): void }
function scheduleSession(name: string): string; // the derived stable session id
```

A workspace declares time-triggers by dropping `schedules/<name>.ts`, mirroring `tools/`/`channels/`;
the filename becomes the schedule name. Each file default-exports `defineSchedule({ cron, tz?, prompt })`.

```ts
// schedules/daily-digest.ts        → schedule "daily-digest"
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "Generate today's digest and send it to the team Telegram.",
});
```

The scheduler is a time-trigger (the N axis, clock form): on each cron instant it invokes the agent
with `prompt` — borrowing the same `Agent` contract as channels, adding none. It:

- **carries no `session` field** — a session id is runtime conversational context, not a build-time
  value. It derives a stable per-schedule session (`scheduleSession(name)` = `schedule:<name>`), so a
  schedule's turns share one continuing conversation persisted by the core session store (zero-touch on
  storage, like the telegram channel deriving a session from `chat.id`);
- **delivers nothing** — output is the agent's tools' job; the scheduler only fires and logs the outcome;
- **catches up an overdue run once** — durable `fires.json` under `<stateRoot>/schedule/` records the
  last fire; a run missed while the process was down fires once on the next start (not per missed slot),
  claimed before the invoke (at-most-once per slot).

Single-process (like all state today). `createScheduler({ agent, stateRoot, schedules })` is started by
the serve path (`dev`/`start`); `fastagent fire <name>` runs one schedule's turn immediately for authoring.

**Self-scheduling.** Opt in with `selfSchedule: true` in `fastagent.config` (off by default — an autonomy
capability, not given to every agent). Then the serving path (`dev`/`start`, where the poller runs — not the
one-shot `invoke`/`fire`) mounts a built-in **`wake`** tool so the agent can schedule itself: `wake({ in: "30m", prompt })`
records a one-shot wake-up — or `wake({ cron: "0 9 * * *", tz?, prompt })` a RECURRING one — persisted under
`<stateRoot>/schedule/`, polled by the scheduler and fired back into the SAME session, so the agent resumes
the conversation — the woken turn's prompt is enveloped with the wake-up's id and origin ("YOUR
self-scheduled turn, not a user message"), so the model can tell its own alarm from the user speaking. It reads the current session from `ToolContext.session`; guardrails cap the minimum delay,
the recurring frequency (≥10 min between fires), and the per-session pending count. The agent cancels its own
with `unwake({ id })` (session-scoped); the operator with `fastagent schedule cancel <id>` (`schedule list`
shows ids).

## Config and models

```ts
function defineConfig(config: FastagentConfig): FastagentConfig;
function listModels(models: Models): string[];
function resolveModel(models: Models, spec: string): Model;
function createPiModels(options?: CreatePiModelsOptions): Models;
function probeAuthSource(models: Models, spec: string): Promise<string | undefined>;
```

Auth:

```ts
const GLOBAL_AUTH_PATH: string; // ~/.fastagent/auth.json — the cross-project share target
function fastagentCredentialStore(authPath?: string, options?: FastagentAuthOptions): CredentialStore;
```

`fastagent login` writes the **project-level** `<state root>/auth.json` by default; `GLOBAL_AUTH_PATH`
is `createPiModels`'s default when no `authPath` is passed, and the explicit one-file share target
(`FASTAGENT_AUTH_PATH=~/.fastagent/auth.json`). Note the two defaults differ: an embedder calling
`createPiModels()` bare reads the global file, not a project-level `login` — pass `authPath` explicitly
to read the project's credential (the `createPiAgentFrom*` openers already do).

Provider injection:

```ts
function createProvider(...): Provider;
```

`createProvider`, `Provider`, `ProviderAuth`, and `Model` are re-exported from pi's model layer so callers do not need to depend on FastAgent internals.

## Sessions and leases

```ts
interface PiSessionStore {
  openOrCreate(sessionId: string): Promise<Session>;
}

/** Read-only sibling for the observation plane: unknown session → undefined, never created. */
interface PiSessionReader {
  openIfExists(sessionId: string): Promise<Session | undefined>;
}

function inMemorySessionStore(): PiSessionStore & PiSessionReader;
function jsonlSessionStore(options: { dir: string; cwd?: string }): PiSessionStore & PiSessionReader;
```

Lease:

```ts
interface Lease {
  tryAcquire(session: string): Release | null;
}

type Release = () => void;
function inProcessLease(): Lease;
```

The lease is the same-session concurrency floor. A failed acquisition yields a retryable `failed` event.

## Session control (observation plane)

The optional serving extension beside `invoke`
([design](design/session-control.md)): watch and reconnect to invoke-driven runs. Neutral types live
in `@fastagent-sh/fastagent/session`; the pi implementation in `/pi`:

```ts
import type { SessionControl, SessionEvent } from "@fastagent-sh/fastagent/session";
import { createPiAgent, createPiSessionControl, inMemorySessionStore } from "@fastagent-sh/fastagent/pi";

const sessions = inMemorySessionStore();
const { control, observer } = createPiSessionControl({ sessions });
const agent = createPiAgent({ model: "openai-codex/gpt-5.5", sessions, observer });

// Live events are NOT durable history: a subscription sees only what happens while it iterates,
// so start watching BEFORE (or while) the run is driven — never after it drained.
const watching = (async () => {
  for await (const ev of control.events("s1")) {
    console.log(ev.type); // run_started, message_delta, tool_started, …
    if (ev.type === "run_settled") break; // events() has no natural end — the consumer decides
  }
})();
for await (const e of agent.invoke({ session: "s1" }, { text: "hi" })) void e; // the data plane
await watching;

// After a disconnect, missed history comes from the durable plane, not the live stream:
const { entries, leafEntryId } = await control.entries("s1", { since: cursor });
const state = await control.state("s1"); // { status, activeRunId?, leafEntryId? }
```

`invoke` stays the only way to start work; the `AgentEvent` stream is a projection of the rich
`SessionEvent` stream. `dispatch` modulates the run an invoke is driving — acceptance is not
outcome (`ok: true` = admitted; the result arrives as `run_settled`):

```ts
await control.dispatch("s1", { type: "steer", prompt: { text: "use bun, not npm" } }); // joins the run
await control.dispatch("s1", { type: "follow_up", prompt: { text: "then summarize" } }); // FIFO queue
await control.dispatch("s1", { type: "abort" }); // invoke ends failed{code:"aborted"}, run_settled{aborted}
```

With steering/follow-ups the invoke stream terminates at the run's SETTLE (all queued continuations
drained) — for consumers that never dispatch, a run equals a single turn, byte-identical behavior.
Run commands on an idle session reject with `no_active_run` before acceptance; a command that
reached a run but could not take effect (the run raced to settlement) rejects with
`run_command_failed`. Both are `retryable: false` — the same command as-is fails again; consult
`state()` before re-dispatching. The race window applies to all three commands symmetrically: an
accepted `abort` can still settle `completed`, and an accepted `steer`/`follow_up` can settle
without its prompt being consumed, when the run finishes inside the window — acceptance is not
outcome; the settlement is the truth.

Boundary mutations run between runs, under the SAME lease (`session_busy` while a run is active,
retryable at idle):

```ts
await control.dispatch("s1", { type: "set_model", model: "anthropic/claude-sonnet-4-5" }); // durable per-session override
await control.dispatch("s1", { type: "set_thinking", level: "high" });
await control.dispatch("s1", { type: "compact", instructions: "keep the decisions" }); // accept-fast: ok on
// admission; the outcome arrives as compaction_finished{summary|error|aborted} (emitted after the
// lease frees; aborted = a deliberate stop via dispatch(abort) — not a failure)
```

Overrides persist in the session record and every later turn's fresh harness applies them — on any
serving path, channels included. Boundary mutations require an EXISTING session (`no_such_session`
otherwise): sessions are created by `invoke`, never by the control plane. Invalid payloads reject
`invalid_command` before acceptance;
`capabilities()` lists `allowedModels`/`allowedLevels`. Boundary commands require the wiring the
workspace opener provides (`sessionControl: true`); a hub without it reports them off and rejects
with `unsupported_capability`.

For workspace assembly the store lives inside the opener, so ask the opener to wire the hub:

```ts
const { agent, sessionControl } = await createPiAgentFromWorkspace(dir, { sessionControl: true });
```

### Remote (HTTP + SSE)

The same contract over the wire — for a Web panel, a desktop app, or `fastagent attach`. Server
side, mount the bearer-authenticated routes (dev/start do this automatically when the config sets
`sessionControl: true`, minting a per-boot token into `<stateRoot>/control.json`):

```ts
import { controlRoutes, connectSessionControl } from "@fastagent-sh/fastagent/core";

const routes = controlRoutes(sessionControl, { token }); // GET/POST /control/*, SSE at /control/events

// Client side — the SAME SessionControl interface, isomorphic to local:
const remote = await connectSessionControl({ url: "http://127.0.0.1:8787", token });
for await (const ev of remote.events("s1")) console.log(ev.type);
```

The DATA plane travels the same wire: `connectAgent({ url, token })` returns an `Agent` whose
`invoke` drives `POST /control/invoke` (mounted when the serve wires an agent — dev/start do) —
paired with `connectSessionControl`, a client holds a full remote fastagent instance through the
same two contracts local code uses. Disconnecting the invoke stream cancels the run. The invoke wire is
text-only for now (images fail visibly there); `steer`/`follow_up` via `dispatch` carry full
Prompts, images included — within the dispatch body cap (1 MiB, with base64 inflation counted;
oversized bodies get a 413 naming the limit).

The transport envelope (`epoch`/`seq` per SSE message) is consumed inside the client: a sequence
gap — and any mid-stream transport failure, a server restart included — throws from the events
iterator so the consumer's failure handling owns it (only the consumer's own detach reads as a
clean end); recovery is the standard reconnect steps. Exposing the port beyond loopback exposes a
remote-control surface — wrap it with real authentication and authorization
([design §14](design/session-control.md)).

## Subpath exports

```ts
import { type Agent, collect, readBodyCapped } from "@fastagent-sh/fastagent/core";
import type { SessionControl, SessionEvent } from "@fastagent-sh/fastagent/session";
import { createPiAgent, defineTool, z } from "@fastagent-sh/fastagent/pi";
import { githubChannel } from "@fastagent-sh/fastagent/github";
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";
import { larkChannel } from "@fastagent-sh/fastagent/lark";
```

`core` avoids loading the pi reference runtime and is the preferred dependency for engine-neutral
channels. The root entry remains the supported convenience surface. See [GitHub channel](github.md),
[Telegram channel](telegram.md), and the canonical [Feishu channel with Lark compatibility](feishu.md).
