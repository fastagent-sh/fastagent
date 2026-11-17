import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectAgentCore } from "../../../packages/agentcore/src/client.ts";
import { DSQL_LIMITS, createIndexAsync, dsqlDatabase } from "../../../packages/agentcore/src/index.ts";
import { SESSION_HEADER, agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { openPgDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/database.ts";
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

/** An invocation as AgentCore delivers it to the container: `body` under the session `session` names. */
const invocation = (session: string | undefined, body: unknown) =>
  new Request("http://runtime/invocations", {
    method: "POST",
    headers: { "content-type": "application/json", ...(session === undefined ? {} : { [SESSION_HEADER]: session }) },
    body: JSON.stringify(body),
  });

/** What the runtime answers an enveloped request with, unwrapped. */
async function answered(response: Response) {
  const { response: inner } = (await response.json()) as {
    response: { status: number; headers: Record<string, string>; body: string };
  };
  return {
    status: inner.status,
    headers: inner.headers,
    body: JSON.parse(Buffer.from(inner.body, "base64").toString()) as Refused,
  };
}

const RUNTIME = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/support-a1b2c3d4e5";

/**
 * AgentCore as far as a Caller meets it, on loopback: `InvokeAgentRuntime` delivers to the runtime's handler (`serving`),
 * and an answer that is not a 2xx comes back as AgentCore's own 424, as it does. `refuse` makes it refuse the next
 * invocation itself, before delivering it. One for the file: `connectAgentCore` keeps one AWS client a region, which
 * reads its endpoint once.
 */
const fake = {
  serving: undefined as { fetch(request: Request): Promise<Response> } | undefined,
  signatures: [] as string[],
  refusals: [] as Array<{ status: number; type: string }>,
  refuse(status: number, type: string) {
    this.refusals.push({ status, type });
  },
};
const fakeAgentCore = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  fake.signatures.push(String(req.headers.authorization));
  const refusal = fake.refusals.shift();
  if (refusal !== undefined || fake.serving === undefined) {
    const { status, type } = refusal ?? { status: 404, type: "ResourceNotFoundException" };
    res.writeHead(status, { "content-type": "application/json", "x-amzn-errortype": type });
    res.end(JSON.stringify({ message: "refused here" }));
    return;
  }
  const session = String(req.headers[SESSION_HEADER] ?? "");
  const delivered = await fake.serving.fetch(invocation(session, JSON.parse(Buffer.concat(chunks).toString())));
  if (delivered.status >= 300) {
    res.writeHead(424, { "content-type": "application/json", "x-amzn-errortype": "RuntimeClientError" });
    res.end(JSON.stringify({ message: `Received error (${delivered.status}) from runtime.` }));
    return;
  }
  res.writeHead(delivered.status, { "content-type": delivered.headers.get("content-type") ?? "" });
  for await (const chunk of delivered.body ?? []) res.write(chunk);
  res.end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => fakeAgentCore.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", `http://127.0.0.1:${(fakeAgentCore.address() as AddressInfo).port}`);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => fakeAgentCore.close(() => resolve()));
});

/** AgentCore delivering to `handler` for the length of one test. */
function agentCore(handler: { fetch(request: Request): Promise<Response> }) {
  fake.serving = handler;
  fake.signatures.length = 0;
  fake.refusals.length = 0;
  return {
    signatures: fake.signatures,
    refuse: (status: number, type: string) => fake.refuse(status, type),
    close: async () => {
      fake.serving = undefined;
    },
  };
}

