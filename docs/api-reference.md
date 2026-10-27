---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent API, opening and serving a definition, what an author writes, the model environment, content, and the channel kit."
status: current
---

# API reference

A compact reference for the all-in-one `@fastagent-sh/fastagent` entry. The same exports are layered across subpaths
by what each costs to import:

| | Harness-neutral | Runtime-neutral | Holds |
|---|---|---|---|
| `/core` | yes | yes | The Agent API's types, `stream()`, the channel contract. Effect only, no Node built-in |
| `/node` | yes | no | Serving a definition's channels and schedules, the Node HTTP bridge, content and authoring |
| `/pi` | no | no | What an author writes, opening a definition as an Agent, the model environment and sign-in |

The channel subpaths (`/telegram`, `/slack`, `/feishu`, `/lark`) hold each first-party channel. FastAgent is pre-1.0;
the [Agent API](SPEC.md) is the stable design center.

## The Agent API

Every Caller (a channel, a schedule, `fastagent invoke`, an app that embeds the agent) uses one interface, in process.
The [SPEC](SPEC.md) is normative; this is its shape:

```ts
interface Agent {
  info(): AgentInfo; // name, description, the content types it takes, its commands
  invoke(request: InvokeRequest): Promise<InvokeResult>; // a receipt, then wait() for the end
  getMessage(sessionId: string, key: { messageId: string } | { idempotencyKey: string }): Promise<MessageStatus | undefined>;
  createSession(options?: { from?: { sessionId: string; entryId?: string }; model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel }): Promise<CreateSessionResult>;
  configure(sessionId: string, settings: SessionSettings): Promise<ConfigureResult>;
  read(sessionId: string, options?: { after?: string; before?: string; limit?: number }): Promise<ReadResult>;
  resume(sessionId: string, options?: { replayFrom?: ReplayFrom }): AsyncIterable<ResumeEvent>;
  abort(sessionId: string, options?: { signal?: AbortSignal }): Promise<AbortResult>;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
  listSessions(options?: { before?: string; limit?: number }): Promise<ListResult>;
}

interface InvokeRequest {
  sessionId?: string; // absent: a new session, named in the receipt
  content: ContentPart[]; // text and images
  idempotencyKey?: string; // a resend with the same key returns the same message
  whenBusy?: "queue" | "steer" | "reject"; // default "queue"
}
```

Failures are values: an operation answers `{ ok: false, error }`, and an `AgentError` carries `code`, `message` and
`retryable`. `getMessage` and `attachment`, which have no failure value, reject with an `AgentRejection` when the
storage cannot answer. `LIMITS` holds the API's limits.

```ts
const sent = await agent.invoke({ sessionId, content: [{ type: "text", text: "Summarize the inbox" }] });
if (!sent.ok) throw new Error("error" in sent ? sent.error.message : sent.unknown.reason);
const end = await sent.wait(); // { ok: true, message: DoneMessage } or { ok: false, unfinished }
if (end.ok && end.message.outcome.status === "completed") console.log(end.message.answer?.text);
```

### `stream`

```ts
function stream(agent: Agent, request: InvokeRequest & { sessionId: string }): Promise<StreamResult>;
type StreamResult = ({ ok: true } & Receipt & { events: AsyncIterable<SessionEvent> }) | { ok: false; error } | { ok: false; unknown };
```

Sends a message and reads its answer as it is written: the receipt, then the message's own events from its
`user_message` entry through its `done`, only its own even when it queued behind another. It is a Caller of the API
over any `Agent`, adding nothing to it; it is what a channel's live preview reads. Leaving the iteration detaches;
the message goes on.

## Serving a definition

```ts
// From `@fastagent-sh/fastagent/pi`.
function openServing(dir: string, options?: OpenServingOptions): Promise<OpenedServing>;

interface OpenServingOptions {
  model?: string; // "provider/modelId", over the config's
  thinkingLevel?: ThinkingLevel;
  locking?: "posix" | "leased-dotfile" | "memory"; // default "posix": the instance's agent.sqlite, one process at a time
  authPath?: string; // the credentials file (default: the agent's own, layered over the machine's)
  credentialStore?: CredentialStore; // or a store of your own (an OS keychain); not with authPath
}

interface OpenedServing {
  agent: DurableAgent; // the Agent API, plus `harness` (pi-durable's own API) and `close()`
  definition: AgentDefinition;
  code: BuiltDefinition; // tools, extensions, providers, channels, schedules
  models: ModelEnvironment;
  content: ResolvedContent[];
  agentDir: string;
  stateRoot: string;
  channels: Map<string, ChannelModule | LongConnectionChannelModule>;
  schedules: Schedule[];
}
```

