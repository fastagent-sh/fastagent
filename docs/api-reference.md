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

Route keys are `"/path"` (any method) or `"METHOD /path"`, and the path is a **literal**: `:id` and `*` are
ordinary characters. Startup refuses two keys naming the same route (`"/x"` and `"GET /x"`), a route inside a
mounted prefix, and a path containing `?`, `#`, `.` or `..` segments. Paths are matched without percent-decoding.
`HEAD` is answered from the `GET` route unless you define one. A path that exists under another method answers 405;
an unknown path, 404.

A handler owning a whole prefix (the session control plane) is mounted beside the routes; `createAgentService`
wires it and refuses a route inside it.

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
| `instructions` | String or function returning the system prompt. The function is evaluated once per invoke, never during construction; a thrown error becomes that turn's `failed` event. |
| `tools` | `MountedTool[]`: `AgentTool` with optional native Pi execution context. Serving/chat forward progress updates and context; direct CLI calls are sessionless. |
| `skills` | Loaded Agent Skills. Pi lists them in the system prompt when `read` is active. |
| `sessions` | `PiSessionRecordStore`. |
| `env` | `ExecutionEnv` supplies `cwd` at L1; at L2 it also reads `persona.md` and `skills/`. Project context and tools use the local process directly. This is not a sandbox. |
| `lease` | Same-session concurrency lease. |
| `providers` | Extra model providers. |

Tool contexts preserve the original caller session id. FastAgent's default `bash` tool also exposes it
as `PI_SESSION_ID`. When the id contains NUL or unpaired UTF-16 surrogates, the shell receives its JSON
string representation and `PI_SESSION_ID_ENCODING=json`. Otherwise the value is unchanged and the
encoding marker is unset. Read both variables to distinguish an encoded id from a literal JSON-looking
id; use `JSON.parse` only when the marker is `json`.

Caller-created Pi shell tools retain their construction options. Configure their `spawnHook` with the
same environment encoding policy, or use `exposeSessionEnvironment: false` when `PI_*` metadata is
unnecessary. FastAgent cannot retrofit a spawn hook into an existing tool instance.

### `createPiAgentFromDefinition`

```ts
function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }>;
```

Load `persona.md`/`skills/` from `dir` (the agent dir) and assemble the pi prompt. `②` project context is sourced via pi's `loadProjectContextFiles({ cwd, agentDir: dir })` — the dir's own `AGENTS.md` plus every `AGENTS.md` walking `cwd` (option; default `dir`) up to root. Pass `cwd` to decouple the workspace (where tools operate, whose repo `AGENTS.md` is context) from the agent dir — `createPiAgentFromDir` passes the workspace, which is always the agent dir's parent.

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
  channels: { routes: string[]; longConnections: string[] };
  unverifiedRoutes: readonly string[];     // the route keys fastagent itself serves here
                                          // ("POST /invoke", "GET /health"), minus what a channel
                                          // took over or `http.invoke: false` withheld
  routines: readonly LoadedRoutine[];
  ready: Promise<void>;             // settles when long connections are up; rejects if one cannot
  controlPrefix?: string;                // "/control", when sessionControl is on
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

The same opener used by `fastagent dev`, `invoke`, and `start`: load config, resolve model/tools, pick session storage, and assemble the directory. Set `serving: true` only for a long-running host that also runs the scheduler; it mounts `wake`/`unwake`.

```ts
interface FastagentConfig {
  tools?: FastagentTool[];
}
```

Every directory-opening workflow (`dev`, `start`, `invoke`, `chat`, `tool`, and `info`) mounts the
complete coding set. Conditional built-ins stay independent: deferred tools may add `search_tools`,
and every serve adds `wake`/`unwake`. `createPiAgentFromDefinition` uses the complete coding
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

The Zod schema is also sent to the provider for **constrained sampling** (`strict: "prefer"`): on a model that
supports it, arguments are sampled against the schema. A schema that cannot be expressed strictly, or a provider
without strict mode, falls back silently to an ordinary function tool. Constructs that cannot be strict:
`z.record(...)`, a union of objects or arrays, `z.tuple(...)`, `z.looseObject(...)`.

