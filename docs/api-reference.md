---
title: API reference
status: current
---

# API reference

This is a compact reference for the public TypeScript surface exported by `@kid7st/fastagent`.

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
  | { type: "failed"; details: string; retryable: boolean };
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

Returns Server-Sent Events with one JSON `AgentEvent` per `data:` line.

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
| `model` | Required `provider/modelId` spec. |
| `instructions` | String or function returning the system prompt. |
| `tools` | Agent tools. |
| `skills` | Loaded Agent Skills. |
| `sessions` | `PiSessionStore`. |
| `env` | Tool execution environment. |
| `lease` | Same-session concurrency lease. |
| `providers` | Extra model providers. |

### `createPiAgentFromDefinition`

```ts
function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }>;
```

Load `AGENTS.md` and `skills/` from a folder, assemble the pi prompt, and return an agent.

### `createPiAgentFromWorkspace`

```ts
function createPiAgentFromWorkspace(
  dir: string,
  options?: { model?: string; sessionsDir?: string },
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  modelSpec: string;
  sessionsDir: string;
  toolNames: string[];
  toolCollisions: ToolCollision[];
}>;
```

The same opener used by `fastagent dev`, `invoke`, and `start`: load config, resolve model/tools, pick session storage, and assemble the folder.

## Tool authoring

```ts
function defineTool<I extends z.ZodType>(options: DefineToolOptions<I>): AgentTool;
```

Use the re-exported `z`:

```ts
import { defineTool, z } from "@kid7st/fastagent";

export default defineTool({
  description: "Look up an order.",
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return await db.find(orderId);
  },
});
```

`tools/<name>.ts` files are discovered with `loadTools(dir)`, and the filename becomes the tool name.

## Channel authoring

```ts
type ChannelModule = (agent: Agent) => Routes;
function loadChannels(dir: string, agent: Agent): Promise<{ routes: Routes; collisions: ChannelCollision[] }>;
```

A workspace channel default-exports a `ChannelModule` from `channels/<name>.ts`.

Channel adapters can also use:

```ts
function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }>;
function text(body: string, status: number): Response;
const textHeaders: { readonly "content-type": "text/plain" };
```

See [Channel development](channel-development.md).

## Config and models

```ts
function defineConfig(config: FastagentConfig): FastagentConfig;
function listModels(models: Models): string[];
function resolveModel(models: Models, spec: string): Model;
function createPiModels(options?: CreatePiModelsOptions): Models;
function probeAuthSource(models: Models, spec: string): Promise<string | undefined>;
```

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

function inMemorySessionStore(): PiSessionStore;
function jsonlSessionStore(options: { dir: string; cwd?: string }): PiSessionStore;
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

## Subpath exports

```ts
import { githubChannel } from "@kid7st/fastagent/github";
import { telegramChannel } from "@kid7st/fastagent/telegram";
```

See [GitHub channel](github.md) and [Telegram channel](telegram.md).