`openServing` opens a directory the way `dev` and `start` do: it generates `.fastagent/` from `src/`, builds the code
with the secrets it declares (a required one without a value refuses, naming where it is declared), enters the
declared environment, clones the content, builds the model environment, opens the instance's storage, and opens the
Agent on it. `locking: "memory"` opens no storage of the instance's, as `fastagent invoke` does. The agent's storage is
held until `agent.close()`; if the Agent does not open, it is released before the failure is thrown.

The default model is optional here: without one the agent opens, and a message to a session with no model of its own
ends refused `missing_model` until the session is given one (`configure`).

```ts
// From `@fastagent-sh/fastagent/node`.
function mountAgentService(opened: MountableAgent, options?: MountAgentServiceOptions): Promise<AgentService>;

interface AgentService {
  handler: (req: Request) => Promise<Response>; // the channels' routes and GET /health
  agent: Agent;
  ready: Promise<void>; // every long connection is up
  close(): Promise<void>; // stops long connections and schedules; the agent's messages are durable and go on
  routes: Routes;
  agentDir: string;
  channels: { routes: string[]; longConnections: string[] };
  schedules: readonly Schedule[];
}
interface MountAgentServiceOptions {
  signal?: AbortSignal; // aborting it closes the service
  onChannelClosed?: (name: string, error?: unknown) => void;
  closeTimeoutMs?: number;
}
```

`mountAgentService(await openServing(dir))` is what `start` serves: the channels' routes, `GET /health` (503 until
every long connection is ready), the long connections, the schedules and the wake-up poll. Closing it does not close
the agent: call `agent.close()` after it.

```ts
// From `@fastagent-sh/fastagent/node`: the Node HTTP bridge.
function nodeListener(handler: ChannelHandler): (req: IncomingMessage, res: ServerResponse) => void;
function serveNode(handler: ChannelHandler, options: { port: number; host?: string }): {
  listening: Promise<number>;
  close(): Promise<void>;
  closeAllConnections(): void;
};
```

`host` is the bind address; unset binds all interfaces. Mount `nodeListener` before any body parser: a webhook's
signature is computed over the raw body ([Embedding](embedding.md)).

### The parts of `openServing`

```ts
// From `@fastagent-sh/fastagent/pi`.
function prepareDefinition(dir: string): Promise<AgentDefinition>; // generate .fastagent/, import config and code
function loadDefinition(dir: string): Promise<AgentDefinition>; // import them, without generating
function buildDefinition(definition: AgentDefinition, env?: NodeJS.ProcessEnv): BuiltDefinition;
function secretsManifest(definition: AgentDefinition): DeclaredSecret[];
function openAgent(definition: AgentDefinition, options: OpenAgentOptions): Promise<DurableAgent>;

interface OpenAgentOptions {
  storage: Storage; // pi-durable's: MemoryStorage, SQLite, or your own
  code: BuiltDefinition;
  credentials: CredentialStore;
  content?: ResolvedContent[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  settings?: HarnessSettings; // pi-durable's harness settings: compaction, retries
  stateRoot?: string; // given: the agent gets `wake` and `unwake`, kept there
}
```

An app that keeps its own storage or harness settings composes these itself.

## What an author writes

```ts
// From `@fastagent-sh/fastagent` (or `/pi`).
function defineAgent(config: AgentConfig): AgentConfig; // fastagent.config.ts
function defineSchedule(config: { cron: string; tz?: string; prompt: string | ((fire: { at: Date }) => string | Promise<string>) }): DefinedSchedule;
function needs<const S extends readonly SecretSpec[], T>(secrets: S, build: (values: SecretValues<S>) => T): Needs<T>;
type SecretSpec = string | { name: string; description?: string; optional?: boolean };
function sessionIdOf(api: ToolExecutionApi, context: Context): Promise<string | undefined>;
```