A strict schema has no "absent", so a constrained model sends `null` for an optional field. pi drops those
`null`s unless your schema accepts `null`, so a `.nullable().optional()` field arrives as `null`. If a tool treats
absent and `null` differently, model the two cases another way.

### Running a tool alone in its batch

A model can call several tools in one assistant message, and pi runs the batch concurrently.
`defineTool({ ..., executionMode: "sequential" })` makes pi run any batch containing this tool one call at a time.
Use it when a tool's work must not overlap another's (shared files, exclusive resources). The default is
`"parallel"`.

### Declaring the secrets a tool needs

A tool that needs an env var says so where it is defined:

```ts
export default defineTool({
  description: "Post to X.",
  input: z.object({ text: z.string() }),
  secrets: ["X_API_KEY", "X_API_SECRET"],
  async execute({ text }, ctx) {
    return await post(text, ctx.secrets.X_API_KEY); // typed from the list above
  },
});
```

Read credentials this way rather than from `process.env`:

- **`dev`/`start` refuse to boot**, and `deploy --run` refuses to start, while a declared name has no value,
  naming the file. Without the declaration the same mistake surfaces as a failed tool call on the deployed
  box, days later.
- **The value is typed and handed to your code**, so the declaration cannot drift from the read.

`deploy` carries every variable in `.secrets/.env` whether or not code declares it; a declaration makes one
required.

`ctx.secrets` reads the process environment on every call; `.secrets/.env` is read once at startup. Its keys are
typed from the list. `defineChannel` and `defineRoutine` take the same field, and `fastagent info` prints every
declared name and flags the ones with no value.

The second `execute` argument is a `ToolContext`:

```ts
interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  sessionManager?: ReadonlySessionManager;
  tools?: ToolActivation;
  /** The values of this tool's own `secrets`, keyed by the names it declared. */
  secrets: Record<string, string>;
}

interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<PiSessionEntry[]>;
}
```

During serving and `fastagent chat`, `sessionManager` is a read-only view of the current conversation; it is
undefined in a sessionless call such as `fastagent tool`. `getSessionId()` returns the caller's session id.

### Output budget

Everything a tool returns is spent from the model's context, on every turn that keeps the result in view. A
raw page of 30 search results from a typical REST API can cost ~45k tokens.

Return what the model needs, not what the API sent:

- **Project the fields.** A name, a URL and a description usually replace the whole object.
- **Truncate, and say so.** The scaffolded `tools/fetch-url.ts` is the pattern: a `MAX_TEXT` ceiling
  plus a `truncated: true` flag, so the model knows the text was cut rather than guessing.
- **Expose the paging knob** (`per_page`, `limit`) as an input, so the model can ask for less.

`fastagent tool <name> '<json>'` reports the size of what the model would receive:

```
[fastagent] result: 143910 chars ≈ 35978 tokens to the model
```

Tools are plain ES modules, so they can be imported and tested without fastagent: `node --test
test/my-tool.test.ts` on Node 22+ needs no framework and no test script.

### Deferred tools

For tool-heavy agents, `defineTool({ ..., deferred: true })` registers a tool without activating it: its schema
stays out of requests until discovered. When any deferred tool is mounted, the built-in **`search_tools`** loader
is mounted too (your own tool named `search_tools` replaces it). The model searches by keyword, matching tools are
activated mid-turn, and the activation is recorded in the session for the rest of that conversation.

- **Discovery searches the `description`.** Write descriptions with the search in mind.
- On models with native deferred loading, activation keeps the provider's prompt-cache prefix; elsewhere it may
  cost a cache miss. The supported models are pi's (see its Dynamic Tool Loading docs).
