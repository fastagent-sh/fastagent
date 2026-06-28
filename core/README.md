# @kid7st/fastagent

**Flask/WSGI for agents.** Turn an existing agent folder — `AGENTS.md` + `skills/` — into a running capability without rewriting it, in either posture:

- **Embed into an existing product** — call the agent from your own route (Astro/Next/Hono/Lambda), wired to your session store, your auth, your host.
- **Serve as a standalone agent service** — webhook handler, scheduled worker, Slack/Telegram bot, API endpoint, or cloud-hosted agent.

Engine-, model-, and host-neutral. Built on the [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) harness; implements the locked [Agent Handler SPEC v0.1](https://github.com/kid7st/fastagent/blob/main/docs/SPEC.md).

> Requires Node ≥ 22.19. Ships compiled JavaScript + type declarations; no build step in consuming projects.

## Embed (library)

```ts
import { createPiAgentFromDefinition, createInvokeHandler } from "@kid7st/fastagent";

// folder → agent. model is a "provider/modelId" spec; auth resolves from ~/.fastagent/auth.json
// (fastagent login) → env vars. sessions / env / lease / providers / tools are optional injection points.
const { agent } = await createPiAgentFromDefinition("./agent", {
  model: "openai-codex/gpt-5.5",
});

// createInvokeHandler is a Fetch handler: mount it in any host route
export const POST = createInvokeHandler(agent);
```

No folder? Assemble from typed parts — `model` (spec string) + `instructions` + `tools`:

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
  instructions: "You are a support assistant. Use lookup-order to answer order questions.",
  tools: [lookupOrder],
});
```

`agent.invoke(scope, prompt)` returns an `AsyncIterable<AgentEvent>` (text deltas, tool events, a terminal `completed`/`failed`). Consume it as a stream, or buffer it with `collect()`.

## Serve / deploy (CLI)

```bash
fastagent init my-agent && cd my-agent
fastagent info                # inspect what the folder assembles into — model/skills/tools/channels (no server)
fastagent dev                 # local HTTP/SSE on :8787 (watch + reload)
fastagent invoke "hello"       # run one turn and exit — no server, no TUI (CI smoke / scripting)
fastagent start               # run the same directory in production posture (no build step)
```

## Documentation

Full docs, design, and the SPEC live in the repository:

- [Quickstart](https://github.com/kid7st/fastagent/blob/main/docs/quickstart.md)
- [Agent Handler SPEC v0.1](https://github.com/kid7st/fastagent/blob/main/docs/SPEC.md)
- [Core design](https://github.com/kid7st/fastagent/blob/main/docs/core-design.md)

## License

[MIT](./LICENSE)
