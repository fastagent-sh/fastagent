import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  AgentError,
  baseEnv,
  openAgent,
  openPostgresDatabase,
  type AgentDefinition,
  type LocalAgent,
  type SessionEvent,
  type SharedPostgresDatabase,
} from "@fastagent-sh/fastagent";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const definitionPath = resolve(process.env.AGENT_DIST ?? "./agent/dist/index.js");
const definition = ((await import(definitionPath)) as { default: AgentDefinition }).default;

// Optional shared PostgreSQL pool across all tenant instances (falls back to per-tenant SQLite if unset).
const sharedDb: SharedPostgresDatabase | undefined = process.env.FASTAGENT_DATABASE_URL
  ? openPostgresDatabase({ url: process.env.FASTAGENT_DATABASE_URL }, { max: 20 })
  : undefined;

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const tenants = new Map<string, Promise<LocalAgent>>();

function getTenantAgent(tenantId: string): Promise<LocalAgent> {
  if (!TENANT_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}"`);
  }
  let pending = tenants.get(tenantId);
  if (pending === undefined) {
    pending = openAgent(definition, {
      root: resolve(process.env.TENANTS_ROOT ?? "./.tenants", tenantId),
      name: `tenant-${tenantId}`,
      ...(sharedDb ? { database: sharedDb } : {}),
      secrets: {
        TENANT_ID: tenantId,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        APP_API_BASE: process.env.APP_API_BASE,
        APP_API_TOKEN: process.env.APP_API_TOKEN,
      },
      env: baseEnv(process.env),
      ...(process.env.FASTAGENT_MODEL ? { model: process.env.FASTAGENT_MODEL } : {}),
    }).catch((error) => {
      tenants.delete(tenantId);
      throw error;
    });
    tenants.set(tenantId, pending);
  }
  return pending;
}

const app = new Hono();

// Replace with your real auth middleware (JWT, session cookie, etc.).
function tenantFromHeader(header: string | undefined): string | undefined {
  const id = header?.trim().toLowerCase();
  return id && TENANT_PATTERN.test(id) ? id : undefined;
}

// Create a session owned by the authenticated tenant
app.post("/api/sessions", async (c) => {
  const tenantId = tenantFromHeader(c.req.header("x-tenant-id"));
  if (!tenantId) return c.json({ error: "missing or invalid x-tenant-id header" }, 401);
  const agent = await getTenantAgent(tenantId);
  const session = await agent.sessions.create();
  return c.json(session, 201);
});

// Send a message into a tenant session (returns immediately once persisted, or waits if requested)
app.post("/api/sessions/:sessionId/messages", async (c) => {
  const tenantId = tenantFromHeader(c.req.header("x-tenant-id"));
  if (!tenantId) return c.json({ error: "missing or invalid x-tenant-id header" }, 401);
  const agent = await getTenantAgent(tenantId);
  const { content, idempotencyKey, wait } = await c.req.json<{
    content: string;
    idempotencyKey?: string;
    wait?: number;
  }>();
  try {
    const message = await agent.messages.send(
      { sessionId: c.req.param("sessionId"), content, ...(idempotencyKey ? { idempotencyKey } : {}) },
      wait === undefined ? undefined : { wait },
    );
    return c.json(message);
  } catch (error) {
    if (error instanceof AgentError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.code === "not_found" ? 404 : 409);
    }
    throw error;
  }
});

// Resumable SSE stream: clients pass `?after=<lastEntryId>` (or `Last-Event-ID`) after page refresh or network drop
app.get("/api/sessions/:sessionId/events", async (c) => {
  const tenantId = tenantFromHeader(c.req.header("x-tenant-id"));
  if (!tenantId) return c.json({ error: "missing or invalid x-tenant-id header" }, 401);
  const agent = await getTenantAgent(tenantId);
  const after = c.req.query("after") ?? c.req.header("last-event-id") ?? undefined;
  const controller = new AbortController();
  const iterator = agent.sessions
    .events(c.req.param("sessionId"), { ...(after ? { after } : {}), signal: controller.signal })
    [Symbol.asyncIterator]();

  let first: IteratorResult<SessionEvent>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (error instanceof AgentError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.code === "not_found" ? 404 : 409);
    }
    throw error;
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    for (let next = first; !next.done; next = await iterator.next()) {
      const event = next.value;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
        ...(event.type === "entry" ? { id: event.entry.id } : {}),
      });
    }
  });
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Multi-tenant SaaS copilot listening on http://127.0.0.1:${port}`);
  console.log(`Storage: ${sharedDb ? "shared PostgreSQL pool" : "per-tenant local SQLite"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.close();
    const opened = await Promise.all([...tenants.values()].map((p) => p.catch(() => undefined)));
    await Promise.all(opened.map((a) => a?.close().catch(() => undefined)));
    await sharedDb?.close();
    process.exit(0);
  });
}
