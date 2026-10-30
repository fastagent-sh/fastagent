---
title: API reference
description: "The public TypeScript surface of @fastagent-sh/fastagent: the Agent API, opening and serving an agent directory, what a host embedding agents needs, what an author writes, and the channel kit."
status: current
---

# API reference

A compact reference for `@fastagent-sh/fastagent`. The package has one entry per kind of user:

| Import | Holds |
|---|---|
| `@fastagent-sh/fastagent` | The Agent API's types and `AgentError`, `openAgent`, what a host embedding agents needs beside it (`createAgent`, `credentialFile`, `signIn`, `signInOptions`, `providerAuth`), and what an author writes: `defineAgent`, `defineChannel`, `defineSchedule`, `needs`, `sessionIdOf`, and a channel's helpers |
| `@fastagent-sh/fastagent/client` | `connectAgent`, the Agent API over HTTP, with `AgentError` and the types: for a program anywhere `fetch` runs (Node, Bun, Deno, Workers) |
| `@fastagent-sh/fastagent/telegram`, `/slack`, `/feishu`, `/lark` | Each first-party channel, and the transport and thread reader its tools use |

FastAgent is pre-1.0; the [Agent API](SPEC.md) is the stable design center.

## The Agent API

Every Caller (a channel, a schedule, `fastagent invoke`, an app that embeds the agent, a program that calls a served
one) uses one interface, in process or over HTTP. [Agent API](SPEC.md) is normative (v2); this is its
shape:

```ts
interface Agent {
  info(): Promise<AgentInfo>; // name, description, commands, the tools and models (with their context windows) a session may name
  usage(): Promise<Usage>; // what the instance has spent
  sessions: {
    create(options?: SessionSettings & { forkFrom?: { sessionId: string; entryId?: string } }): Promise<Session>;
    get(sessionId: string): Promise<Session>;
    list(options?: { limit?: number; after?: string }): Promise<Page<Session>>; // most recently active first
    update(sessionId: string, changes: SessionChanges): Promise<Session>; // model, thinkingLevel, instructions, tools
    entries(sessionId: string, options?: { after?: string; before?: string; limit?: number }): Promise<Page<Entry>>;
    events(sessionId: string, options?: { after?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent>;
    cancel(sessionId: string): Promise<{ stopped: string[] }>; // once the stop is recorded
    compact(sessionId: string, options?: { instructions?: string }): Promise<void>;
    attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }>;
  };
  messages: {
    send(request: SendRequest, options?: { wait?: number; signal?: AbortSignal }): Promise<Message>;
    stream(request: SendRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent>;
    get(key: MessageKey, options?: { wait?: number; signal?: AbortSignal }): Promise<Message>; // by id or by key
  };
}

interface SendRequest {
  sessionId: string;
  content: string | ContentPart[]; // a string is one text part; text and images
  idempotencyKey?: string; // a resend with the same key returns the same message
  whenBusy?: "queue" | "steer" | "reject"; // default "queue"
}
```

Every operation resolves with what it names or rejects with an `AgentError` (`code`, `message`, `retryable`,
`details`); `instanceof AgentError` tells one apart. A message is `queued` or `running` until it ends `completed`,
`incomplete` (cut off at its token limit), `failed` (its `error` says why) or `canceled`; `hasEnded(message)` says
whether it has. `wait` is in seconds: `send` and `get` answer once the message has ended, or with it as it is then. A
`signal` lets go of a wait or a stream, and the message goes on; only `sessions.cancel` stops it. `LIMITS` holds the
API's limits.

```ts
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "Summarize the inbox" }, { wait: 120 });
if (message.status === "completed") console.log(message.answer?.text);
```

`messages.stream` sends a message and delivers it as it is written: first a `message` event with it as recorded, then
its session's events from its own `user` entry through its `done` (`delta`, `tool_started`, `tool_progress`,
`retrying`, `entry`), only its own even when it queued behind another; a send whose key the session has seen delivers
that message from wherever it is. A refused send rejects the first read; a stream that cannot go on after that ends
with a `stream_error` event. It is what a channel's live preview reads.

## Opening and serving an agent directory

```ts
function openAgent(
  dir: string,
  options?: { model?: string; credentials?: CredentialStore; stateDir?: string },
): Promise<LocalAgent>;

interface LocalAgent extends Agent {
  serve(options?: { apiKeys?: string[] }): Promise<Service>; // channels, schedules, wake-ups, /health, and /v1 with a key
  readonly harness: Harness; // pi-durable's own API, for operating the agent
  close(): Promise<void>; // closes what `serve` started, then releases the instance's storage
}

interface Service {
  fetch(request: Request): Promise<Response>; // for an app's own server to route to
  listen(port: number, host?: string): Promise<number>; // or a server of its own; answers the port it bound
  ready: Promise<void>; // every long connection is up
  close(): Promise<void>;
}
```

