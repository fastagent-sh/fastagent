# @kid7st/fastagent

The FastAgent npm package: CLI + library API for serving or embedding local agent folders.

FastAgent takes a folder out of the terminal and turns optional `AGENTS.md`, `skills/`, and `tools/` into a running agent service with one method:

```ts
agent.invoke(scope, prompt) => AsyncIterable<AgentEvent>
```

The current reference implementation uses the pi engine, but the Agent Handler contract is engine-neutral.

## Requirements

- Node >= 22.19
- ESM workspaces for code tools (`"type": "module"`)
- Model credentials via `fastagent login` or provider API keys in the environment

The package ships compiled JavaScript and `.d.ts` files. Consumers do not need a build step for FastAgent itself.

## CLI

```bash
fastagent init my-agent
cd my-agent
fastagent info
fastagent dev
fastagent invoke "hello"
fastagent start
```

Common commands:

| Command | Purpose |
|---|---|
| `fastagent init [dir]` | Scaffold a runnable workspace |
| `fastagent info [dir]` | Inspect what the workspace assembles into |
| `fastagent dev [dir]` | Serve locally with watch/reload |
| `fastagent chat [dir]` | Open the same assembled agent in pi's interactive TUI |
| `fastagent invoke <message> [dir]` | Run one turn and exit |
| `fastagent tool <name> <json> [dir]` | Run one discovered tool without a model |
| `fastagent add github|telegram [dir]` | Scaffold a first-party channel |
| `fastagent add skill <source> [dir]` | Vendor an Agent Skills skill into `skills/` |
| `fastagent login [provider]` | Store provider credentials in the project-level `<cwd>/.fastagent/auth.json` (override: `--auth-path` / `FASTAGENT_AUTH_PATH`) |
| `fastagent start [dir]` | Serve without watch; use `--sessions-dir` or `FASTAGENT_SESSIONS_DIR` for durable sessions |

## Library API

### Folder -> agent

```ts
import { createInvokeHandler, createPiAgentFromDefinition } from "@kid7st/fastagent";

const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

export const POST = createInvokeHandler(agent);
```

### Typed parts -> agent

```ts
import { createPiAgent, defineTool, z } from "@kid7st/fastagent";

const lookupOrder = defineTool({
  name: "lookup-order",
  description: "Look up an order by id.",
  input: z.object({ orderId: z.string() }),
  async execute({ orderId }) {
    return await db.find(orderId);
  },
});

const agent = createPiAgent({
  model: "openai-codex/gpt-5.5",
  instructions: "You are a support assistant.",
  tools: [lookupOrder],
});
```

### Consume events

```ts
import { collect } from "@kid7st/fastagent";

for await (const event of agent.invoke({ session: "u1" }, { text: "hi" })) {
  if (event.type === "text") process.stdout.write(event.delta);
}

const result = await collect(agent.invoke({ session: "u1" }, { text: "summarize this" }));
```

## Public surface

The root export intentionally contains the supported surface only.

| Area | Examples | Stability |
|---|---|---|
| Contract | `Agent`, `AgentEvent`, `collect` | Stable within SPEC v0.1 |
| Channels/host | `createInvokeHandler`, `nodeListener`, `serveNode`, `router`, `Routes` | Reference implementation, pre-1.0 |
| pi assembly | `createPiAgentFromWorkspace`, `createPiAgentFromDefinition`, `createPiAgent` | Usable now, may tighten before 1.0 |
| Tool/channel authoring | `defineTool`, `z`, `loadTools`, `loadChannels`, `ChannelModule` | Usable now, may tighten before 1.0 |
| Injection ports | `PiSessionStore`, `inMemorySessionStore`, `jsonlSessionStore`, `Lease`, `Provider`, `createProvider` | Public because options reference them |
| Not exported | L0 harness adapter, pi harness factory, prompt/config internals | Internal modules; no compatibility promise |

Subpath exports:

- `@kid7st/fastagent/github` — GitHub webhook channel
- `@kid7st/fastagent/telegram` — Telegram bot channel

## Documentation

- [Repository docs index](../docs/README.md)
- [Quickstart](../docs/quickstart.md)
- [Configuration](../docs/configuration.md)
- [CLI reference](../docs/cli.md)
- [Embedding](../docs/embedding.md)
- [Channels](../docs/channels.md)
- [GitHub channel](../docs/github.md)
- [Telegram channel](../docs/telegram.md)
- [Channel development](../docs/channel-development.md)
- [API reference](../docs/api-reference.md)
- [Troubleshooting](../docs/troubleshooting.md)
- [Agent Handler SPEC](../docs/SPEC.md)
- [Core design notes](../docs/design/core.md)

## License

[MIT](./LICENSE)
