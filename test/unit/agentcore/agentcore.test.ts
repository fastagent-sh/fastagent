import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectAgent } from "../../../packages/client/src/index.ts";
import { connectAgentCore } from "../../../packages/agentcore/src/client.ts";
import { DSQL_LIMITS, createIndexAsync, dsqlDatabase } from "../../../packages/agentcore/src/index.ts";
import { SESSION_HEADER, agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import type { CreateIndex } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/schema.ts";
import type { PostgresDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";

const ENDPOINT = "abcdefghij.dsql.ap-southeast-1.on.aws";
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

describe("Aurora DSQL as an instance's database", () => {
  it("signs in as admin over verified TLS, with a token signed for the cluster's region, and keeps to DSQL's caps", async () => {
    const database = dsqlDatabase({ endpoint: ENDPOINT, credentials });
    expect(database.url).toBe(`postgres://admin@${ENDPOINT}:5432/postgres?sslmode=verify-full`);
    expect(database.limits).toEqual(DSQL_LIMITS);
    const token = new URL(`https://${await database.password?.()}`);
    expect(token.host).toBe(ENDPOINT);
    expect(token.searchParams.get("Action")).toBe("DbConnectAdmin");
    expect(token.searchParams.get("X-Amz-Credential")).toMatch(/\/ap-southeast-1\/dsql\/aws4_request$/);
  });

  it("signs another role in with its own token, and refuses an endpoint with no region it can read", async () => {
    const token = new URL(
      `https://${await dsqlDatabase({ endpoint: ENDPOINT, user: "agent", credentials }).password?.()}`,
    );
    expect(token.searchParams.get("Action")).toBe("DbConnect");
    expect(() => dsqlDatabase({ endpoint: "db.example.com", credentials })).toThrow(
      "db.example.com is not a DSQL endpoint (<cluster id>.dsql.<region>.on.aws): pass its region",
    );
  });

  /** DSQL as it answers an index: `started` for `CREATE INDEX ASYNC`, `succeeded` for the wait on its job. */
  const sent: unknown[][] = [];
  const db = (started: Record<string, unknown>[], succeeded = true) => ({
    query: async <T extends object>(text: string, params?: readonly unknown[]) => {
      sent.push([text, ...(params ?? [])]);
      return (text.startsWith("CREATE") ? started : [{ succeeded }]) as T[];
    },
  });

  it("builds an index as a job and waits for it, and starts none for one that exists", async () => {
    sent.length = 0;
    await createIndexAsync(db([{ job_id: "j1" }]), "CREATE INDEX IF NOT EXISTS i ON t (a)");
    await createIndexAsync(db([]), "CREATE INDEX IF NOT EXISTS i ON t (a)");
    expect(sent).toEqual([
      ["CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"],
      ["CALL sys.wait_for_job($1)", "j1"],
      ["CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"],
    ]);
  });

  it("fails the migration when the index job does not succeed, naming the job and the index", async () => {
    await expect(
      createIndexAsync(db([{ job_id: "j2" }], false), "CREATE INDEX IF NOT EXISTS i ON t (a)"),
    ).rejects.toThrow(
      "the index job j2 did not succeed (CREATE INDEX IF NOT EXISTS i ON t (a)): see sys.jobs, then drop the INVALID index",
    );
  });
});

let postgres: ServedPostgres;
beforeAll(async () => {
  postgres = await servedPostgres();
});
afterAll(() => postgres.close());

type Refused = { error: { code: string; message: string } };

/** The container's handler over an agent in a fresh directory, with its instances in the test database. */
async function runtimeOf(prefix: string, database: PostgresDatabase = { url: postgres.url }) {
  const dir = await fauxAgent(prefix);
  const handler = agentCoreHandler(await loadSourceDefinition(dir), {
    database,
    root: dir,
    secrets: process.env,
    offline: true,
  });
  return { dir, handler };
}

/** A request as AgentCore delivers it to the container, naming `session`. */
const delivered = (path: string, session?: string, init: RequestInit = {}) =>
  new Request(`http://runtime${path}`, {
    ...init,
    headers: { ...(session === undefined ? {} : { [SESSION_HEADER]: session }), ...(init.headers ?? {}) },
  });

describe("the AgentCore runtime", () => {
  it("is the instance its session names: the Agent API through it, kept in the database, and no other session's", async () => {
    const { dir, handler } = await runtimeOf("fa-agentcore-runtime-");
    const session = freshInstance();
    try {
      const bound = await handler.fetch(delivered("/invocations", session, { method: "POST", body: "{}" }));
      expect(await bound.json()).toEqual({ instance: session });
      const agent = connectAgent("http://runtime", {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set(SESSION_HEADER, session);
          return handler.fetch(request);
        },
      });
      expect((await agent.info()).name).toBe(session);
      const { id: sessionId } = await agent.sessions.create();
      const answered = await agent.messages.send({ sessionId, content: "hello" }, { wait: 30 });
      expect([answered.status, answered.answer?.text]).toEqual(["completed", "seen 1"]);
      expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(false);

      const other = await handler.fetch(delivered("/v1/agent", "another-session-0123456789abcdef0123"));
      expect([other.status, ((await other.json()) as Refused).error.message]).toEqual([
        400,
        `this AgentCore session is the instance "${session}", not "another-session-0123456789abcdef0123"`,
      ]);
      const unnamed = await handler.fetch(delivered("/v1/agent"));
      expect([unnamed.status, ((await unnamed.json()) as Refused).error.message]).toEqual([
        400,
        `a request names its AgentCore session in ${SESSION_HEADER}`,
      ]);
    } finally {
      await handler.close();
    }
  });

  it("answers /ping busy while a message runs, so AgentCore does not reclaim the microVM under it", async () => {
    const { handler } = await runtimeOf("fa-agentcore-busy-");
    const session = freshInstance();
    const ping = async () => ((await (await handler.fetch(delivered("/ping"))).json()) as { status: string }).status;
    try {
      expect(await ping()).toBe("Healthy");
      const agent = connectAgent("http://runtime", {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set(SESSION_HEADER, session);
          return handler.fetch(request);
        },
      });
      const { id: sessionId } = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId, content: "linger" });
      await vi.waitFor(async () => expect(await ping()).toBe("HealthyBusy"), { timeout: 3_000 });
      await agent.messages.get({ sessionId, messageId: message.id }, { wait: 15 });
      await vi.waitFor(async () => expect(await ping()).toBe("Healthy"), { timeout: 3_000 });
    } finally {
      await handler.close();
    }
  });

  it("opens the instance again on the next request after an open that failed, saying why it failed", async () => {
    // A database never opened makes its tables, and the first index it builds fails, as a DSQL index job can.
    const fresh = await servedPostgres();
    let builds = 0;
    const createIndex: CreateIndex = async (db, statement) => {
      builds += 1;
      if (builds === 1) throw new Error("the index job failed");
      await db.query(statement);
    };
    const { handler } = await runtimeOf("fa-agentcore-reopen-", { url: fresh.url, createIndex });
    const session = freshInstance();
    try {
      const failed = await handler.fetch(delivered("/v1/agent", session));
      expect([failed.status, failed.headers.get("retry-after")]).toEqual([503, "1"]);
      expect(((await failed.json()) as Refused).error).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("the index job failed"),
      });
      const opened = await handler.fetch(delivered("/invocations", session, { method: "POST", body: "{}" }));
      expect(await opened.json()).toEqual({ instance: session });
    } finally {
      await handler.close();
      await fresh.close();
    }
  });
});