`openAgent` opens a directory the way `dev` and `start` do: it generates `.fastagent/` from `src/`, builds the code with
the secrets it declares (a required one without a value refuses, naming where it is declared), prepares the declared
environment, clones the content, builds the model environment over the agent's credentials (`.secrets/auth.json` over
the machine's, or the store `credentials` gives) with its [model lists](configuration.md#model-lists) refreshed (a request to
`https://pi.dev` of at most 5 s, and to a provider that fetches its own list, unless what `<state root>/models/` keeps
is less than 4 hours old; `FASTAGENT_OFFLINE=1` makes none), and opens the instance's storage,
`<state root>/agent.sqlite`, which one process holds at a time: a second opener is refused. The state root is
`stateDir`, else `FASTAGENT_STATE_DIR`, else the agent's `.state/`. Everything it reads from an environment (the
secrets, the model keys, what its commands and its content's clones run with) is this process's plus the agent's own:
its `.secrets/.env`, where the process does not hold a variable, and its declared packages. Nothing is written into
`process.env`, so one process can open several agents. `model` is the default for a session that names
none; without one anywhere, a message is refused `missing_model` until its session is given one (`sessions.update`).
Nothing reaches the agent until `serve`, and its `wake` tool refuses a wake-up until then: only a serve's clock fires
one.

`serve()` is what `start` serves: the channels' routes and `GET /health` (503 until every long connection is ready), the
long connections, the schedules and the wake-up poll, and, when `apiKeys` holds a key, the Agent API over HTTP under
`/v1` ([Agent API](SPEC.md) §9; `dev` and `start` take the keys from `FASTAGENT_API_KEY`). Use `fetch`
from the app's own server, or `listen` for a server of the agent's own on Node's `http` server or `Bun.serve`; `host`
is the bind address, unset binds all interfaces. `close()` ends the API's event streams, stops the server, giving the
requests in flight 500 ms before it ends them, then the long connections and the schedules; the agent's messages are
durable and go on after a restart. An agent is served once; a `serve` that failed to start may be tried again.

## What a host embedding agents needs

A desktop app or a tool that runs agents for a person creates them, keeps the model credentials, and signs in to
providers in its own UI. None of it needs the harness's model library: the types are FastAgent's own.

```ts
function createAgent(dir: string): Promise<{ dir: string; created: string[]; repository: string }>;

type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [field: string]: unknown };

interface CredentialStore {
  read(provider: string): Promise<Credential | undefined>;
  list(): Promise<readonly { provider: string; type: "api_key" | "oauth" }[]>;
  modify(provider: string, change: (current?: Credential) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(provider: string): Promise<void>;
}
function credentialFile(path: string): CredentialStore;

function signInOptions(credentials: CredentialStore): Promise<SignInOption[]>;
function signIn(request: {
  credentials: CredentialStore;
  provider: string;
  method: "oauth" | "api_key";
  interaction: SignInInteraction; // { signal?, prompt(SignInPrompt): Promise<string>, notify(SignInEvent): void }
  deviceId?: string;
}): Promise<{ provider: string; method: "oauth" | "api_key"; verified: "ok" | "unknown" | "n/a" }>;
class SignInCancelled extends Error {}

function providerAuth(
  credentials: CredentialStore,
  provider: string,
): Promise<
  | { type: "oauth" | "api_key"; source?: string; apiKey?: string; headers?: Record<string, string>; baseUrl?: string }
  | undefined
>;
```

- `createAgent` is `fastagent init` without its options: the whole scaffold and a git repository whose first commit is
  it, or why not. It installs no dependencies; the agent opens without them. A directory that is not empty is refused.
- A `CredentialStore` keeps one credential per provider, whole. `modify` is its only write and runs one at a time per
  provider, because an OAuth refresh happens inside it and a rotated refresh token must never be used twice; a store it
  cannot read rejects, since answering it as empty would let the next write replace every provider's credential.
  `credentialFile(path)` is FastAgent's own, the locked JSON file `fastagent login` writes; a corrupt one rejects.
- `signInOptions` lists each way to sign in to each built-in provider, with what authenticates the provider now
  (`status`: a stored credential, else the environment), what in the environment would with nothing stored
  (`environment`), and whether the provider takes its key from the environment only (`external`).
