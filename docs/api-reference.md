---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent contract, the service assembly, the channel kit, typed tools, sessions, and providers."
status: current
---

# API reference

This is a compact reference for the all-in-one `@fastagent-sh/fastagent` entry. The same exports are
layered across subpaths by what each costs to import:

| | harness-neutral | runtime-neutral | pulls |
|---|---|---|---|
| `/core` | yes | yes | Effect only (the HTTP binding decodes with `effect/Schema`) |
| `/node` | yes | no | the Node HTTP bridge and a cron |
| `/pi` | no | no | the pi runtime |

FastAgent is pre-1.0. The Agent Handler contract is the stable design center; implementation-specific APIs may still tighten before 1.0.

## Contract

The Agent is the [Agent Handler protocol v1](SPEC-v1.md), which is normative; this is its shape.

```ts
interface Agent {
  invoke(request: InvokeRequest): AsyncIterable<InvokeEvent>;
  sessions: {
    create(options?: { sessionId?: string; fork?: ForkSource }): Promise<{ ok: true; sessionId: string } | { ok: false; error: AgentError }>;
    list(): Promise<SessionSummary[]>;
    get(sessionId: string): Session; // read, follow, attachment, abort, rewind, compact, update, delete, runs
  };
  info(): AgentInfo; // protocolVersion and capabilities
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}

interface InvokeRequest {
  sessionId?: string; // absent: the Agent creates a session and names it in the receipt
  prompt: { text: string; images?: { mimeType: string; data: string }[] };
  whenBusy?: "queue" | "steer" | "reject"; // default "queue"
  idempotencyKey?: string; // the Caller's key for this message: a resend returns the same run
  source?: RunSource; // in process only
}

type InvokeEvent =
  | { type: "accepted"; sessionId: string; run: RunStatus; joined: boolean; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | SessionEvent; // entry, message_delta, tool_started, tool_progress, retry_scheduled, state, serving_error
```

An invoke's stream starts with `accepted` or `rejected`, then follows the run: its durable `entry` events
(`user_message`, `assistant_message`, `tool_result`, …) and the live ones, and ends after the run's `run_ended` entry,
whose `outcome` is `completed`, `failed`, `canceled`, `interrupted`, `max_tokens` or `intercepted`. A Caller that
stops reading detaches; the run goes on, and `runs.cancel`, `abort` or `delete` stop it. Failures are values: an
operation answers `{ ok: false, error }`, and an `AgentError` carries `code`, `message` and `retryable`.

## `collect`

```ts
function collect(events: AsyncIterable<InvokeEvent>): Promise<{ sessionId: string; runId: string; text: string }>;

class AgentRejection extends Error { code: ErrorCode; retryable: boolean } // the invoke was refused: nothing ran
class RunNotCompleted extends Error { outcome: RunOutcome; sessionId: string; runId: string } // it ended otherwise
class RunUnfinished extends Error {} // the stream stopped before its run ended (the process or connection went away)
```

Returns the run's last `assistant_message` text when its outcome is `completed`, and throws one of the three
otherwise. An `intercepted` run (a command took the message, and no model was called) is a `RunNotCompleted`.

## HTTP/host helpers

```ts
function createAgentHandler(agent: Agent, options?: { control?: boolean }): (req: Request) => Promise<Response>;
function connectAgent(options: { url: string; fetchFn?: typeof fetch }): Promise<Agent>;
```

`createAgentHandler` serves the agent's API as one Fetch handler ([SPEC v1 §9](SPEC-v1.md#9-http-binding)): the
user plane always, the control plane (`PATCH`/`DELETE /control/sessions/{s}`) only with `control: true`. Request
bodies are JSON (`content-type: application/json`), decoded strictly: an unknown field is a 400. Event streams are
Server-Sent Events, one JSON event per `data:` line, with comment heartbeats (`: ping`) so a client can tell a quiet
run from a dead connection.

```
POST   /invoke                            {sessionId?, prompt, whenBusy?, idempotencyKey?} → SSE
POST   /sessions                          {sessionId?, fork?: {sessionId, entryId?, context?}}
GET    /sessions                          list
GET    /sessions/{s}                      ?after=&before=&limit= — state and a page of entries
GET    /sessions/{s}/follow               ?after= — SSE; Last-Event-ID resumes
GET    /sessions/{s}/attachments/{ref}
POST   /sessions/{s}/abort
POST   /sessions/{s}/rewind               {entryId}
POST   /sessions/{s}/compact              {instructions?}
GET    /sessions/{s}/runs                 ?idempotencyKey=
GET    /sessions/{s}/runs/{r}
GET    /sessions/{s}/runs/{r}/events      ?after= — SSE
POST   /sessions/{s}/runs/{r}/cancel
GET    /agent                             protocolVersion and capabilities
GET    /agent/models
GET    /agent/commands
PATCH  /control/sessions/{s}              {name?, model?, thinkingLevel?}
DELETE /control/sessions/{s}
```

