# @kid7st/fastagent

**Flask/WSGI for agents.** Turn an existing agent folder — `AGENTS.md` + `skills/` — into a running capability without rewriting it, in either posture:

- **Embed into an existing product** — call the agent from your own route (Astro/Next/Hono/Lambda), wired to your session store, your auth, your host.
- **Serve as a standalone agent service** — webhook handler, scheduled worker, Slack/Telegram bot, API endpoint, or cloud-hosted agent.

Engine-, model-, and host-neutral. Built on the [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) harness; implements the locked [Agent Handler SPEC v0.1](https://github.com/kid7st/fastagent/blob/main/docs/SPEC.md).

> Requires Node ≥ 22.19. Ships compiled JavaScript + type declarations; no build step in consuming projects.

## Embed (library)

```ts
import { createPiAgentFromDefinition, createPiModels, resolveModel, createInvokeHandler } from "@kid7st/fastagent";

// One Models collection owns model resolution + auth (pi OAuth file → env vars).
const models = createPiModels();
// folder → agent, with your own session store / models / tools injected
const { agent } = await createPiAgentFromDefinition("./agent", {
  models,
  model: resolveModel(models, "openai-codex/gpt-5.5"),
  // sessions, env, lease, models, tools — all optional injection points
});

// createInvokeHandler is a Fetch handler: mount it in any host route
export const POST = createInvokeHandler(agent);
```

`agent.invoke(scope, prompt)` returns an `AsyncIterable<AgentEvent>` (text deltas, tool events, a terminal `completed`/`failed`). Consume it as a stream, or buffer it with `collect()`.

## Serve / deploy (CLI)

```bash
fastagent init my-agent && cd my-agent
fastagent dev                 # local HTTP/SSE on :8787
fastagent build               # → a self-contained artifact
fastagent start .fastagent/build
```

## Documentation

Full docs, design, and the SPEC live in the repository:

- [Quickstart](https://github.com/kid7st/fastagent/blob/main/docs/quickstart.md)
- [Agent Handler SPEC v0.1](https://github.com/kid7st/fastagent/blob/main/docs/SPEC.md)
- [Core design](https://github.com/kid7st/fastagent/blob/main/docs/core-design.md)

## License

[MIT](./LICENSE)