- `signIn` runs one provider's sign-in through `interaction`: `prompt` asks (`text`, `secret`, `select`, or
  `manual_code`, the address the browser ended on) and rejects with `SignInCancelled` when the person backs out, and
  `notify` tells (`auth_url`, a page to open; `device_code`, a
  code to enter there; `info`, `progress`). A prompt's `signal` aborts when the answer is no longer needed, such as a
  browser callback that came first. An API key is checked with one request before it is stored, and asked for again
  when the provider rejects it. Aborting `interaction.signal` rejects with `SignInCancelled` and stores nothing. Sign in
  with ChatGPT needs a stable `deviceId`: `credentialFile` keeps one beside its file, a store of your own passes it.
- `providerAuth` resolves what a request to the provider sends (an OAuth token refreshed when due, through the store):
  its key, the headers a provider authenticates by, and the endpoint a credential decides. It is for a host that calls
  the provider itself, such as for its usage.

## Calling a served agent

```ts
function connectAgent(url: string, options: { apiKey: string }): Agent;
```

The same interface over HTTP, from `@fastagent-sh/fastagent/client`: an agent served with a key, by `start`, a
deployment or an app's `serve()`, is called the way an opened one is, from a backend (the key is a credential for the
whole instance, so a browser never holds it). A `wait` over 60 seconds is several requests of at most 60. A send or a
stream without an `idempotencyKey` gets one of its own, so one whose answer was lost rejects `unconfirmed` with that key
in `details`, whatever stopped its answer (no connection, a proxy's page, a body it cannot read), and `messages.get` by
key finds what became of it; so does a send whose wait failed once the message was recorded, with its `messageId`, as
in process. A read or another write that could not reach the agent or met a server's error rejects `unavailable`,
which is safe to send again: a `create` sent again may leave an empty session behind, a `compact` compacts again. An
event type, a status or an error code from a later server that this client does not know is skipped, kept as the status
it is (a message in one has not ended), or kept as the code it is, at whatever status it was answered with.

## What an author writes

```ts
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

## Channel authoring

```ts
interface ChannelContext {
  agent: Agent;
  sessionFor(key: string, options?: { forkFrom?: () => Promise<ForkSource> }): Promise<string>;
  recordedSession(key: string): string | undefined;
  turn(place: string, work: () => Promise<void>): void;
  stateDir: string; // `<state root>/channels/<the channel file's name>`, made at the mount
}
type ChannelModule = (ctx: ChannelContext) => Routes;
function defineChannel<T extends ChannelModule | LongConnectionChannelModule>(channel: T): T;
type Routes = Record<string, (req: Request) => Response | Promise<Response>>;
interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): { ready: Promise<void>; closed: Promise<void> };
}

function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response; // a text/plain response
function secretEquals(given: unknown, expected: string | undefined): boolean; // constant-time
```

A channel is a module of `src/channels/` that default-exports one of the two forms, or `needs([...])` around one.
Route keys are `"/path"` (any method) or `"METHOD /path"`; the path is a literal. A path that exists under another
method answers 405, an unknown one 404. **A channel MUST verify that a request comes from its platform**, with the
credential the platform issued: nothing else in front of it does ([security boundary](design/security-boundary.md)).
A channel is handed `{ agent, sessionFor, recordedSession, turn, stateDir }`: the conversation-to-session map, a
per-place queue that runs work after the route has answered, and a directory of its own. See
[Channel development](channel-development.md).

## Schedules

A schedule is a module of `src/schedules/` default-exporting `defineSchedule({ cron, tz?, prompt })`
([Configuration](configuration.md#schedules)). `fastagent schedules run <name>` fires one now, as its clock would.

### Self-scheduling

Every serve (`dev`, `start`, an app's `serve()`; not `fastagent invoke`) gives the agent the
**`wake`** and **`unwake`** tools:

- `wake({ in: "30m", prompt })` records a one-shot wake-up; `wake({ cron: "0 9 * * *", tz?, prompt })` a recurring
  one. Wake-ups persist in `<stateRoot>/schedule/wakeups.json` and fire back into the session that set them, with the
  prompt marked as the agent's own scheduled message.
- Limits: a minimum delay, at least 10 minutes between recurring fires, and at most 20 pending per session.
- `unwake({ id })` cancels one, from the session that set it. `fastagent schedules unwake <id>` cancels any, while
  no serve runs.

## Imports

```ts
import { AgentError, defineAgent, defineChannel, defineSchedule, needs, openAgent, sessionIdOf } from "@fastagent-sh/fastagent";
import { createAgent, credentialFile, providerAuth, signIn, signInOptions, SignInCancelled } from "@fastagent-sh/fastagent";
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
