---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent contract, the service assembly, the channel kit, typed tools, sessions, and providers."
status: current
---

# API reference

This is a compact reference for the all-in-one `@fastagent-sh/fastagent` entry. The same exports are
layered across subpaths by what each costs to import:

| | engine-neutral | runtime-neutral | pulls |
|---|---|---|---|
| `/core`, `/session` | yes | yes | nothing |
| `/node` | yes | no | the Node HTTP bridge and a cron |
| `/pi` | no | no | the pi runtime |

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
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string } // advisory backoff
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
// From `@fastagent-sh/fastagent/node` — the only runtime-specific entry, and the only one that
// costs a third-party package (the node:http ↔ Fetch bridge).
function nodeListener(handler: ChannelHandler): (req, res) => void;
// `host` is the bind address; unset binds all interfaces (what containers need).
function serveNode(handler: ChannelHandler, options: { port: number; host?: string }): {
  listening: Promise<number>;
  close(): Promise<void>;
  closeAllConnections(): void;
};
```

Route types:

```ts
type ChannelHandler = (req: Request) => Response | Promise<Response>;
type Routes = Record<string, ChannelHandler>;
```

Route keys are `"/path"` (any method) or `"METHOD /path"`, and the path is a **literal**.

Dispatch is a map lookup on the literal path, so "would these two fight over a request?" is string
equality — a fact about the keys, not a prediction about a matcher. `:id` and `*` carry no pattern
meaning here; they are ordinary characters, so a key containing one simply never matches.

Startup refuses only what would cost ANOTHER route: two keys naming the same one (`"/x"` and
`"GET /x"`), a route inside a mounted prefix, and any path a URL rewrites (`?`/`#`, `.`/`..`) —
that request arrives under a different path, so the key never matches AND compares as distinct,
hiding the collision.

Paths are matched as they arrive, without percent-decoding — decoding would undo the normalisation
`URL` performs, turning `%2F..%2F` back into `/../`. `HEAD` is answered from the `GET` route without
the content (RFC 9110); writing an explicit `HEAD` route is allowed and takes precedence.

A path that exists under another method answers 405, an unknown path 404; remote clients read that
404 as version skew rather than as a fault.

A handler owning a whole path prefix (the session control plane is the one) is mounted beside the
routes rather than spelled as a key. `createAgentService` does that wiring; a route landing inside
such a mount is refused at assembly, because the mount would answer requests aimed at it.

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
| `tools` | Agent tools — `MountedTool[]`. An authored `FastagentTool[]` (what `defineTool` returns) widens into it; the wider type additionally admits pi's cwd-bound coding tools. |
| `skills` | Loaded Agent Skills. |
| `sessions` | `PiSessionRecordStore`. |
| `env` | `ExecutionEnv` handed to lower-level tools that read one; at L2 it also reads `persona.md` and `skills/`. Not a sandbox: ② project context, all seven directory coding tools, and author-written `tools/` reach the machine directly. |
| `lease` | Same-session concurrency lease. |
| `providers` | Extra model providers. |

### `createPiAgentFromDefinition`

```ts
function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }>;
```

