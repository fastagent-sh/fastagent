import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  AgentError,
  baseEnv,
  openAgent,
  type AgentDefinition,
  type MessageStreamEvent,
} from "@fastagent-sh/fastagent";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// Load a compiled agent built by `fastagent build` (here: `../basic-agent/dist/index.js`).
const definitionPath = resolve(process.env.AGENT_DIST ?? "../basic-agent/dist/index.js");
const definition = ((await import(definitionPath)) as { default: AgentDefinition }).default;

const agent = await openAgent(definition, {
  root: resolve(process.env.AGENT_ROOT ?? "./.agent-data"),
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  },
  env: baseEnv(process.env),
  ...(process.env.FASTAGENT_MODEL ? { model: process.env.FASTAGENT_MODEL } : {}),
});

const service = await agent.serve({
  ...(process.env.FASTAGENT_API_KEY ? { apiKeys: [process.env.FASTAGENT_API_KEY] } : {}),
});

const app = new Hono();

// 1. Custom app endpoint behind your own auth/routing, streaming SSE deltas directly from openAgent()
app.post("/chat", async (c) => {
  const { conversation, message } = await c.req.json<{ conversation?: string; message: string }>();
  const iterator = agent.invokeStream({
    content: message,
    ...(conversation ? { conversation } : {}),
  })[Symbol.asyncIterator]();

  // Check first event before starting SSE so refused requests return a proper HTTP status.
  let first: IteratorResult<MessageStreamEvent>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (error instanceof AgentError) {
      return c.json({ error: { code: error.code, message: error.message } }, 409);
    }
    throw error;
  }

  return streamSSE(c, async (stream) => {
    for (let next = first; !next.done; next = await iterator.next()) {
      await stream.writeSSE({ event: next.value.type, data: JSON.stringify(next.value) });
    }
  });
});

// 2. Mount the standard /health and /v1 Agent API routes under /agent
app.mount("/agent", service.fetch);

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Hono app listening on http://127.0.0.1:${port}`);
  console.log(`  POST /chat              -> custom streaming route`);
  console.log(`  GET  /agent/health      -> mounted FastAgent service`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.close();
    await agent.close();
    process.exit(0);
  });
}