describe("connectAgentCore", () => {
  const RUNTIME = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/support-a1b2c3d4e5";

  /**
   * AgentCore as far as a Caller meets it, on loopback: an invocation hands out the session's endpoint (this server),
   * which takes a signed request and delivers it to the runtime, or answers with what `refuse` says first.
   */
  async function agentCore(handler: { fetch(request: Request): Promise<Response> }) {
    const seen = { invocations: 0, signatures: [] as string[] };
    const refusals: Array<{ status: number; error: string }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers(req.headers as Record<string, string>);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
      let response: Response;
      if (req.url?.startsWith("/runtimes/")) {
        seen.invocations += 1;
        const delivered = await handler.fetch(
          new Request("http://runtime/invocations", {
            method: "POST",
            headers: { [SESSION_HEADER]: headers.get(SESSION_HEADER) ?? "" },
            body,
          }),
        );
        response = new Response(delivered.body, {
          status: delivered.status,
          headers: {
            "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-endpoint-url": `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        });
      } else {
        seen.signatures.push(headers.get("authorization") ?? "");
        const refusal = refusals.shift();
        response = refusal
          ? new Response(null, {
              status: refusal.status,
              headers: { "x-amzn-bedrock-agentcore-runtime-error": refusal.error },
            })
          : await handler.fetch(new Request(`http://runtime${req.url}`, { method: req.method, headers, body }));
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    return {
      seen,
      refuse: (status: number, error: string) => refusals.push({ status, error }),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("reaches the session's instance through its endpoint, signed, and binds again when AgentCore ended the session", async () => {
    const { handler } = await runtimeOf("fa-agentcore-client-");
    const fake = await agentCore(handler);
    const sessionId = freshInstance();
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      const { id } = await agent.sessions.create();
      const events: string[] = [];
      for await (const event of agent.messages.stream({ sessionId: id, content: "hello" })) events.push(event.type);
      expect(events.at(-1)).toBe("done");
      expect((await agent.info()).name).toBe(sessionId);
      expect(
        fake.seen.signatures.every((signature) =>
          /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-1\/bedrock-agentcore\/aws4_request, SignedHeaders=.*x-amzn-bedrock-agentcore-runtime-session-id/.test(
            signature,
          ),
        ),
      ).toBe(true);
      expect(fake.seen.invocations).toBe(1);

      fake.refuse(404, "SessionNotFound");
      expect((await agent.sessions.get(id)).id).toBe(id);
      expect(fake.seen.invocations).toBe(2);
    } finally {
      await fake.close();
      await handler.close();
      vi.unstubAllEnvs();
    }
  });

  it("refuses as the Agent API what AgentCore refused, and a session id or ARN AgentCore would not take", async () => {
    const { handler } = await runtimeOf("fa-agentcore-refused-");
    const fake = await agentCore(handler);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: freshInstance() });
      fake.refuse(403, "AccessDenied");
      await expect(agent.info()).rejects.toMatchObject({
        code: "unauthorized",
        message: "AgentCore refused the request: AccessDenied (HTTP 403)",
      });
      expect(() => connectAgentCore({ runtimeArn: RUNTIME, sessionId: "user-42" })).toThrow(
        'the session id "user-42" must be 33 to 256 letters, digits, "-" and "_" (AgentCore\'s rule)',
      );
      expect(() => connectAgentCore({ runtimeArn: "support", sessionId: freshInstance() })).toThrow(
        "support is not an AgentCore runtime's ARN (arn:aws:bedrock-agentcore:<region>:…:runtime/<id>)",
      );
    } finally {
      await fake.close();
      await handler.close();
      vi.unstubAllEnvs();
    }
  });
});