- `defineAgent`'s keys are in [Configuration](configuration.md#config-file).
- A tool or an extension is pi-durable's own `defineTool` / `defineExtension` (`@earendil-works/pi-durable`).
- `needs` wraps any module of `src/`, a provider or an extension: the agent declares the names, and the code gets
  exactly those values, typed; a required one is a string, an optional one may be absent
  ([secrets in code](configuration.md#secrets-in-code)).
- `sessionIdOf(api, context)`, inside a tool's `execute`, is the id of the session the tool runs in, as the Agent
  hands it out: what a channel's map records, and what `*Threads` takes (below).

## Models and sign-in

```ts
// From `@fastagent-sh/fastagent/pi`.
function modelEnvironment(agentDir: string | undefined, source?: { authPath?: string; credentialStore?: CredentialStore }, providers?: readonly Provider[]): ModelEnvironment;
interface ModelEnvironment {
  models: Models; // pi-ai's built-ins and the given providers, over the credentials
  credentials: CredentialStore;
  authStatus(provider: string, modelId?: string): Promise<{ source?: string; error?: string; path?: string; stored?: string; shadowed?: string }>;
}
function createPiModels(options?: { authPath?: string; credentialStore?: CredentialStore; providers?: Provider[] }): Models;
function fastagentCredentialStore(path?: string): CredentialStore; // a credentials file, locked as pi locks it
const GLOBAL_AUTH_PATH: string; // ~/.fastagent/.secrets/auth.json
function probeAuthSource(models: Models, spec: string): Promise<string | undefined>;

function login(request: LoginRequest): Promise<LoginResult>; // one provider's sign-in, persisted
function loginOptions(credentials: string | CredentialStore): Promise<LoginOption[]>; // what a picker offers
class LoginCancelled extends Error {}
```

`modelEnvironment` is the one model environment every reader builds: the credential layers (the agent's file, then
the machine's, per provider), pi-ai's models over them, and the definition's providers. `authStatus` answers what
authenticates a provider, resolved as a message would. `login` runs a provider's flow over pi-ai's `AuthInteraction`
(OAuth or an API key, which it checks with one request before storing) and writes it through the same store the
runtime reads. A GUI client passes its own `interaction` and `credentialStore`.

## Content

```ts
// From `@fastagent-sh/fastagent/node`.
function loadContent(agentDir: string): ContentDeclaration; // context.json and context.local.json, read and checked
function resolveContent(agentDir: string, declaration: ContentDeclaration): ResolvedContent[];
function contentAbsentHere(declaration: ContentDeclaration): BoundContent[]; // bound here, gone: left out
function cloneContent(
  entry: ResolvedContent & { kind: "github" },
): Promise<{ outcome: "cloned" | "updated" | "current" } | { outcome: "kept"; reason: string }>;
function readContentSource(source: string, cwd: string, options?: SourceOptions): Promise<ContentAddition>;

type ContentEntry = { github: string; ref?: string; readonly?: boolean; description?: string }; // in context.json
type ContentBinding = { path: string; readonly?: boolean; description?: string }; // in context.local.json
type ResolvedContent = {
  name: string;
  readonly: boolean;
  description?: string;
  location: string; // where the agent reaches it here, absolute
  notices: string[]; // a checkout off its ref, a clone not made yet
} & ({ kind: "local" } | { kind: "github"; repo: string; ref?: string; clone: boolean });
```

The one resolution every reader uses: the prompt, `info`, `fastagent content list` and `openServing`. `loadContent`
refuses a malformed file, naming it and the entry. `resolveContent` refuses a binding to a file, to a directory that
contains the agent directory or sits inside it, or, for a declared repository, to anything but the root of a checkout
of it ([Configuration](configuration.md#content)); it reads the disk and git, never the network, and writes nothing.
`cloneContent` makes a repository's clone at `content/<name>`, or brings it up to date in place by git's rules, which
never overwrite the agent's work (`kept`, with the `reason`). `readContentSource` reads a directory or
`github:owner/repo` the way `init --content` does.

```ts
// From `@fastagent-sh/fastagent/node`: what `fastagent init` and `fastagent content` run.
function createAgent(dir: string, options?: { content?: ContentAddition[]; install?: (dir: string) => Promise<void> }): Promise<CreatedAgent>;
function listContent(agentDir: string): Promise<{ content: ResolvedContent[]; absent: BoundContent[] }>;
function addContent(agentDir: string, addition: ContentAddition): Promise<ContentEdit>;
function removeContent(agentDir: string, name: string): Promise<ContentEdit>;
class ContentNameError extends Error {}
```

The commands are thin wrappers over these, so a client and the CLI apply the same rules. Nothing prints or exits:
every refusal is thrown with the message the CLI shows. `createAgent` checks every entry before it writes, removes the
scaffold again when writing the content fails, runs `install` (when given) before the first commit so the lockfile is
in it, and makes the agent a git repository; `repository` says so, or why not, as a sentence to show. `addContent` and
`removeContent` edit both files under one lock; a name that is taken or not the agent's is a `ContentNameError`.

## Channel authoring

```ts
// From `@fastagent-sh/fastagent/core`.
interface ChannelContext {
  agent: Agent;
  stateRoot: string; // the resolved state root, absolute
}
type ChannelModule = (ctx: ChannelContext) => Routes;
type Routes = Record<string, (req: Request) => Response | Promise<Response>>;
interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): { ready: Promise<void>; closed: Promise<void> };
}

function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response;
const textHeaders: { readonly "content-type": "text/plain" };

// From `@fastagent-sh/fastagent/node`.
function secretEquals(given: unknown, expected: string | undefined): boolean; // constant-time
```

A channel is a module of `src/channels/` that default-exports one of the two forms, or `needs([...])` around one.
Route keys are `"/path"` (any method) or `"METHOD /path"`; the path is a literal. A path that exists under another
method answers 405, an unknown one 404. **A channel MUST verify that a request comes from its platform**, with the
credential the platform issued: nothing else in front of it does ([security boundary](design/security-boundary.md)).
A channel that keeps state derives its home from `ctx.stateRoot` (`<stateRoot>/channels/<kind>`). See
[Channel development](channel-development.md).

## Schedules

A schedule is a module of `src/schedules/` default-exporting `defineSchedule({ cron, tz?, prompt })`
([Configuration](configuration.md#schedules)). `AgentService.schedules` lists what the service armed. To run a
schedule's prompt now, send it as a message.

### Self-scheduling

Every serve (`dev`, `start`, `mountAgentService` over a storage, not `fastagent invoke`) gives the agent the
**`wake`** and **`unwake`** tools:

- `wake({ in: "30m", prompt })` records a one-shot wake-up; `wake({ cron: "0 9 * * *", tz?, prompt })` a recurring
  one. Wake-ups persist in `<stateRoot>/schedule/wakeups.json` and fire back into the session that set them, with the
  prompt marked as the agent's own scheduled message.
- Limits: a minimum delay, at least 10 minutes between recurring fires, and at most 20 pending per session.
- `unwake({ id })` cancels one, from the session that set it.

## Subpath exports

```ts
import { type Agent, stream, AgentRejection } from "@fastagent-sh/fastagent/core";
import { mountAgentService, nodeListener, secretEquals } from "@fastagent-sh/fastagent/node";
import { defineAgent, defineSchedule, needs, openServing, sessionIdOf } from "@fastagent-sh/fastagent/pi";
import { telegramChannel, telegramTransport } from "@fastagent-sh/fastagent/telegram";
import { slackChannel, slackThreads, slackTransport } from "@fastagent-sh/fastagent/slack";
import { feishuChannel, feishuThreads, feishuTransport } from "@fastagent-sh/fastagent/feishu";
import { larkChannel, larkThreads, larkTransport } from "@fastagent-sh/fastagent/lark";
```

A send tool reaches its channel through these:

- `telegramTransport(botToken)`, `slackTransport(botToken)`, `feishuTransport({ appId, appSecret })` and
  `larkTransport(…)` send with the mounted channel's client for that bot or app, or with the credentials given when
  none is mounted.
- `slackThreads(sessionId)`, `feishuThreads(sessionId)` and `larkThreads(sessionId)` read the threads of the group a
  message was asked in: `list()` its recent threads, `read(threadId)` one of them. The tool passes
  `await sessionIdOf(api, context)`; the group is the message's, never an argument, and outside a group message served
  by this process it throws.

The scaffolded `src/tools/<kind>-send.ts` and `src/tools/<kind>-threads.ts` are the reference uses. See
[Telegram](telegram.md), [Slack](slack.md), and [Feishu with Lark compatibility](feishu.md).