- `ToolContext.tools` (`{ active(), registered(), activate(names) }`) is the bridge for a custom loader.
  `activate` is additive, ignores unknown names, and returns only the names it actually activated; count against
  that return value. A loader that awaits between `active()` and `activate()` should declare
  `executionMode: "sequential"`. `ToolActivation` and `FastagentTool` (`AgentTool` + `deferred`) are exported.
- `createPiAgent` uses `instructions` verbatim, so mention `search_tools` there yourself when passing deferred
  tools.
- On reopen, the active set is today's non-deferred tools plus the conversation's recorded activations: a tool
  added later joins existing conversations, and one made `deferred` drops out of those that never discovered it.
- `fastagent chat` behaves the same, except that activations do not survive `/new` or `/resume`.

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
`feishuChannel(opts)`) return `ChannelModule`; `feishuWebSocketChannel(opts)`
and `larkWebSocketChannel(opts)` return `LongConnectionChannelModule`. In both forms the channel file
is one expression; a channel persisting durable state derives its home from
`ctx.stateRoot` (`<stateRoot>/channels/<kind>`), never `process.cwd()`. Enabled files end in `.ts`,
`.js`, or `.mjs`; rename one to `<name>.ts.disabled` to disable it.

A serve refuses to start if an enabled file under `tools/`, `channels/` or `routines/` cannot load, and names
every file that failed. An absent directory is valid. `fastagent info` and `fastagent tool` load what they can and
report the rest.

Channel adapters can also use:

```ts
function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response;
const textHeaders: { readonly "content-type": "text/plain" };
```

See [Channel development](channel-development.md).

## Routine authoring

A **routine** is a prompt the definition owns, addressed by name. With a `cron`, the clock fires it; without one,
it runs only by name (`POST /run`, `fastagent routine run`).

```ts
interface Routine {
  prompt: string; // the turn's text = the routine's instruction (a builder is resolved at load)
  cron?: string; // 5-field cron expression — ABSENT means "by name only"
  tz?: string; // IANA timezone (default "UTC"); meaningless without `cron`
  secrets?: readonly string[]; // env vars this file needs, typed into the prompt builder
}
// what an author writes: `prompt` may be built FROM the declared secrets, keys typed from `secrets`
function defineRoutine<const S extends readonly string[]>(routine: {
  prompt: string | ((secrets: Record<S[number], string>) => string);
  cron?: string;
  tz?: string;
  secrets?: S;
}): Routine;
```

Each `routines/<name>.ts` default-exports `defineRoutine(...)`; the filename is the routine name (`.`, `..` and
path separators are refused).

```ts
// routines/daily-digest.ts        → routine "daily-digest", fired by the clock and callable by name
import { defineRoutine } from "@fastagent-sh/fastagent";

export default defineRoutine({
  cron: "0 9 * * *",
  tz: "America/New_York",
  secrets: ["SLACK_DIGEST_CHANNEL"], // same contract as a tool's — required at start and by deploy --run
  prompt: (secrets) => `Generate today's digest and send it with slack-send to channel ${secrets.SLACK_DIGEST_CHANNEL}.`,
});
```

```ts
// routines/reindex.ts             → routine "reindex", no clock: reached by name alone
export default defineRoutine({ prompt: "Re-read the docs and refresh your notes." });
```

**A routine keeps one continuing conversation**, `routine:<name>`: it remembers its previous runs and knows nothing
about users' chats. A **wake-up** (the `wake` tool) is work the agent schedules for itself at runtime, stored in
state and fired back into the conversation that made it; only the agent cancels one, with `unwake`.
`fastagent routine list` shows both.

**Put the delivery target in `secrets`.** A chat or channel id differs per environment: declare it and build the
prompt from it. The builder runs once at load, and `dev`/`start` refuse to boot while the name is unset.

On each cron instant the scheduler invokes the agent with `prompt` in `routine:<name>`. It:

- **delivers nothing** — the agent's tools send output; the scheduler logs the outcome, and failure details. What
  the turn said is in the session under `<stateRoot>/sessions/`.
- **fires each slot at most once** — a claim under `<stateRoot>/schedule/claims/<name>/` is created before the
  invoke, even with several schedulers over one state root.
- **catches up one overdue run** after downtime, not one per missed slot. A routine that has never fired starts
  at its next slot. A slot older than the newest claim is refused as a stale replay.

The scheduler runs while `dev`/`start` serves; `fastagent routine run <name>` runs one turn immediately.

### `GET /routines`

What this deployment will answer `POST /run` for:

```bash
curl -sS https://your-agent/routines
# [{"name":"daily-digest","cron":"0 9 * * *","tz":"America/New_York"},{"name":"reindex"}]
```

Names and schedules only, never prompts. A missing `cron` means the routine runs by name only. Served exactly
where `POST /run` is.

### `POST /run`

A serve that declares any routine also answers `POST /run`, which runs one declared routine by name:

```bash
curl -sS -X POST https://your-agent/run \
  -H 'content-type: application/json' -d '{"name":"daily-digest"}'