`{s}` is percent-encoded: session ids are the Caller's and may contain `:` and `/`
(`/sessions/telegram%3A-1001234567890`).

`connectAgent` is the same `Agent` over that wire, for a web panel, a desktop app or another service. It imports
nothing beyond the protocol. `fetchFn` is where a gateway's credential goes; it rides every request, the streams
included. A connection lost before the receipt is settled by resending with the request's `idempotencyKey`, so set
one when a run must not happen twice.

**FastAgent authenticates nothing.** Put a gateway, an authenticating proxy, a private network or your own
middleware in front of either; without one, a public port is a public remote control.

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

The API's planes own prefixes (`/sessions`, `/agent`, `/control`) and are mounted beside the routes;
`createAgentService` wires them and refuses a channel route inside a served one.

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
| `instructions` | String or function returning the system prompt. The function is evaluated once per run, never during construction; a thrown error fails that run. |
| `tools` | `MountedTool[]`: `AgentTool` with optional native Pi execution context. Serving/chat forward progress updates and context; direct CLI calls are sessionless. |
| `skills` | Loaded Agent Skills. Pi lists them in the system prompt when `read` is active. |
| `sessions` | `PiSessionRecordStore`. |
| `cwd` | The working directory at L1 (default `process.cwd()`): where tools operate and what session records are keyed to. |
| `providers` | Extra model providers. |
| `authPath` / `credentialStore` | Where model credentials live: a credentials file, or your own `CredentialStore` ([Auth](#config-and-models)). One or neither, not both. |

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

Load the definition from `dir` (the agent dir) and let pi build the prompt: pi's default, or `SYSTEM.md` in its place, then `APPEND_SYSTEM.md`, its `AGENTS.md` as project context, skills and FastAgent's own sections ([Configuration](configuration.md#the-system-prompt)). `dir` is the working directory: the coding tools operate there and session records are keyed to it.

`content` (`ResolvedContent[]`, default none) is what the agent works on and knows: each entry is named in the prompt, and tools see it as `ctx.content`. Nothing an entry holds, its `AGENTS.md` and skills included, is added to the prompt. Build it with `resolveContent(dir, loadContent(dir))` ([Content](#content)); `createPiAgentFromDir` passes the directory's.

`base` replaces pi's default prompt, as `SYSTEM.md` does, and outranks it; a blank `base` is refused. A `tools` list without `read`, `bash`, `edit` and `write` needs `base` or a `SYSTEM.md`: pi's default claims those tools, so the call is refused without one.

`LoadedDefinition` carries `contextFiles` (the agent directory's `AGENTS.md`, `DefinitionFile[]`), `systemPrompt?` and `appendSystemPrompt?` (`DefinitionFile`: `{ path; content }`), `skills`, `prompts` (`DefinitionPrompt[]`), `diagnostics`, `collisions` (`SkillCollision[]`), `shadowed` (`DefinitionShadow[]`: a name the definition holds in two places) and `ignored` (paths deliberately not loaded). All are exported.

### `createAgentService`

```ts
function createAgentService(
  dir: string,
  options?: { model?: string; authPath?: string; credentialStore?: CredentialStore; sessionsDir?: string;
              signal?: AbortSignal;
              onChannelClosed?: (name: string, error?: unknown) => void },
): Promise<{
  handler: ChannelHandler;              // channels + the agent's API planes + health, composed
  agent: Agent;
  routes: Routes;                        // what is served, for a startup line
  agentDir: string;
  channels: { routes: string[]; longConnections: string[] };
  unverifiedRoutes: readonly string[];     // the route keys fastagent itself serves here
                                          // ("POST /invoke", "GET /health"), minus what a channel
                                          // took over or `http.api: false` withheld
  schedules: () => readonly Schedule[];   // schedules/*.md as armed now ({ name, cron, tz?, prompt }); follows edits
  ready: Promise<void>;             // settles when long connections are up; rejects if one cannot
  planes: { api: boolean; control: boolean }; // which of the agent's HTTP planes this handler serves
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
  options?: { model?: string; sessionsDir?: string; authPath?: string; credentialStore?: CredentialStore;
              serving?: boolean },
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  modelSpec?: string; // the default model; absent when none is set (see below)
  agentDir: string; // the agent directory: where it lives, and its working directory
  content: ResolvedContent[]; // what it works on and knows, resolved for this instance
  stateRoot: string;
  sessionsDir: string;
  auth: { path: string; fallback?: string }; // credentials file, then the user-global one when none was named
  toolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}>;
```

The same opener used by `fastagent dev`, `invoke`, and `start`: `dir` must be the agent directory itself (one holding `fastagent.config.ts`); load config, resolve its content, model and tools, pick session storage, and assemble the directory. Set `serving: true` only for a long-running host that also runs the scheduler; it mounts `wake`/`unwake`. `sessionsDir` and `authPath` are read like every path override: a leading `~` is the home directory and a relative path is relative to the process's working directory. `sessionsDir` defaults to `<state root>/sessions`, and the result reports the one in use as an absolute path.

### Content

```ts
// From `@fastagent-sh/fastagent/node`.
function loadContent(agentDir: string): ContentDeclaration; // context.json and context.local.json, read and checked
function resolveContent(agentDir: string, declaration: ContentDeclaration): ResolvedContent[];
function contentAbsentHere(declaration: ContentDeclaration): BoundContent[]; // bound here, gone: left out
function cloneContent(
  entry: ResolvedContent & { kind: "github" },
): Promise<{ outcome: "cloned" | "updated" | "current" } | { outcome: "kept"; reason: string }>;

type ContentEntry = { github: string; ref?: string; readonly?: boolean; description?: string }; // in context.json
type ContentBinding = { path: string; readonly?: boolean; description?: string }; // in context.local.json
type ContentDeclaration = { declared: DeclaredContent[]; bound: BoundContent[] };

type ResolvedContent = {
  name: string;                         // unique ignoring case, one path segment
  readonly: boolean;                    // the agent knows it and does not write it
  description?: string;                 // what the declaration tells the agent about it
  location: string;                     // where the agent reaches it here, absolute
  notices: string[];                    // what to tell the user: a checkout off its ref, a clone not made yet
} & (
  | { kind: "local" }                   // a directory only this machine has, bound in context.local.json
  | { kind: "github"; repo: string; ref?: string; clone: boolean } // clone: false when a checkout is bound here
);
```

The one resolution every reader uses: the prompt, `ctx.content`, `info` and `fastagent content list`.
`loadContent` refuses a file that is malformed, naming the file and the entry: an entry of `context.json` without
`github`, a binding without `path`, or one under a declared entry's name that says more than its `path`.
`resolveContent` refuses, naming the entry, a binding to a file, to a directory that contains the agent directory or
sits inside it, or, for a declared repository, to anything but the root of a checkout of it; and a link or a file at a
repository's `content/<name>` ([Configuration](configuration.md#content)). It reads the disk and git, never the
network, and writes nothing. A binding whose directory is gone is not refused: a repository resolves to its clone,
with a notice, and a directory only this machine has is left out, which `contentAbsentHere` lists. A repository with
no checkout bound here resolves to its clone at `content/<name>`, which `cloneContent` makes, or brings up to date in
place by git's rules, which never overwrite the agent's work: what git refuses, a fetch that fails, or a clone on
another branch than declared keeps it as it is (`kept`, with the `reason`). `createPiAgentFromDir` clones before it
resolves; a caller that resolves for `createPiAgentFromDefinition` calls `cloneContent` for each entry with
`clone: true`, then resolves again.

`readContentSource(source, cwd, options?)` (also `/node`) reads a directory or `github:owner/repo` the way
`init --content` and `fastagent content add` do. It returns the `ContentAddition` (`{ name, entry?, binding? }`):
`github:owner/repo` is an `entry` alone, the root of a checkout whose `origin` is on GitHub that repository's `entry`
with a `binding` to the checkout, and any other directory a `binding` alone. It also returns `notes` for the user.

```ts
// From `@fastagent-sh/fastagent/pi`: what `fastagent init` and `fastagent content` run.
function createAgent(
  dir: string,
  options?: { content?: ContentAddition[]; webAccess?: boolean; install?: (dir: string) => Promise<void> },
): Promise<{ dir: string; created: string[]; content: ResolvedContent[]; repository: string }>;
function listContent(agentDir: string): Promise<{ content: ResolvedContent[]; absent: BoundContent[] }>;
function addContent(agentDir: string, addition: ContentAddition): Promise<ContentEdit>;
function removeContent(agentDir: string, name: string): Promise<ContentEdit>;
type ContentEdit = { name: string; content: ResolvedContent[]; notes: string[] };
class ContentNameError extends Error {}
```

The commands are thin wrappers over these, so a client and the CLI apply the same rules. Nothing prints or exits:
every refusal is thrown with the message the CLI shows. `createAgent` checks every entry before it writes, and
removes the scaffold and both content files again when writing the content fails. The agent runs without
`npm install`. `webAccess` adds what `init` adds: `extensions/web-access.ts` and `@fastagent-sh/pi-web-access` in
`package.json`, whose web tools load only once it is installed (until then they are left out with a warning);
`install`, when given, runs after the scaffold so the lockfile is in the first commit, and a rejection from it removes
the scaffold and is thrown, like a failed content write. The agent is then a git repository whose first commit is the
scaffold, as with `init`; `repository` says so, or why not (already inside a repository that tracks it, git missing,
no commit identity), as a sentence to show.

`addContent` writes the addition's `entry` into `context.json` and its `binding` into `context.local.json`, under one
lock for both, so concurrent edits apply one after the other; its `notes` say when git would commit
`context.local.json`. `removeContent` matches the name ignoring case, drops the entry from both files, and leaves a
clone at `content/<name>` as it is, saying so in `notes`. Each returns the name it acted on with the content after the
edit. A name that cannot name an entry, is taken in either file (ignoring case, including by another entry
`createAgent` was given), or is not the agent's is a `ContentNameError`, which the CLI reports with exit code 2. The
content an edit would leave is resolved before anything is written: when another entry does not resolve (a file where
its directory was), the edit is refused with that entry's error, a plain `Error` naming it (`content "<name>": …`).
Removing that entry is always possible, and is how it is mended.

The default model (`model` option > `FASTAGENT_MODEL` > `model` in `fastagent.config.ts`) is optional, here and in
`createAgentService`. Without one the directory still opens: `sessions.list()`, `read()` and `update()` work, and a
session that records its model (pi writes it into every session it starts, and `update({ model })` sets it) runs on
that model. A run on a session with no model of its own ends `failed` with code `missing_model` (not retryable);
`update({ model })` gives the session one. A model the config names but the registry does not know is reported as a
warning, and runs on sessions without a model of their own fail with the resolution error. The CLI's `dev`, `start`, `invoke` and `chat` still
refuse to start without a default (`missing model`), since every new conversation they took would fail.

```ts
interface FastagentConfig {
  tools?: FastagentTool[];
}
```

Every directory-opening workflow (`dev`, `start`, `invoke`, `chat`, `tool`, and `info`) mounts the
complete coding set. Pi's codemode and tool-search extensions load by default; settings or a mounted
`codemode`/`deferred` tool activate `codemode` and `tool_search`. Pi's MCP extension is not loaded. Every serve adds `wake`/`unwake`. `createPiAgentFromDefinition` uses the complete
coding set unless `tools` replaces it; `createPiAgent` starts from the passed `tools`. Omitted coding built-ins
cannot be reactivated.

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

Modules below `tools/` are discovered by the assembly, at any depth: every tool a module exports is mounted, named
by `defineTool({ name })`. A module directly in `tools/` that exports one unnamed tool lends it its file's name;
any other unnamed tool refuses the start ([Configuration](configuration.md#tools)).

The Zod schema is also sent to the provider for **constrained sampling** (`strict: "prefer"`): on a model that
supports it, arguments are sampled against the schema. A schema that cannot be expressed strictly, or a provider
without strict mode, falls back silently to an ordinary function tool. Constructs that cannot be strict:
`z.record(...)`, a union of objects or arrays, `z.tuple(...)`, `z.looseObject(...)`. Anthropic's strict mode also
rejects numeric bounds, so on Anthropic a schema with `.min()`/`.max()` on a number, or any `z.number().int()` (Zod
emits safe-integer bounds for it), is sent non-strict.

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
typed from the list. `defineChannel` takes the same field, and `fastagent info` prints every
declared name and flags the ones with no value.

The second `execute` argument is a `ToolContext`:

```ts
interface ToolContext {
  cwd: string; // the agent directory
  content: readonly ResolvedContent[]; // what the agent works on and knows, each with its `location`
  signal?: AbortSignal;
  sessionManager?: ReadonlySessionManager;
  tools?: ToolActivation;
  /** Run another mounted tool through Pi's pipeline (see "Calling other tools"). */
  executeTool?: (
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal; onUpdate?: (partial: AgentToolResult) => void },
  ) => Promise<{ toolCall: AgentToolCall; result: AgentToolResult; isError: boolean }>;
  /** Report progress: a snapshot of the work so far, wrapped like a return value. */
  onUpdate?: (partial: unknown) => void;
  /** The values of this tool's own `secrets`, keyed by the names it declared. */
  secrets: Record<string, string>;
}

interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<PiSessionEntry[]>;
}
```

`cwd` is the agent's own directory. A tool that works on a project reads its location from `content`
(`ctx.content.find((c) => c.name === "app")?.location`), never from `cwd`.

During serving and `fastagent chat`, `sessionManager` is a read-only view of the current conversation; it is
undefined in a sessionless call such as `fastagent tool`, and so are `executeTool` and `onUpdate`. `getSessionId()`
returns the caller's session id.

`onUpdate` replaces the previous snapshot each time. Its last line is the call's status, so keep a status on one
line: the invoke stream carries it as `tool_progress`, and the Telegram, Feishu, and Slack `classic` previews show it
on the running tool's line. Slack's default `native` stream does not, because its tool traces are append-only.
Session-control observers receive the whole snapshot.

### Output budget

Everything a tool returns is spent from the model's context, on every turn that keeps the result in view. A
raw page of 30 search results from a typical REST API can cost ~45k tokens.

Return what the model needs, not what the API sent:

- **Project the fields.** A name, a URL and a description usually replace the whole object.
- **Truncate, and say so.** Cap long text (a `MAX_TEXT` ceiling) and return a `truncated: true` flag with it, so
  the model knows the text was cut rather than guessing.
- **Expose the paging knob** (`per_page`, `limit`) as an input, so the model can ask for less.

`fastagent tool <name> '<json>'` reports the size of what the model would receive:

```
[fastagent] result: 143910 chars ≈ 35978 tokens to the model
```

Tools are plain ES modules, so they can be imported and tested without fastagent: `node --test
test/my-tool.test.ts` on Node 22+ needs no framework and no test script.

### Native exposure, discovery, and codemode

`defineTool` accepts Pi's `exposure`: `direct` (default), `model-only`, `codemode`, `deferred`, or `hidden`.
`defaultActive: false` keeps a direct tool inactive until an authored loader activates it (`ToolContext.tools`).
Deferred tools are loaded by Pi's `tool_search`; `codemode` tools are called from codemode scripts. Neither schema
enters the model's request up front.

Pi's codemode and tool-search extensions load by default, with their own defaults: codemode mode is `on`, while
`codemode` and `tool_search` start inactive. Mounting a tool activates the one its exposure needs, the rule Pi's MCP
extension applies to its own tools: `codemode` for `exposure: "codemode"`, `tool_search` for `exposure: "deferred"`.
Pi settings (`"defaultTools": ["+codemode"]`) activate either explicitly; `"extensions": ["-builtin:codemode"]`
turns one off. A `deferred` or `codemode` tool then has no way in: the assembly warns once per such tool, `info` and
the startup report list it as `unreachable`, and the base prompt stops pointing the model at `tool_search`.

Pi's MCP extension is not loaded, so `mcp.json` has no effect on an agent. Its connections live as long as a
session, and a served session lives one turn, so every turn would start every configured server.

An existing conversation runs on the definition's current default tools plus whatever its transcript still declares
and is still mounted (its discoveries), so a tool added to `tools/`, or restored after a release that lacked it,
reaches old channel chats after a restart. Narrowing a
tool's exposure (to `deferred`, `codemode`, or `defaultActive: false`) applies to new conversations only: the
transcript cannot tell a tool declared by default from one discovered, so a conversation that declared it keeps
its full schema.

- `output: z.object(...)` declares and validates structured output for scripts. Without it, scripts receive text.
  A full Pi `{ content, details, structuredContent?, isError? }` result passes through unchanged; its author owns
  schema conformance and model-facing size. Codemode scripts receive full internal data, not truncated display text.
- Nested calls retain native validation, permission hooks, and cancellation. Session observation includes
  `parentToolCallId`; the channel stream shows the outer call and Pi's bounded nested trace, without duplicating
  each child or publishing `structuredContent`. Each nested call starting is the outer call's `tool_progress`
  status (`weather London`).
- Pi's transcript restores the loadout across rebind, resume, fork, and compaction. The definition's current default
  tools always join; tools no longer mounted are dropped.
- `ToolContext.tools` remains an additive adapter for authored loaders. Pi ignores unknown or unreachable names;
  `activate(names)` returns only names actually added.
- `namespace: { name, description? }` groups related tools; codemode lists a namespace's tools under one heading
  with its description.
- `annotations` carries MCP-style hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Pi does
  not enforce them. A permission extension in `extensions/` reads them from `pi.getAllTools()` to decide which calls
  to confirm, and treats a tool without them as possibly destructive. Pi's documented example confirms with
  `ctx.ui.confirm`, which resolves as cancelled when serving, so there it blocks every call it would have asked about.

#### Calling other tools

`ctx.executeTool(name, args)` runs another mounted tool the way codemode scripts do: Pi validates the arguments, runs
the definition's `tool_call`/`tool_result` hooks, and passes this call's abort signal on. The active `direct` tools and
every `codemode` or `deferred` tool are callable. It resolves to `{ result, isError }` and does not reject for a tool
failure: an unknown name, invalid arguments, or a blocked call comes back as `isError: true`.

```ts
export default defineTool({
  description: "Forecast the next three days.",
  input: z.object({ city: z.string() }),
  async execute({ city }, ctx) {
    ctx.onUpdate?.(`looking up ${city}`);
    const days = await Promise.all([1, 2, 3].map((day) => ctx.executeTool?.("weather", { city, day })));
    return days.map((call) => (call?.isError ? null : call?.result.structuredContent));
  },
});
```

The nested calls are not transcript entries. Session observation reports them with `parentToolCallId`, and Pi keeps a
bounded record of them on the calling tool's result.

### Virtual models

Extensions can declare `pi.registerVirtualModel(...)` while loading. Registration precedes startup model
resolution, so the virtual spec works in config, model listings, chat, and session-control model selection. Each
bound session owns its runtime and router context; router state lives on its durable branch. `state().model` is
the selection, while assistant entries name the physical model that answered, and usage uses its context limit.
Authentication of that physical model occurs after routing. Catalog registration also runs extension factories
without a session; start background work in lifecycle handlers. Models registered only in `session_start` or a
command are not part of the startup catalog.

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
and `larkWebSocketChannel(opts)` return `LongConnectionChannelModule`. `feishuIngress()` / `larkIngress()` say which
of the two this process serves (`FEISHU_INGRESS` / `LARK_INGRESS`, else WebSocket under `dev` and webhook
otherwise); the scaffolded channel file picks its factory with them. In both forms the channel file
is one expression; a channel persisting durable state derives its home from
`ctx.stateRoot` (`<stateRoot>/channels/<kind>`), never `process.cwd()`. Enabled files end in `.ts`,
`.js`, or `.mjs`; rename one to `<name>.ts.disabled` to disable it.

A serve refuses to start if an enabled file under `tools/` or `channels/` cannot load, and names every file that
failed. A file under `schedules/` that is not a valid schedule is logged and left unarmed instead, since the agent
writes those too ([Schedules](configuration.md#schedules)). An absent directory is valid. `fastagent info` and `fastagent tool` load what they can and
report the rest.

Channel adapters can also use:

```ts
function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response;
const textHeaders: { readonly "content-type": "text/plain" };
```

See [Channel development](channel-development.md).

## Schedules

A schedule is `schedules/<name>.md`: a cron in the frontmatter over a prompt ([Configuration](configuration.md#schedules)).
It has no API of its own: `AgentService.schedules()` lists what the clock has armed now (it follows edits to
`schedules/`), and work a caller starts itself is `POST /invoke`.

### Self-scheduling

Every serve (`dev`/`start`, not a one-shot `invoke`) mounts the built-in **`wake`** and **`unwake`** tools:

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
  options?: { authPath?: string; credentialStore?: CredentialStore; warn?: (message: string) => void },
): Promise<ModelDescriptor[]>; // { spec, name?, thinkingLevels, contextWindow? }
function refreshModelCatalog(
  dir: string,
  options?: { authPath?: string; credentialStore?: CredentialStore; warn?: (message: string) => void; signal?: AbortSignal },
): Promise<void>;
function refreshMachineModelCatalog(
  options?: { authPath?: string; credentialStore?: CredentialStore; warn?: (message: string) => void; signal?: AbortSignal },
): Promise<void>;
```

`probeAuthSource` names what satisfies `spec`'s provider in `models`, or `undefined` when nothing is configured; it
rejects when resolving fails (a corrupt entry, a refresh the provider refused), with the reason.

`availableModelsFromDir` is what a model picker offers for an agent directory: the models
`createPiAgentFromDir(dir, { authPath })` could run now, sorted by spec. Each one carries its `spec`, its `name`, the
`thinkingLevels` a session on it accepts, and its `contextWindow`; `name` and `contextWindow` are absent when the
model does not declare them. It covers pi's built-ins, the model catalogs (the agent's `models-store.json` over
`~/.fastagent/models-store.json`), the agent's `models.json`, and the models its `extensions/` declare, filtered to
providers whose credentials are configured. The directory needs no model set. It checks
configuration, not validity: no OAuth token is refreshed and no provider is called. An unreadable or corrupt
credentials file goes to `warn`, and otherwise reads as "nothing configured"; pass a `warn` that throws to surface
it instead.

A Sign in with ChatGPT on `openai` lists only the models the account's own catalog shows (OpenAI's `GET /v1/models`,
`visibility: "list"`), not pi's built-in `openai/` list, most of which such an account cannot run. The catalog is read
at login and on every token refresh and kept on the credential, so another account brings its own list. A sign-in
that carries no catalog (made before this, or whose catalog read failed) lists no `openai/` model and logs why; it is
not sent to `warn`, which stays about the credentials file. `fastagent login` reads the catalog again. An API key on `openai` keeps the built-in list.

`refreshModelCatalog` fetches the model catalog from pi.dev into the agent's `models-store.json`, with the
credentials `createPiAgentFromDir(dir, { authPath })` would use: pi asks only for the providers they authenticate, and
may refresh an expired OAuth token to do so. Afterwards a model released after the installed pi is listed by
`availableModelsFromDir`, and an agent already open lists, accepts (`update({ model })`) and runs it without being
opened again. The file is part of the definition: commit it, and it ships with a deploy.
Nothing refreshes it on its own, so serving makes no catalog request. It rejects, naming each provider that failed,
when the refresh fails,
takes longer than 15 seconds, or `PI_OFFLINE` is set, and when none of the credentials authenticates a provider (the
refresh would fetch nothing).

`refreshMachineModelCatalog` is the same refresh into the machine's `~/.fastagent/models-store.json`, which every
agent on the machine reads under its own: one call serves a client that hosts several agents, and no file is written
into any agent. It authenticates with `credentialStore` or `authPath` when given, and the global credentials file
otherwise; environment keys apply either way. It rejects for the same reasons. The machine's catalog does not ship
with a deploy, so a deployed agent knows only the models its own `models-store.json` lists.

Auth:

```ts
const GLOBAL_AUTH_PATH: string; // ~/.fastagent/.secrets/auth.json — the cross-project share target
function fastagentCredentialStore(authPath?: string, options?: FastagentAuthOptions): CredentialStore;
```

Every option bag that takes `authPath` (`createPiAgent`, `createPiAgentFromDefinition`, `createPiAgentFromDir`,
`createAgentService`, `availableModelsFromDir`, `createPiModels`, `login`) also takes a `credentialStore`: pi-ai's
`CredentialStore` (`read`, `list`, `modify`, `delete`), for a client that keeps credentials in an OS keychain or behind
Electron `safeStorage` instead of a JSON file. `loginOptions` takes either one as its argument: a file path or a
store. Passing both is an error. An `authPath` reads like `FASTAGENT_AUTH_PATH`: `~` is the home directory and a
relative path resolves against the current directory.

A supplied store replaces the credentials files: no file is read or written, no global layer applies, and OAuth
refresh write-backs land in the store. Environment variables and `models.json` keys still apply, as they do with
`authPath`, and a stored credential outranks them. So a store emptied to sign out does not stop a turn that a
provider's env variable (e.g. `ANTHROPIC_API_KEY`) authenticates. `createPiAgentFromDir` returns no `auth` when a
store is supplied (no file is in use). Your store must guarantee what the file store does:

- `modify` for one provider runs one call at a time, across everything that shares the store. An OAuth refresh
  happens inside it, and a rotated refresh token used twice logs the grant out.
- A store it cannot read or parse is an error, not an empty store: the next `modify` would otherwise replace every
  provider's credential.

Sign-in, for a client that is not a terminal:

```ts
interface LoginOption {
  provider: string; // "anthropic"
  method: "oauth" | "api_key";
  label: string; // the method's own name: "Anthropic (Claude Pro/Max)", "Anthropic API key"
  subscription: boolean; // an OAuth login backed by a provider subscription
  stored?: "oauth" | "api_key"; // what the file holds for this provider now
}
function loginOptions(credentials: string | CredentialStore): Promise<LoginOption[]>; // a file path, or your store
function login(request: {
  provider: string;
  method: "oauth" | "api_key";
  authPath: string; // or credentialStore: CredentialStore, exactly one
  interaction: AuthInteraction; // pi-ai's: prompt(AuthPrompt) and notify(AuthEvent)
}): Promise<{ provider: string; method: "oauth" | "api_key"; verified: "ok" | "unknown" | "n/a" }>;
class LoginCancelled extends Error {}
```

`loginOptions` lists every interactive sign-in of pi's built-in providers, with `stored` naming what the store holds
for that provider now. A store keeps one credential per provider, so signing in with the other method
replaces it. `login` checks the store first (a no-op `modify`), runs the provider's flow over your `AuthInteraction`, and writes the
credential. Prompts arrive with pi-ai's own types (`text`, `secret`, `select`, `manual_code`) and events (`auth_url`,
`device_code`, `progress`, `info`), so open URLs yourself and race `manual_code` against the provider's callback.
Every prompt carries a `signal` that aborts when the provider withdraws it, when `interaction.signal` aborts, or
when the flow ends. An entered API key is verified with one minimal request to pi's default model for the provider,
at pi's built-in endpoint, before it is written (credentials are per provider, so any of its models tells whether
the key is refused). A key the
provider rejects (HTTP 401) is never stored, and the provider's key flow runs again with the same provider and
method (a flow that asks more than the key asks it again too). Aborting `interaction.signal` at any point, the
verification included, rejects with `LoginCancelled` and writes no credential. An OAuth flow that needs an
installation ID (Sign in with ChatGPT) gets one from `getDeviceId`; with `authPath` it defaults to a `settings.json`
beside that file, created before the flow runs and kept. Over your own `credentialStore` there is no default: pass
`getDeviceId` with a stable UUID of your own. `fastagent login` runs the same `login`.

For a custom endpoint (`models.json`), store its key with `fastagentCredentialStore(authPath).modify()` instead:
`login` covers built-in providers at their own endpoints. That includes a built-in provider an agent's `models.json`
points at a gateway: `login` would check the gateway's key at the provider's endpoint and refuse it. `fastagent
login`, run inside the agent, checks it at the gateway; `fastagent login -g` does not, since the global file serves
every agent on the machine.

`fastagent login` writes `<agent dir>/.secrets/auth.json` by default. `createPiModels()` with no `authPath` reads
`GLOBAL_AUTH_PATH` instead; pass `authPath` to read a project's file (the `createPiAgentFrom*` openers do).

Credential writes set `auth.json` to `0600` and create its directory if needed, without setting the directory's
mode.

`Provider`, `ProviderAuth` and `Model` are re-exported as types. Build a provider with `createProvider` from
`@earendil-works/pi-ai`.

## Sessions

```ts
interface PiSessionRecordStore {
  openOrCreate(sessionId: string): Promise<SessionManager>;
  /** Read-only sibling: unknown session → undefined, never created. */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
}

function piInMemorySessionRecordStore(options?: { cwd?: string }): PiSessionRecordStore;
function piSessionRecordStore(options: { dir: string; cwd?: string }): PiSessionRecordStore;
```

`piSessionRecordStore`'s `dir` is resolved against `cwd` (which itself defaults to `process.cwd()`), so
a relative path means "inside the agent directory this store serves". `cwd` also scopes lookups: two stores
sharing one `dir` but serving different agents never open each other's sessions.

Session ids are the caller's and may contain any character (`-1001234567890`, `feishu:oc_x:omt_y`). The store
encodes them into file names (`-1001234567890` → `s-1001234567890`). A new record is written as soon as it is
created, so a crash before the first answer does not lose the question.

One process holds each session's one writer while the session is busy: a second message queues behind the running
run (or steers it, or is rejected, as its `whenBusy` says). Running two processes over one session directory is not
supported.

## Working with sessions

Every session operation is on the `Agent` ([SPEC v1 §5](SPEC-v1.md)), in process or over `connectAgent`:

```ts
const s1 = agent.sessions.get("s1");

// Read: the state and a page of entries, newest page first; `limit: 0` reads the state alone.
const page = await s1.read({ limit: 50 });
if (page.ok) console.log(page.state.status, page.entries.length, page.prev);

// Follow: the entries after a cursor, then live events. A reconnect passes the last entry id it saw.
for await (const event of s1.follow({ after: lastEntryId })) {
  if (event.type === "rejected") break; // an unknown session or cursor
  console.log(event.type);
}

await s1.abort(); // stops the running run and drops the queued ones
await s1.rewind(entryId); // the next run continues from that entry; the old branch stays in the history
await s1.compact({ instructions: "keep the decisions" });
await s1.update({ name: "Deploy notes", model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" });
await s1.delete();

// A new session from another's history, up to an entry (or all of it). `context: "recent"` gives the model only the
// copy's recent part: what a chat thread gets from its room.
await agent.sessions.create({ sessionId: "s1-b", fork: { sessionId: "s1", entryId } });
```

`commands()` lists what a `/` composer completes: `{ name, description?, source }` for the definition's skills, the
commands its `extensions/` register, and the machine's skills and prompt templates. `source` is `skill`, `extension`
or `prompt`. It is a listing only. To run one, send its spelling as prompt text and the server dispatches it: a skill
is `/skill:<name> [args]`, an extension command or a prompt template is `/<name> [args]`. Do not expand names
client-side.

- An unknown name goes through as plain text, so check a name against this list if a typo should be visible. A
  skill whose file cannot be read is dropped from the list, and the server logs `<path>: <error>`, for example
  `…/SKILL.md: EACCES: permission denied, open '…/SKILL.md'`.
- If a file disappears after the list was read (a steer mid-run, a replaced definition), the prompt goes through
  unexpanded and the server logs `skill_expansion failed`.
- The list is complete for a served agent. Two extensions registering the same command name are listed as
  `<name>:1`, `<name>:2`, and a prompt template an extension command shadows is left out. Listing loads the
  extensions (their factories run) without opening a session. A chat channel's `/stop` is handled by the channel,
  not listed here.
- It is re-read on every call. `[]` means the agent exposes none.

`sessions.list()` returns every session in the deployment, keyed by the caller's id. Do not expose it through a
multi-tenant facade. It reads every record on each call (about 20 ms for 100 sessions / 8 MB), so poll it at human
intervals and follow an open conversation with `follow()`.

Settings persist in the session and apply to every later run, channels included. A thinking level the current
model does not support is clamped to the lowest supported level at or above it (below only if none is above), which
can raise reasoning cost; the recorded preference returns when the session moves back to a capable model. `models()`
lists the registry as a run would resolve it now, each with the `thinkingLevels` a session on it accepts.

## Subpath exports

```ts
import { type Agent, collect, connectAgent, createAgentHandler, readBodyCapped } from "@fastagent-sh/fastagent/core";
import { createPiAgent, defineTool, z } from "@fastagent-sh/fastagent/pi";
import { telegramChannel, telegramTransport } from "@fastagent-sh/fastagent/telegram";
import { slackChannel, slackThreads, slackTransport } from "@fastagent-sh/fastagent/slack";
import { feishuChannel, feishuThreads, feishuTransport, type FeishuTransport } from "@fastagent-sh/fastagent/feishu";
import { larkChannel, larkThreads, larkTransport, type LarkTransport } from "@fastagent-sh/fastagent/lark";
```

A tool reaches its channel through these. `*Transport(ctx.cwd)` sends with the mounted channel's client (or the
environment's credentials when none is mounted). `*Threads(ctx)` reads the threads of the group a turn was asked in:
`list()` its recent threads, `read(threadId)` one of them. The group is the turn's, never an argument, and outside a
group turn served by this process it throws. The scaffolded `tools/<kind>-send.ts` and `tools/<kind>-threads.ts` are
the reference uses.

`/core` loads no package beyond Effect and no Node built-in, so a channel package or a browser client can depend on
it. The root entry exports everything. See
[Telegram channel](telegram.md), [Slack channel](slack.md), and the canonical [Feishu channel with Lark compatibility](feishu.md).