describe("an agent on AgentCore", () => {
  it("is the instance its session names: the Agent API through invocations, each signed, kept in the database", async () => {
    const { dir, handler } = await runtimeOf("fa-agentcore-runtime-");
    const aws = agentCore(handler);
    const sessionId = freshInstance();
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      expect((await agent.info()).name).toBe(sessionId);
      const { id } = await agent.sessions.create();
      const sent = await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 });
      expect([sent.status, sent.answer?.text]).toEqual(["completed", "seen 1"]);
      // The answer streams as it is written: its first event arrives while the message still runs.
      const stream = agent.messages.stream({ sessionId: id, content: "linger" })[Symbol.asyncIterator]();
      const first = await stream.next();
      expect(first.value).toMatchObject({
        type: "message",
        message: { status: expect.stringMatching(/queued|running/) },
      });
      const messageId = (first.value as { message: { id: string } }).message.id;
      expect((await agent.messages.get({ sessionId: id, messageId })).status).not.toBe("completed");
      let last = first;
      for (let next = await stream.next(); !next.done; next = await stream.next()) last = next;
      expect(last.value).toMatchObject({ type: "done" });
      // A refusal keeps its code through AgentCore, which would have made a 404 its own 424.
      await expect(agent.sessions.get("no-such-session")).rejects.toMatchObject({ code: "not_found" });
      expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(false);
      expect(
        aws.signatures.every((signature) => signature.includes("/ap-southeast-1/bedrock-agentcore/aws4_request")),
      ).toBe(true);
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("refuses an invocation of another session, one that names none, and one that is not a request", async () => {
    const { handler } = await runtimeOf("fa-agentcore-refusals-");
    const session = freshInstance();
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    try {
      expect((await answered(await handler.fetch(invocation(session, request)))).status).toBe(200);
      const other = await answered(await handler.fetch(invocation("another-session-0123456789abcdef0123", request)));
      expect([other.status, other.body.error.message]).toEqual([
        400,
        `this AgentCore session is the instance "${session}", not "another-session-0123456789abcdef0123"`,
      ]);
      const unnamed = await answered(await handler.fetch(invocation(undefined, request)));
      expect(unnamed.body.error.message).toBe(`an invocation names its AgentCore session in ${SESSION_HEADER}`);
      const bare = await answered(await handler.fetch(invocation(session, { prompt: "hi" })));
      expect(bare.body.error.message).toBe("an invocation is { request: { method, path, headers, body } }");
    } finally {
      await handler.close();
    }
  });

  it("answers /ping busy while a message runs, so AgentCore does not reclaim the microVM under it", async () => {
    const { handler } = await runtimeOf("fa-agentcore-busy-");
    const aws = agentCore(handler);
    const ping = async () =>
      ((await (await handler.fetch(new Request("http://runtime/ping"))).json()) as { status: string }).status;
    try {
      expect(await ping()).toBe("Healthy");
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: freshInstance() });
      const { id: sessionId } = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId, content: "linger" });
      await vi.waitFor(async () => expect(await ping()).toBe("HealthyBusy"), { timeout: 3_000 });
      await agent.messages.get({ sessionId, messageId: message.id }, { wait: 15 });
      await vi.waitFor(async () => expect(await ping()).toBe("Healthy"), { timeout: 3_000 });
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("opens the instance again on the next invocation after an open that failed, saying why it failed", async () => {
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
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    try {
      const failed = await answered(await handler.fetch(invocation(session, request)));
      expect([failed.status, failed.headers["retry-after"]]).toEqual([503, "1"]);
      expect(failed.body.error).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("the index job failed"),
      });
      expect((await answered(await handler.fetch(invocation(session, request)))).status).toBe(200);
    } finally {
      await handler.close();
      await fresh.close();
    }
  });

  it("opens the instance again when another process took it over, rather than answer from the runs it stopped", async () => {
    // The lease is renewed on an interval: faked, so the renewal that finds the lease gone runs when told.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { handler } = await runtimeOf("fa-agentcore-taken-");
    const db = openPgDatabase(postgres.url);
    const session = freshInstance();
    const create = {
      request: { method: "POST", path: "/v1/sessions", headers: { "content-type": "application/json" }, body: "{}" },
    };
    try {
      expect((await answered(await handler.fetch(invocation(session, create)))).status).toBe(201);
      await db.query(
        "UPDATE durable_leases SET owner = 'another', lease_until = now() - interval '1 second' WHERE instance = $1",
        [session],
      );
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(
        async () => expect((await answered(await handler.fetch(invocation(session, create)))).status).toBe(201),
        {
          timeout: 10_000,
          interval: 200,
        },
      );
    } finally {
      vi.useRealTimers();
      await db.close();
      await handler.close();
    }
  });

  it("refuses as the Agent API what AgentCore refused, and a session id or ARN AgentCore would not take", async () => {
    const { handler } = await runtimeOf("fa-agentcore-refused-");
    const aws = agentCore(handler);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: freshInstance() });
      aws.refuse(403, "AccessDeniedException");
      await expect(agent.info()).rejects.toMatchObject({
        code: "unauthorized",
        message: "AgentCore refused the request: AccessDeniedException: refused here",
      });
      aws.refuse(404, "ResourceNotFoundException");
      await expect(agent.info()).rejects.toMatchObject({
        code: "internal",
        retryable: false,
        message: "AgentCore refused the request: ResourceNotFoundException: refused here",
      });
      expect(() => connectAgentCore({ runtimeArn: RUNTIME, sessionId: "user-42" })).toThrow(
        'the session id "user-42" must be 33 to 256 letters, digits, "-" and "_" (AgentCore\'s rule)',
      );
      expect(() => connectAgentCore({ runtimeArn: "support", sessionId: freshInstance() })).toThrow(
        "support is not an AgentCore runtime's ARN (arn:aws:bedrock-agentcore:<region>:…:runtime/<id>)",
      );
    } finally {
      await aws.close();
      await handler.close();
    }
  });
});