Load `persona.md`/`skills/` from `dir` (the agent dir) and assemble the pi prompt. `②` project context is sourced via pi's `loadProjectContextFiles({ cwd, agentDir: dir })` — the dir's own `AGENTS.md` plus every `AGENTS.md` walking `cwd` (option; default `dir`) up to root. Pass `cwd` to decouple the workspace (where tools operate, whose repo `AGENTS.md` is context) from the agent dir — `createPiAgentFromDir` always passes the resolved workspace, which is the directory fastagent was pointed at (the agent dir's parent when the agent was found one level inside it, the agent dir itself when you aimed straight at it).

`LoadedDefinition` carries `contextFiles: Array<{ path; content }>` (the ② files), `persona?` (from `persona.md`, ①), `skills`, and diagnostics/collisions (`SkillDiagnostic[]` / `SkillCollision[]` — both exported).

### `createAgentService`

```ts
function createAgentService(
  dir: string,
  options?: { model?: string; authPath?: string; sessionsDir?: string; signal?: AbortSignal;
              onChannelClosed?: (name: string, error?: unknown) => void },
): Promise<{
  handler: ChannelHandler;              // channels + control plane + health, composed
  agent: Agent;
  routes: Routes;                        // what is served, for a startup line
  agentDir: string;
  workspace: string;
  channels: { routes: string[]; longConnections: string[]; builtinInvoke: boolean };
  schedules: readonly LoadedSchedule[];
  ready: Promise<void>;             // settles when long connections are up; rejects if one cannot
  control?: { token: string; prefix: string };  // the plane's bearer token, when sessionControl is on
  announce(boundPort: number): void;     // write <stateRoot>/control.json for local discovery
  close(): Promise<void>;                // stop long connections and schedules; rejects if one fails
                                         // to stop, or does not stop within 5s
}>;
```

The assembly `dev`/`start` perform, without the process: no port bound, no signal handlers, no
`process.exit`. This is the supported way to mount a whole agent inside an app; `nodeListener` and
`serveNode` below are how you attach the handler it returns.

### `createPiAgentFromDir`

```ts
function createPiAgentFromDir(
  dir: string,
  options?: { model?: string; sessionsDir?: string; authPath?: string; serving?: boolean },
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  modelSpec: string;
  agentDir: string; // where the agent lives
  workspace: string; // the agent's cwd — the agent dir's parent
  stateRoot: string;
  sessionsDir: string;
  authPath: string;
  toolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}>;
```

The same opener used by `fastagent dev`, `invoke`, and `start`: load config, resolve model/tools, pick session storage, and assemble the directory. Set `serving: true` only for a long-running host that also runs the scheduler; it allows an opted-in workspace to mount its `wake` tool.

```ts
interface FastagentConfig {
  tools?: FastagentTool[];
}
```

Every directory-opening workflow (`dev`, `start`, `invoke`, `chat`, `tool`, and `info`) mounts the
complete coding set. Conditional built-ins stay independent: deferred tools may add `search_tools`,
and `selfSchedule` may add `wake` while serving. `createPiAgentFromDefinition` uses the complete coding
set unless `tools` replaces it; `createPiAgent` starts from the passed `tools`. In both APIs, omitted
coding built-ins cannot be reactivated, while deferred tools may add `search_tools`.

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

`tools/<name>.ts` files are discovered by the assembly, and the filename becomes the tool name.

The second `execute` argument is a `ToolContext`:

```ts
interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  sessionManager?: ReadonlySessionManager;
  tools?: ToolActivation;
}

interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<PiSessionEntry[]>;
}
```

During serving and `fastagent chat`, `sessionManager` is FastAgent's read-only adapter over the current
conversation. It is undefined in a sessionless direct call such as `fastagent tool`. Current bindings
ride `AsyncLocalStorage`, not definition closures, because a tool is built once and reused across turns.
The built-in **`wake`** tool uses `sessionManager.getSessionId()` to schedule a follow-up in the same
conversation.

### Deferred tools

For tool-heavy agents, `defineTool({ ..., deferred: true })` registers a tool without activating it:
its schema stays out of every request (and the model's sight) until discovered. When any deferred tool
is mounted, fastagent automatically mounts the built-in **`search_tools`** loader (an agent's own tool
named `search_tools` wins — the author owns the concept then): the model searches by keywords, matching
tools are activated mid-turn, and the activation is recorded in the session, so it survives fastagent's
per-invoke session rebind for the rest of that conversation.

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
  calls). An agent's `search_tools` missing the mode gets it forced, with a warning.
  Both types are exported: `ToolActivation`, and `FastagentTool` (`AgentTool` + the `deferred` marker —
  the type `config.tools` and the L1/L2 `tools` options accept, so a raw object literal with
  `deferred: true` type-checks).
- At L1 (`createPiAgent`) the `instructions` are verbatim by contract — fastagent does not inject the
  discovery note the directory path's base prompt carries. When passing deferred tools at L1, tell the
  model about `search_tools` in your own instructions (or rely on the loader's description alone,
  which is weaker).
- An activation is persisted as a dedicated DELTA entry in the session ("this conversation activated
  these deferred tools"): on reopen the active set is rebuilt as the initial set (current non-deferred
  tools) plus the accumulated deltas. A tool you add to the agent later joins existing
  conversations, and a tool you later flip to `deferred` drops out of sessions that never discovered
  it.
- **`fastagent chat` emulates deferral** like the serving path (what you iterate is what you serve):
  the session starts with deferred tools inactive, the same `search_tools` loader discovers and
  activates them (bridged to chat's resident session instead of the served one), and the prompt is
  identical. One divergence: chat activations do not survive `/new`/`/resume` — pi's chat session
  does not record them, so a resumed conversation re-discovers via `search_tools` (on the serving
  path activations persist in the session for the conversation's life).

## Channel authoring

```ts
interface ChannelContext {
  agent: Agent;
  stateRoot: string; // resolved state root (FASTAGENT_STATE_DIR > <root>/.state), absolute
}
type ChannelModule = (ctx: ChannelContext) => Routes;
interface LongConnection {
  ready: Promise<void>; // settles on first usable connection; on a pre-ready abort it still settles (cancellation)
  closed: Promise<void>; // resolves after abort-driven shutdown; rejects on terminal failure
}
interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): LongConnection;
}
```

An agent channel default-exports either a route `ChannelModule` or a
`LongConnectionChannelModule`. Bundled webhook adapters (`telegramChannel(opts)`,
`githubChannel(opts)`, `feishuChannel(opts)`) return `ChannelModule`; `feishuWebSocketChannel(opts)`
and `larkWebSocketChannel(opts)` return `LongConnectionChannelModule`. In both forms the channel file
is one expression; a channel persisting durable state derives its home from
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
```

An agent declares time-triggers by dropping `schedules/<name>.ts`, mirroring `tools/`/`channels/`;
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
  value. It derives a stable per-schedule session (`schedule:<name>`), so a
  schedule's turns share one continuing conversation persisted by the core session store (zero-touch on
  storage, like the telegram channel deriving a session from `chat.id`);
- **delivers nothing** — output is the agent's tools' job; the scheduler only fires and logs the outcome;
- **catches up an overdue run once** — durable `fires.json` under `<stateRoot>/schedule/` records the
  last fire; a run missed while the process was down fires once on the next start (not per missed slot),
  claimed before the invoke (at-most-once per slot).

Single-process (like all state today). The scheduler is started by
the serve path (`dev`/`start`); `fastagent fire <name>` runs one schedule's turn immediately for authoring.

**Self-scheduling.** Opt in with `selfSchedule: true` in `fastagent.config` (off by default — an autonomy
capability, not given to every agent). Then the serving path (`dev`/`start`, where the poller runs — not the
one-shot `invoke`/`fire`) mounts a built-in **`wake`** tool so the agent can schedule itself: `wake({ in: "30m", prompt })`
records a one-shot wake-up — or `wake({ cron: "0 9 * * *", tz?, prompt })` a RECURRING one — persisted under
`<stateRoot>/schedule/`, polled by the scheduler and fired back into the SAME session, so the agent resumes
the conversation — the woken turn's prompt is enveloped with the wake-up's id and origin ("YOUR
self-scheduled turn, not a user message"), so the model can tell its own alarm from the user speaking. It reads the current session through `ToolContext.sessionManager`; guardrails cap the minimum delay,
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
const GLOBAL_AUTH_PATH: string; // ~/.fastagent/.secrets/auth.json — the cross-project share target
function fastagentCredentialStore(authPath?: string, options?: FastagentAuthOptions): CredentialStore;
```

`fastagent login` writes the **project-level** `<agent dir>/.secrets/auth.json` by default; `GLOBAL_AUTH_PATH`
is `createPiModels`'s default when no `authPath` is passed, and the explicit one-file share target
(`FASTAGENT_AUTH_PATH=~/.fastagent/.secrets/auth.json`). Note the two defaults differ: an embedder calling
`createPiModels()` bare reads the global file, not a project-level `login` — pass `authPath` explicitly
to read the project's credential (the `createPiAgentFrom*` openers already do).

Provider injection:

`Provider`, `ProviderAuth` and `Model` are re-exported as TYPES because they appear in our options —
a caller must be able to name them. The factory that builds one is pi's own: import `createProvider`
from `@earendil-works/pi-ai` directly, so its API answers to its own package.

## Sessions and leases

```ts
interface PiSessionRecordStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<SessionManager>;
  /** Read-only sibling for the observation plane: unknown session → undefined, never created. */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
}

/** Where a NEW thread starts from. Read only on the create path; an existing session ignores it. */
interface SessionInheritance {
  parentSession: string;
  branchHints?: string[];
}

function piInMemorySessionRecordStore(options?: { cwd?: string }): PiSessionRecordStore;
function piSessionRecordStore(options: { dir: string; cwd?: string }): PiSessionRecordStore;
```

`piSessionRecordStore`'s `dir` is resolved against `cwd` (which itself defaults to `process.cwd()`), so
a relative path means "inside the workspace this store serves". `cwd` also scopes lookups: two stores
sharing one `dir` but serving different workspaces never open each other's sessions.

Session ids are the Caller's, and arbitrary — a telegram group is `-1001234567890`, a feishu thread
carries `:` and `/`. pi accepts none of those as a record name, so the store encodes them
injectively (`-1001234567890` becomes `s-1001234567890` on disk, readable enough to tell which room a
file belongs to). A record is published complete: pi buffers a new session until its first assistant
message, which would otherwise lose the user's question to a crash AND make open-or-create
non-idempotent.

Both backends inherit: the durable one forks the parent's record, the in-memory one copies its path
entry by entry. Inheritance is a property of the contract, not of the medium — a thread must not
forget its room because the store happens to be in memory.

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
import { createPiAgent, createPiSessionControl, piInMemorySessionRecordStore } from "@fastagent-sh/fastagent/pi";

const sessions = piInMemorySessionRecordStore();
const { control, observer } = createPiSessionControl({ sessions });
const agent = createPiAgent({ model: "openai-codex/gpt-5.5", sessions, observer });
// This agent has no definition, so `control.commands()` is `[]` — true, not a gap. Over a DIRECTORY
// agent, pass `commands: async () => …` returning one `AgentCommand` per name the definition
// exposes, re-read per call; otherwise the list claims the definition's skills do not exist.
// `createPiAgentFromDir` wires it for you.

// Live events are NOT durable history: a subscription sees only what happens while it iterates,
// so start watching BEFORE (or while) the run is driven — never after it drained.
const watching = (async () => {
  for await (const ev of control.sessions.get("s1").events()) {
    console.log(ev.type); // run_started, message_delta, tool_started, …
    if (ev.type === "run_settled") break; // events() has no natural end — the consumer decides
  }
})();
for await (const e of agent.invoke({ session: "s1" }, { text: "hi" })) void e; // the data plane
await watching;

// What a `/` composer LISTS (read live, so a skill added while serving appears at once). A listing
// only — the data plane takes prompts as text, so what typing `/triage` means is the client's.
await control.commands(); // [{ name: "triage", description: "Sort an inbox", source: "skill" }]

// After a disconnect, missed history comes from the durable plane, not the live stream:
const s1 = control.sessions.get("s1"); // a pure binding: an id + the transport, nothing to dispose
const { entries, leafEntryId } = await s1.entries({ since: cursor });
const state = await s1.state(); // { status, name?, activeRunId?, leafEntryId? }
```

`invoke` stays the only way to start work; the `AgentEvent` stream is a projection of the rich
`SessionEvent` stream. A session's ACTIONS modulate the run an invoke is driving — acceptance is not
outcome (`ok: true` = admitted; the result arrives as `run_settled`):

```ts
await s1.steer({ text: "use bun, not npm" });   // joins the run
await s1.followUp({ text: "then summarize" });  // FIFO queue
await s1.abort();                                // invoke ends failed{code:"aborted"}, run_settled{aborted}
```

With steering/follow-ups the invoke stream terminates at the run's SETTLE (all queued continuations
drained) — for consumers that never act on a run, a run equals a single turn, byte-identical
behavior. Actions on an idle session reject with `no_active_run` before acceptance; one that reached
a run but could not take effect (the run raced to settlement) rejects with `run_command_failed`. Both
are `retryable: false` — the same call fails again; consult `state()` before trying again. The race
window applies to all three symmetrically: an
accepted `abort` can still settle `completed`, and an accepted `steer`/`follow_up` can settle
without its prompt being consumed, when the run finishes inside the window — acceptance is not
outcome; the settlement is the truth.

`commands()` lists what a `/` composer completes: `{ name, description?, source }` per named thing
the definition exposes (`source: "skill"` today). It is a LISTING, not a dispatch surface — the data
plane takes prompts as text and nothing expands `/name`, so what typing one means is the client's
choice. It is read live and uncached — the definition's `skills/` is re-read per call (the ②
context walk the full load does is skipped: this answers at composer-open frequency) — so a skill
added while serving appears at once; `[]` means the agent exposes none. It is also the one read that can REJECT:
a definition the server cannot read at all is a deployment fault with no truthful degraded value, and
the rejection carries no stable code (remotely: an uncoded non-2xx → `ControlRequestError`). Wrap the
call, and expect no `error.code` to branch on.

`sessions.list()` is the deployment's conversation list — `{ session, name?, createdAt, updatedAt,
messageCount, preview? }` per record, with `session` being the id the CALLER minted (a channel's
thread key, not a storage name). It is DEPLOYMENT-level: it answers for every session at once, so a
multi-tenant facade in front of one deployment must not expose it (it does not need to — it already
holds its own user→sessions mapping). It is the one read besides `commands()` that can REJECT, and
unlike that one it carries a stable code: a store that cannot be enumerated answers
`sessions_unavailable` (remotely: 503 with the code on `ControlRequestError.code`), because `[]`
already means "no sessions".

Building that list costs a full read of every record, so an unchanged store answers from the last
build (one `stat` per record decides). A poll against an idle deployment is therefore cheap; one
against a deployment mid-turn rebuilds. Refresh on a timer if you like — but drive the open
conversation from `events()`, not from re-listing.

Writes run between runs, under the SAME lease (`session_busy` while a run is active, retryable at
idle). A session's PROPERTIES are one patch — `update` validates every field before writing any, so a
rejected patch leaves nothing behind, and one event reports the result:

```ts
await s1.update({ name: "Deploy notes" });                      // the list's label
await s1.update({ model: "anthropic/claude-sonnet-4-5" });      // durable per-session override
await s1.update({ thinkingLevel: "high" });
await s1.update({ leafEntryId: entryId });                      // move the leaf → state_changed
await s1.update({ model: "anthropic/claude-opus-4-5", thinkingLevel: "high" }); // one call, one event
```

A patch is validated as a whole — a rejected one leaves nothing behind, which is what makes
`ok: false` safe to retry. The writes themselves are separate journal entries, so a failure BETWEEN
them (a full disk) answers `partial_update` naming what landed, after an event reporting the record
as it now is: read `state()` before retrying. A field this serve does not know rejects
`unsupported_capability` — the same code on both planes, naming the field, so a newer client talking
to an older serve knows which one to drop; a wrong value type is `invalid_command`.

`leafEntryId` is the write verb for the tree `entries()` publishes: it moves the session's active
leaf, so the next turn hangs off it instead of the old one — which is also how sibling branches come
to exist. An id that `entries()` did not publish rejects `invalid_command`. Gate each field on
`capabilities().updatable`.

The rest are whole-record or run-scoped calls:

```ts
await s1.compact({ instructions: "keep the decisions" }); // accept-fast: ok on admission; the
// outcome arrives as compaction_finished{summary|error|aborted} (emitted after the lease frees;
// aborted = a deliberate s1.abort() — not a failure)
await control.sessions.fork({ from: "s1", at: entryId, into: "s1-b" }); // copy history into a NEW session
await s1.delete();                                                       // irreversible
```

`fork` names its target: `into` is a Caller id like any other, so the plane invents nothing. It is
IDEMPOTENT — the new record carries where it came from, so repeating the same fork answers `ok: true`
and writes nothing (a retry after a lost response does not produce a second record), while the same
id holding a different history rejects `invalid_command`. Cloning is `fork` at the session's own
`leafEntryId`. There is no `create` — `invoke` is what brings a session into being. `delete` ends the
session's live `events()` streams; it is guarded by the same bearer token as every other call, which
is the only key the framework owns.

Overrides persist in the session record and every later turn's fresh session binding applies them — on any
serving path, channels included. One exception: a recorded thinking level the session's CURRENT
model cannot do is clamped by pi's own clamp instead of riding a run that would ignore it. `update({ model })`
re-records the clamped level, so `state()` and the execution agree and the client gets
it in the same `state_changed`; the resolve keeps clamping as a BACKSTOP for what the boundary cannot
see (a deployment whose CONFIGURED model changed between restarts), and there it warns server-side
while `state()` reports the recorded level. Note the clamp's direction: it takes the lowest supported
level at or above the recorded one and only falls back downward if nothing above exists — a gap
resolves upward, which costs more, not less. Writes require an EXISTING session (`no_such_session`
otherwise): sessions are created by `invoke` or copied by `fork`, never minted by an update. Invalid
payloads reject `invalid_command` before acceptance. `capabilities()` lists `allowedModels` (the
deployment's registry — a static fact) but not thinking LEVELS: which exist depends on the model a
session is running, so they ride `state().availableThinkingLevels`, and `update({ thinkingLevel })`
validates against that same set rather than recording an override the run would ignore. Every write
requires the wiring the agent opener provides (`sessionControl: true`); a hub without it reports an
empty `updatable`, `fork: false`, `delete: false`, and rejects with `unsupported_capability`.

For agent assembly the store lives inside the opener, so ask the opener to wire the hub:

```ts
const { agent, sessionControl } = await createPiAgentFromDir(dir, { sessionControl: true });
```

### Remote (HTTP + SSE)

The same contract over the wire — for a Web panel, a desktop app, or `fastagent attach`. Server
side, mount the bearer-authenticated routes (dev/start do this automatically when the config sets
`sessionControl: true`, minting a per-boot token into `<stateRoot>/control.json` — or using
`FASTAGENT_CONTROL_TOKEN` when the environment sets it, which is how a deployed box gets a token its
callers already know):

```ts
import { createAgentService } from "@fastagent-sh/fastagent";
import { connectSessionControl } from "@fastagent-sh/fastagent/core";

// Set `sessionControl: true` in fastagent.config.*; the plane is then mounted on the service's
// handler, owning the /control prefix — routes, preflight, 404/405 and a failing handler all carry
// CORS headers, so a browser client can read every reply. SSE at /control/sessions/{id}/events.
const service = await createAgentService("./my-agent");
// service.control?.token is how you hand a client access

// Client side — the SAME SessionControl interface, isomorphic to local:
const remote = await connectSessionControl({ url: "http://127.0.0.1:8787", token });
for await (const ev of remote.sessions.get("s1").events()) console.log(ev.type);
```

The DATA plane travels the same wire: `connectAgent({ url, token })` returns an `Agent` whose
`invoke` drives `POST /control/invoke` (mounted when the serve wires an agent — dev/start do) —
paired with `connectSessionControl`, a client holds a full remote fastagent instance through the
same two contracts local code uses. Disconnecting the invoke stream cancels the run. The invoke wire is
text-only for now (images fail visibly there); `steer`/`followUp` carry full Prompts, images
included — within the action body cap (1 MiB, with base64 inflation counted; oversized bodies get a
413 naming the limit).

The wire is RESTful and mechanical, so a non-TypeScript client is a `curl` away:

```
GET    /control/sessions                       list
PUT    /control/sessions/{id}                  {from, at} — fork (idempotent)
GET    /control/sessions/{id}                  state
PATCH  /control/sessions/{id}                  {name?, model?, thinkingLevel?, leafEntryId?}
DELETE /control/sessions/{id}
GET    /control/sessions/{id}/entries          ?since=
GET    /control/sessions/{id}/events           SSE
POST   /control/sessions/{id}/actions          {type: "steer"|"follow_up"|"abort"|"compact"}
```

`{id}` is percent-encoded, so a Telegram group is `/control/sessions/tg%3A-1001234567890` — session
ids are opaque Caller strings and may contain `:` and `/`.

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
import { slackChannel } from "@fastagent-sh/fastagent/slack";
import { feishuChannel } from "@fastagent-sh/fastagent/feishu";
import { larkChannel } from "@fastagent-sh/fastagent/lark";
```

`/core` loads no third-party package at all, which is what makes it the right dependency for a
channel package or a second engine. The root entry remains the supported all-in-one. See [GitHub channel](github.md),
[Telegram channel](telegram.md), [Slack channel](slack.md), and the canonical [Feishu channel with Lark compatibility](feishu.md).