```

The body names the routine and nothing else; the prompt stays in `routines/<name>.ts`.

This route is an API, not a clock: it records no slot and no fire history.

| Clock | Owner | What a run gets |
|---|---|---|
| the resident loop (`dev` / `start`) | fastagent | slot claim, settlement, history |
| AgentCore | fastagent (`deploy` writes EventBridge rules) | slot claim, settlement, history |
| anything else (platform cron, CI, a script) | you | this API |

There is no idempotency key: retrying may re-run work whose side effects already landed, so retry only work
that tolerates running twice.

**Exposure**: unauthenticated, with the agent's full tool authority, like `POST /invoke`. `http.invoke: false`
withholds both; `http.run: true` keeps this one.

**Replies:**

| Reply | Meaning |
|---|---|
| `200 { name, session, ran: true, failed?, ms }` | The routine ran. `failed` means the turn did not finish; its side effects may have landed. |
| `200 { name, session, ran: false, reason, ms }` | The previous run of this routine is still going; try later. |
| `400` | Malformed body. |
| `404` | Unknown name; the reply lists the available ones. |

`session` is where the output is (`fastagent routine history <name>`, or `/control/sessions/<id>/events`).

**Keeping the clock elsewhere.** A scaled-to-zero deployment needs an external clock:
[Fly](https://fly.io/docs/blueprints/task-scheduling/) has Cron Manager, supercronic or scheduled Machines; Railway
has a cron service (5-minute floor) that can call this route over the private network, which also wakes a slept
service. On AgentCore `deploy` registers the rules, and `http.run` is inert; run a routine by name there with
`aws bedrock-agentcore invoke-agent-runtime` and `{"kind":"routine-run","name":"reindex"}`.

**Self-scheduling.** Every serve (`dev`/`start`, not one-shot `invoke`/`routine run`) mounts the built-in
**`wake`** and **`unwake`** tools:

- `wake({ in: "30m", prompt })` records a one-shot wake-up; `wake({ cron: "0 9 * * *", tz?, prompt })` a
  recurring one. Wake-ups persist under `<stateRoot>/schedule/` and fire back into the same session, with the
  prompt marked as the agent's own scheduled turn.
- Limits: a minimum delay, at least 10 minutes between recurring fires, and a per-session pending cap.
- `unwake({ id })` cancels one, from the session that made it. There is no operator command; as a last resort,
  edit `<stateRoot>/schedule/wakeups.json`.

## Config and models

```ts
function defineConfig(config: FastagentConfig): FastagentConfig;
function listModels(models: Models): string[];
function resolveModel(models: Models, spec: string): Model;
function createPiModels(options?: CreatePiModelsOptions): Models;
function probeAuthSource(models: Models, spec: string): Promise<string | undefined>;
function availableModelsFromDir(
  dir: string,
  options?: { authPath?: string; warn?: (message: string) => void },
): Promise<string[]>;
```

`availableModelsFromDir` is what a model picker offers for an agent directory: the specs
`createPiAgentFromDir(dir, { authPath })` could run now. It covers pi's built-ins plus the agent's `models.json`,
filtered to providers whose credentials are configured, and sorted. The directory needs no model set. It checks
configuration, not validity: no OAuth token is refreshed and no provider is called. An unreadable or corrupt
credentials file goes to `warn`, and otherwise reads as "nothing configured"; pass a `warn` that throws to surface
it instead.

Auth:

```ts
const GLOBAL_AUTH_PATH: string; // ~/.fastagent/.secrets/auth.json — the cross-project share target
function fastagentCredentialStore(authPath?: string, options?: FastagentAuthOptions): CredentialStore;
```

`fastagent login` writes `<agent dir>/.secrets/auth.json` by default. `createPiModels()` with no `authPath` reads
`GLOBAL_AUTH_PATH` instead; pass `authPath` to read a project's file (the `createPiAgentFrom*` openers do).

Credential writes set `auth.json` to `0600` and create its directory if needed, without setting the directory's
mode.

`Provider`, `ProviderAuth` and `Model` are re-exported as types. Build a provider with `createProvider` from
`@earendil-works/pi-ai`.

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

Session ids are the caller's and may contain any character (`-1001234567890`, `feishu:oc_x:omt_y`). The store
encodes them into file names (`-1001234567890` → `s-1001234567890`). A new record is written as soon as it is
created, so a crash before the first answer does not lose the question.

Both backends support `SessionInheritance`: a new session named with a `parentSession` starts from that session's
history.

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
const stream = control.sessions.get("s1").events();
const watching = (async () => {
  for await (const ev of stream) {
    console.log(ev.type); // run_started, message_delta, tool_started, …
    if (ev.type === "run_settled") break; // events() has no natural end — the consumer decides
  }
})();
// `ready` settles when the subscription EXISTS (it registers on the first pull, and remotely on the
// server before the response headers), so nothing after it can be missed. Reconnecting clients await
// it before reading history — see the reconnect recipe in docs/design/session-control.md §7. One
// `events()` call is one subscription: iterate the returned stream once, and call it again to
// resubscribe. Note the shape: the iteration runs BESIDE the work, never after it — a subscriber that
// stops pulling is buffered by the server only up to a ceiling, then closed.
await stream.ready;
for await (const e of agent.invoke({ session: "s1" }, { text: "hi" })) void e; // the data plane
await watching;

// What a `/` composer LISTS (read live, so a skill added while serving appears at once). A listing
// only — the data plane takes prompts as text, so what typing `/triage` means is the client's.
await control.commands(); // [{ name: "triage", description: "Sort an inbox", source: "skill" }]

// After a disconnect, missed history comes from the durable plane, not the live stream — and the ORDER
// is the contract (docs/design/session-control.md §7): resubscribe, await `ready`, THEN read, with the
// reads running BESIDE a live iteration. Reading in front of one loses whatever is emitted meanwhile;
// pausing the iteration to read buffers the subscriber server-side until its ceiling closes it.
const s1 = control.sessions.get("s1"); // a pure binding: an id + the transport, nothing to dispose
const resumed = s1.events();
const draining = (async () => {
  for await (const ev of resumed) console.log(ev.type);
})();
await resumed.ready;
const { entries, leafEntryId } = await s1.entries({ since: cursor }); // backfill, beside `draining`
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

With steering or follow-ups, the invoke stream ends when the run settles (all queued continuations done). Actions
on an idle session reject with `no_active_run`; an action that reached a run that was already settling rejects
with `run_command_failed`. Both are `retryable: false`; check `state()` first. An accepted action can still lose
the race: an `abort` may settle `completed`, and a `steer`/`followUp` may settle unconsumed. The settlement is what
happened.

`commands()` lists what a `/` composer completes: `{ name, description?, source }` for the definition's skills, the
commands its `extensions/` register, and the machine's skills and prompt templates. `source` is `skill`, `extension`
or `prompt`. It is a listing only. To run one, send its spelling as prompt text and the server dispatches it: a skill
is `/skill:<name> [args]`, an extension command or a prompt template is `/<name> [args]`. Do not expand names
client-side.

- An unknown name goes through as plain text, so check a name against this list if a typo should be visible. A
  skill whose file cannot be read is dropped from the list (the loader warns `read_failed`).
- If a file disappears after the list was read (a steer mid-run, a replaced definition), the prompt goes through
  unexpanded and the server logs `skill_expansion failed`.
- The list is complete for a served agent. Two extensions registering the same command name are listed as
  `<name>:1`, `<name>:2`, and a prompt template an extension command shadows is left out. Listing loads the
  extensions (their factories run) without opening a session. A chat channel's `/stop` is handled by the channel,
  not listed here.
- It is re-read on every call. `[]` means the agent exposes none. It rejects (with no stable code) when the
  definition cannot be read at all.

`sessions.list()` returns `{ session, name?, createdAt, updatedAt, messageCount, preview? }` for every session in
the deployment, keyed by the caller's id. Do not expose it through a multi-tenant facade. A store that cannot be
enumerated rejects with `sessions_unavailable` (remotely: 503, code on `ControlRequestError.code`).

`list()` reads every record on each call (about 20 ms for 100 sessions / 8 MB), so poll it at human intervals and
follow an open conversation with `events()`.

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

The writes themselves are separate journal entries, so a failure BETWEEN them (a full disk) answers
`partial_update` naming what landed, after an event reporting the record as it now is — the one
`ok: false` that carries durable work:

```ts
const r = await s1.update({ model: "anthropic/claude-opus-4-5", thinkingLevel: "high" });
if (!r.ok && r.error.code === "partial_update") {
  // `error.message` names the fields that landed; `state()` is what they now are. (The preceding
  // `state_changed` may carry less: a model/level pair that cannot be resolved is logged, not reported.)
  const now = await s1.state();
  // Re-send only what is still missing. Blind retry re-applies what landed — which for `name` or
  // `leafEntryId` means overwriting or moving back.
  if (now.thinkingLevel !== "high") await s1.update({ thinkingLevel: "high" });
}
```

Use `retryable` to decide whether to re-send, not `ok` alone. An unknown field rejects `unsupported_capability`,
naming it; a wrong value type rejects `invalid_command`.

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

`fork` copies history into the session `into`. It is idempotent: repeating the same fork answers `ok: true` and
writes nothing; `into` already holding a different history rejects `invalid_command`. Clone a session by forking
at its own `leafEntryId`. There is no `create`: `invoke` creates sessions. `delete` ends the session's live
`events()` streams.

Overrides persist in the session and apply to every later turn, channels included. A thinking level the current
model does not support is clamped to the lowest supported level at or above it (below only if none is above), which
can raise reasoning cost; the recorded preference returns when the session moves back to a capable model.
`state()`, `state_changed` and execution all report the same resolved level.

Writes require an existing session (`no_such_session` otherwise): sessions are created by `invoke` or
copied by `fork`, never minted by an update. Invalid payloads reject `invalid_command` before acceptance.
`capabilities()` lists `allowedModels` (the
deployment's registry — a static fact) but not thinking LEVELS: which exist depends on the model a
session is running, so they ride `state().availableThinkingLevels`, and `update({ thinkingLevel })`
validates against that same set rather than recording an override the run would ignore. Every write
requires the wiring the agent opener provides (`sessionControl: true`); a hub without it reports an
empty `updatable`, `fork: false`, `delete: false`, and rejects with `unsupported_capability`.

For agent assembly the store lives inside the opener, so ask the opener to wire the hub:

```ts
const { agent, sessionControl } = await createPiAgentFromDir(dir, { sessionControl: true });
```

A serve (`serving: true`, which `createAgentService` passes) always gets a hub, because chat channels abort a turn
through it. `sessionControl: true` adds the write side and, in a service, the `/control/*` routes.

### Remote (HTTP + SSE)

The same contract over the wire — for a Web panel, a desktop app, or any other remote client. Server
side, set `sessionControl: true` and dev/start mount the routes.

**fastagent authenticates nothing**, `/invoke` and `/control/*` included. Put a gateway, an authenticating proxy,
a private network, or your own middleware in front; without one, a public port is a public remote control.

```ts
import { createAgentService } from "@fastagent-sh/fastagent";
import { connectSessionControl } from "@fastagent-sh/fastagent/core";

// Set `sessionControl: true` in fastagent.config.ts; the plane is then mounted on the service's
// handler, owning the /control prefix. Routes, preflight, 404/405 and a failing handler all carry
// CORS headers, and the default answers EVERY origin — `http.cors` is the only way to narrow it.
// Every write must send content-type: application/json. SSE at /control/sessions/{id}/events.
const service = await createAgentService("./my-agent");

// Client side — the SAME SessionControl interface, isomorphic to local. Point `url` at whatever
// fronts the serve (a gateway, an ssh -L tunnel), not at a public port; `fetchFn` is where a
// gateway's credential goes, and it rides every request including the streams:
const remote = await connectSessionControl({
  url: "https://agent.example.com",
  fetchFn: (input, init) =>
    fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: await token() } }),
});
for await (const ev of remote.sessions.get("s1").events()) console.log(ev.type);
```

The DATA plane travels the same wire: `connectAgent({ url, fetchFn })` returns an `Agent` whose
`invoke` drives `POST /invoke` — paired with `connectSessionControl`, a client holds a full remote fastagent instance through the
same two contracts local code uses. Disconnecting the invoke stream cancels the run. Both streams refuse
an endpoint that accepts the connection and never answers — the events stream after 10s (a reconnecting
client waits on it), `invoke` after 60s, since a
scale-to-zero host holds the POST open while a machine boots; once connected, either stream fails after
90s without bytes, heartbeats included. The invoke wire is
text-only for now (images fail visibly there); `steer`/`followUp` carry full Prompts, images
included — within the action body cap (1 MiB, with base64 inflation counted; oversized bodies get a
413 naming the limit).

The wire is RESTful and mechanical, so a non-TypeScript client is a `curl` away:

```
GET    /control/capabilities                   what this deployment allows
GET    /control/commands                       the agent's skills
GET    /control/sessions                       list
PUT    /control/sessions/{id}                  {from, at} — fork (idempotent)
GET    /control/sessions/{id}                  state
PATCH  /control/sessions/{id}                  {name?, model?, thinkingLevel?, leafEntryId?}
DELETE /control/sessions/{id}
GET    /control/sessions/{id}/entries          ?since=
GET    /control/sessions/{id}/events           SSE
POST   /control/sessions/{id}/actions          {type: "steer"|"follow_up"|"abort"|"compact"}

POST   /invoke                                 the DATA plane: {session, text} — SSE, starts a run
GET    /routines                           what this agent will run by name
POST   /run                                {name} — run one of them
```

`{id}` is percent-encoded, so a Telegram group is `/control/sessions/telegram%3A-1001234567890` — session
ids are opaque Caller strings and may contain `:` and `/`.

The client consumes the transport envelope (`epoch`/`seq`): a sequence gap or a mid-stream failure, a server
restart included, throws from the events iterator; recover with the reconnect steps above.

## Subpath exports

```ts
import { type Agent, collect, readBodyCapped } from "@fastagent-sh/fastagent/core";
import type { SessionControl, SessionEvent } from "@fastagent-sh/fastagent/session";
import { createPiAgent, defineTool, z } from "@fastagent-sh/fastagent/pi";
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";
import { slackChannel, slackTransport } from "@fastagent-sh/fastagent/slack";
import { feishuChannel, feishuTransport, type FeishuTransport } from "@fastagent-sh/fastagent/feishu";
import { larkChannel, larkTransport, type LarkTransport } from "@fastagent-sh/fastagent/lark";
```

`/core` loads no third-party package, so a channel package can depend on it. The root entry exports everything. See
[Telegram channel](telegram.md), [Slack channel](slack.md), and the canonical [Feishu channel with Lark compatibility](feishu.md).
