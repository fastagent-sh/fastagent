import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  alarmNameOf,
  atExpression,
  createAlarmGroup,
  universalTargetArn,
} from "../../../packages/agentcore/src/alarms.ts";
import { AgentError as RootAgentError } from "@fastagent-sh/client";
import { AgentError, connectAgentCore } from "@fastagent-sh/client/agentcore";
import { envelopeResponse, unwrapResponse } from "@fastagent-sh/client/agentcore/contract";
import { DSQL_LIMITS, createIndexAsync, dsqlDatabase } from "../../../packages/agentcore/src/index.ts";
import { SESSION_HEADER, agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { secretValues } from "../../../packages/agentcore/src/secrets.ts";
import { DEPLOY_SCHEDULE_NAME, DEPLOY_SESSION_ID } from "../../../packages/agentcore/src/variables.ts";
import { Unavailable } from "../../../packages/fastagent/src/unavailable.ts";
import agentcorePackage from "../../../packages/agentcore/package.json" with { type: "json" };
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { watchInstanceAlarm } from "../../../packages/fastagent/src/harnesses/pi-durable/alarm.ts";
import { clockStore } from "../../../packages/fastagent/src/harnesses/pi-durable/clock.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { openPgDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/database.ts";
import type { CreateIndex } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/schema.ts";
import type { PostgresDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { fauxAgent, runInProcess } from "../../doubles/cli-run.ts";
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

  it("starts an index as a job and answers how to wait for it, and starts none for one that exists", async () => {
    sent.length = 0;
    const job = await createIndexAsync(db([{ job_id: "j1" }]), "CREATE INDEX IF NOT EXISTS i ON t (a)");
    expect(sent).toEqual([["CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"]]);
    await job?.();
    expect(await createIndexAsync(db([]), "CREATE INDEX IF NOT EXISTS i ON t (a)")).toBeUndefined();
    expect(sent).toEqual([
      ["CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"],
      ["CALL sys.wait_for_job($1)", "j1"],
      ["CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"],
    ]);
  });

  it("fails the migration when the index job does not succeed, naming the job and the index", async () => {
    const job = await createIndexAsync(db([{ job_id: "j2" }], false), "CREATE INDEX IF NOT EXISTS i ON t (a)");
    await expect(job?.() ?? Promise.resolve()).rejects.toThrow(
      "the index job j2 did not succeed (CREATE INDEX IF NOT EXISTS i ON t (a)): see sys.jobs, then drop the INVALID index",
    );
  });
});

let postgres: ServedPostgres;
beforeAll(async () => {
  postgres = await servedPostgres();
});
afterAll(() => postgres.close());

type Refused = { error: { code: string; message: string; retryable: boolean } };

/** The container's handler over an agent in a fresh directory, with its instances in the test database. */
async function runtimeOf(
  prefix: string,
  database: PostgresDatabase | (() => PostgresDatabase) = { url: postgres.url },
) {
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

const agentcoreVersion = agentcorePackage.version;

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
  urls: [] as string[],
  refusals: [] as Array<{ status: number; type: string }>,
  refuse(status: number, type: string) {
    this.refusals.push({ status, type });
  },
};
const fakeAgentCore = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  fake.signatures.push(String(req.headers.authorization));
  fake.urls.push(String(req.url));
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
  fake.urls.length = 0;
  fake.refusals.length = 0;
  return {
    signatures: fake.signatures,
    urls: fake.urls,
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
      // A refusal keeps its code through AgentCore, which would have made a 404 its own 424, and rejects with the
      // same AgentError class both `@fastagent-sh/client` and `@fastagent-sh/client/agentcore` export.
      expect(AgentError).toBe(RootAgentError);
      const missing = await agent.sessions.get("no-such-session").catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(AgentError);
      expect(missing).toMatchObject({ code: "not_found" });

      // Binary attachments (>32 KiB, all byte values 0..255) and null-body responses round-trip without Node's Buffer.
      const binary = new Uint8Array(70_000);
      for (let i = 0; i < binary.length; i += 1) binary[i] = i & 0xff;
      const unwrappedBinary = unwrapResponse(
        await envelopeResponse(new Response(binary, { status: 200, headers: { "content-type": "image/png" } })),
      );
      expect(new Uint8Array(await unwrappedBinary.arrayBuffer())).toEqual(binary);
      expect(unwrapResponse(await envelopeResponse(new Response(null, { status: 204 }))).status).toBe(204);
      expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(false);
      expect(
        aws.signatures.every((signature) => signature.includes("/ap-southeast-1/bedrock-agentcore/aws4_request")),
      ).toBe(true);
      // A runtime endpoint picks the version that answers.
      expect(aws.urls.every((url) => !url.includes("qualifier="))).toBe(true);
      const released = connectAgentCore({ runtimeArn: RUNTIME, sessionId, qualifier: "prod" });
      expect((await released.info()).name).toBe(sessionId);
      expect(aws.urls.at(-1)).toContain("qualifier=prod");
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

  it("reads the agent's values as the instance opens: one that cannot be read is said, and read at the next invocation", async () => {
    // A value the agent's code requires, which only the secret holds: without it the instance does not open.
    const dir = await fauxAgent("fa-agentcore-values-", {
      "src/tools/ticket.ts": [
        `import { defineTool } from "@earendil-works/pi-durable";`,
        `import { obj } from "@earendil-works/pi-schema";`,
        `import { needs } from "@fastagent-sh/fastagent";`,
        `export default needs(["ZENDESK_TOKEN"], () => defineTool({ name: "ticket", description: "File a ticket.", parameters: obj({}), execute: async () => ({ output: [] }) }));`,
      ].join("\n"),
    });
    let reads = 0;
    const handler = agentCoreHandler(await loadSourceDefinition(dir), {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      offline: true,
      values: async () => {
        reads += 1;
        if (reads === 1)
          throw new Error("the secret support cannot be read: ResourceNotFoundException: not created yet");
        return { ZENDESK_TOKEN: "zd" };
      },
    });
    const session = freshInstance();
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    try {
      // A secret not created yet needs a person to create it: not one for a Caller to retry.
      const unread = await answered(await handler.fetch(invocation(session, request)));
      expect([unread.status, unread.body.error.code]).toEqual([500, "internal"]);
      expect(unread.body.error.message).toContain("the secret support cannot be read: ResourceNotFoundException");
      const opened = await answered(await handler.fetch(invocation(session, request)));
      expect([opened.status, reads]).toEqual([200, 2]);
    } finally {
      await handler.close();
    }
  });

  it("answers an open that failed retryable only when it passes by itself, and opens again on the next invocation", async () => {
    // A database never opened makes its tables, and the first index it builds fails, as a DSQL index job can: a
    // person drops the INVALID index, so it is internal, not retryable.
    const fresh = await servedPostgres();
    let builds = 0;
    const createIndex: CreateIndex = async (db, statement) => {
      builds += 1;
      if (builds === 1) throw new Error("the index job failed");
      await db.query(statement);
    };
    const { handler } = await runtimeOf("fa-agentcore-reopen-", { url: fresh.url, createIndex });
    // A database out of reach for a moment passes by itself: unavailable, retryable.
    const { handler: unreached } = await runtimeOf("fa-agentcore-unreached-", {
      url: "postgres://postgres@127.0.0.1:1/postgres",
    });
    // A runtime given no database says so to each invocation, as an instance that cannot open.
    const { handler: unplaced } = await runtimeOf("fa-agentcore-unplaced-", () => {
      throw new Error("FASTAGENT_DSQL_ENDPOINT is required: the Aurora DSQL cluster's endpoint");
    });
    const session = freshInstance();
    const request = { request: { method: "GET", path: "/v1/agent", headers: {} } };
    try {
      const failed = await answered(await handler.fetch(invocation(session, request)));
      expect([failed.status, failed.headers["retry-after"]]).toEqual([500, undefined]);
      expect(failed.body.error).toMatchObject({
        code: "internal",
        retryable: false,
        message: expect.stringContaining("the index job failed"),
      });
      expect((await answered(await handler.fetch(invocation(session, request)))).status).toBe(200);

      const passing = await answered(await unreached.fetch(invocation(freshInstance(), request)));
      expect([passing.status, passing.headers["retry-after"], passing.body.error.code]).toEqual([
        503,
        "1",
        "unavailable",
      ]);

      const placeless = await answered(await unplaced.fetch(invocation(freshInstance(), request)));
      expect([placeless.status, placeless.body.error.code]).toEqual([500, "internal"]);
      expect(placeless.body.error.message).toContain("FASTAGENT_DSQL_ENDPOINT is required");
    } finally {
      await handler.close();
      await unreached.close();
      await unplaced.close();
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
      aws.refuse(400, "ExpiredTokenException");
      await expect(agent.info()).rejects.toMatchObject({ code: "unauthorized", retryable: false });
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

describe("the agent's values from its secret", () => {
  /** Secrets Manager as `secretValues` asks it: the secret's string, or the failure it answers with. */
  const holding = (answer: string | Error) => ({
    send: async () => {
      if (answer instanceof Error) throw answer;
      return { SecretString: answer };
    },
  });

  it("reads the secret's names and values, and refuses one the runtime's environment also sets", async () => {
    const secret = holding(JSON.stringify({ ANTHROPIC_API_KEY: "sk-1", ZENDESK_TOKEN: "zd" }));
    expect(await secretValues("support", {}, secret as never)).toEqual({
      ANTHROPIC_API_KEY: "sk-1",
      ZENDESK_TOKEN: "zd",
    });
    await expect(secretValues("support", { ZENDESK_TOKEN: "other" }, secret as never)).rejects.toThrow(
      "ZENDESK_TOKEN is both in the secret support and in the runtime's environment: keep it in one",
    );
  });

  it("refuses a secret that is not a JSON object of strings, and says why one cannot be read", async () => {
    for (const [answer, said] of [
      ["not json", "the secret support is not a JSON object of names to values"],
      ["[1]", "the secret support is not a JSON object of names to values"],
      [JSON.stringify({ PORT: 8080 }), "the secret support has PORT as a number, not a string"],
      [
        new Error("AccessDeniedException: not allowed"),
        "the secret support cannot be read: AccessDeniedException: not allowed",
      ],
    ] as const) {
      await expect(secretValues("support", {}, holding(answer) as never)).rejects.toThrow(said);
    }
  });

  it("calls a refusal that passes by itself (throttled, Secrets Manager's own fault) unavailable, and no other", async () => {
    const failing = (name: string, fault: "client" | "server") =>
      holding(Object.assign(new Error(`${name}: refused`), { name, $fault: fault }));
    for (const [name, fault, passes] of [
      ["ThrottlingException", "client", true],
      ["InternalServiceError", "server", true],
      ["ResourceNotFoundException", "client", false],
      ["AccessDeniedException", "client", false],
    ] as const) {
      const error = await secretValues("support", {}, failing(name, fault) as never).catch((e: unknown) => e);
      expect([name, error instanceof Unavailable]).toEqual([name, passes]);
    }
  });
});

describe("fastagent deploy init agentcore", () => {
  it("writes the container and the AgentCore project, says what to create and how to deploy, and keeps the project after", async () => {
    const dir = await fauxAgent("fa-agentcore-init-", {
      "src/tools/ticket.ts": [
        `import { defineTool } from "@earendil-works/pi-durable";`,
        `import { obj } from "@earendil-works/pi-schema";`,
        `import { needs } from "@fastagent-sh/fastagent";`,
        `export default needs(["ZENDESK_TOKEN"], () => defineTool({ name: "ticket", description: "File a ticket.", parameters: obj({}), execute: async () => ({ output: [] }) }));`,
      ].join("\n"),
    });
    const first = await runInProcess(["-C", dir, "deploy", "init", "agentcore", "--no-install"]);
    expect(first.code, first.stderr).toBe(0);
    const name = basename(dir);
    expect(first.stdout).toContain(
      `aws secretsmanager create-secret --name ${name} --secret-string file://<values.json>`,
    );
    expect(first.stdout).toContain("npx -y @aws/agentcore@1.0.3 deploy");
    expect(first.stdout).toContain("ZENDESK_TOKEN, which its code declares");

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^# Generated by `fastagent deploy init agentcore`/);
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
    expect(dockerfile).toContain('CMD ["./node_modules/.bin/fastagent", "agentcore", "start"]');
    // The state is in the platform's database: no volume taken, no name for one.
    expect(dockerfile).not.toMatch(/FASTAGENT_DEPLOYED|FASTAGENT_NAME|FASTAGENT_ROOT/);
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toMatch(/^\/agentcore$/m);

    const project = JSON.parse(await readFile(join(dir, "agentcore", "agentcore.json"), "utf8"));
    expect(project.runtimes).toEqual([
      expect.objectContaining({ build: "Container", codeLocation: ".", dockerfile: "Dockerfile" }),
    ]);
    expect(project.name).toMatch(/^[A-Za-z][A-Za-z0-9]{0,22}$/);
    expect(await readFile(join(dir, "agentcore", "cdk", "lib", "cdk-stack.ts"), "utf8")).toContain(
      `secretName: '${name}'`,
    );
    const cdkPackage = JSON.parse(await readFile(join(dir, "agentcore", "cdk", "package.json"), "utf8"));
    expect(cdkPackage.dependencies["@fastagent-sh/agentcore"]).toBe(agentcoreVersion);

    await writeFile(join(dir, "agentcore", "agentcore.json"), '{ "mine": true }\n');
    const again = await runInProcess(["-C", dir, "deploy", "init", "agentcore", "--no-install"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).toContain("kept agentcore/ (yours once written)");
    expect(await readFile(join(dir, "agentcore", "agentcore.json"), "utf8")).toBe('{ "mine": true }\n');
  });

  it("refuses a flag of init's on another command, and a start with no build to serve", async () => {
    const dir = await fauxAgent("fa-agentcore-usage-");
    const flag = await runInProcess(["agentcore", "start", "--force"], dir);
    expect([flag.code, flag.stderr.split("\n")[0]]).toEqual([2, "Error: --force and --no-install are init's"]);
    const invokeFlag = await runInProcess(["agentcore", "start", "--arn", RUNTIME], dir);
    expect(invokeFlag.code).toBe(2);
    expect(invokeFlag.stderr).toContain("are invoke's");
    // The one thing the container cannot serve without: the build it runs.
    const unbuilt = await runInProcess(["agentcore", "start"], dir);
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.stderr).toContain("holds no build");
  });
});

describe("fastagent agentcore invoke", () => {
  it("streams text and NDJSON through AgentCore, continues a session via --instance + --session, honors FASTAGENT_AGENTCORE_ARN and --qualifier", async () => {
    const { handler } = await runtimeOf("fa-agentcore-invoke-");
    const aws = agentCore(handler);
    try {
      const first = await runInProcess(["agentcore", "invoke", "first turn", "--arn", RUNTIME, "--qualifier", "prod"]);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout.trim()).toBe("seen 1");
      expect(aws.urls.every((u) => u.includes("qualifier=prod"))).toBe(true);
      const match = first.stderr.match(/--instance (cli-[0-9a-f-]+) --session (\S+)\)/);
      expect(match, first.stderr).not.toBeNull();
      const instance = match?.[1] ?? "";
      const sessionId = match?.[2] ?? "";
      expect(instance.length).toBeGreaterThanOrEqual(33);
      expect(sessionId.length).toBeGreaterThan(0);

      vi.stubEnv("FASTAGENT_AGENTCORE_ARN", RUNTIME);
      try {
        const second = await runInProcess([
          "agentcore",
          "invoke",
          "follow up",
          "--instance",
          instance,
          "--session",
          sessionId,
          "--json",
        ]);
        expect(second.code, second.stderr).toBe(0);
        const events = second.stdout
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                message?: { sessionId: string; status: string; answer?: { text: string } };
              },
          );
        const done = events.find((e) => e.type === "done");
        expect(done?.message).toMatchObject({ sessionId, status: "completed", answer: { text: "seen 2" } });
      } finally {
        vi.stubEnv("FASTAGENT_AGENTCORE_ARN", undefined);
      }
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("refuses missing ARN, --session without --instance, invalid ARN/instance/model, wrong flags, extra args, and empty message with exit 2", async () => {
    vi.stubEnv("FASTAGENT_AGENTCORE_ARN", undefined);
    const cases: Array<[string[], RegExp]> = [
      [["agentcore", "invoke", "hi"], /missing runtime ARN.*FASTAGENT_AGENTCORE_ARN/],
      [["agentcore", "invoke", "hi", "--arn", RUNTIME, "--session", "s1"], /--session requires --instance/],
      [["agentcore", "invoke", "hi", "--arn", "not-an-arn"], /is not an AgentCore runtime's ARN/],
      [["agentcore", "invoke", "hi", "--arn", RUNTIME, "--instance", "too-short"], /33 to 256/],
      [["agentcore", "invoke", "hi", "--arn", RUNTIME, "--model", "badmodel"], /--model/],
      [["agentcore", "invoke", "hi", "--arn", RUNTIME, "--force"], /--force and --no-install are init's/],
      [["agentcore", "invoke", "one", "two", "--arn", RUNTIME], /at most one <message>/],
      [["agentcore", "invoke", "   ", "--arn", RUNTIME], /message must not be empty/],
    ];
    for (const [args, pattern] of cases) {
      const res = await runInProcess(args);
      expect(res.code, `${args.join(" ")}: ${res.stderr}`).toBe(2);
      expect(res.stdout, args.join(" ")).toBe("");
      expect(res.stderr, args.join(" ")).toMatch(pattern);
    }

    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const tty = await runInProcess(["agentcore", "invoke", "--arn", RUNTIME]);
      expect([tty.code, tty.stdout]).toEqual([2, ""]);
      expect(tty.stderr).toContain("fastagent agentcore invoke");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("exits 1 with clean stdout when AgentCore refuses the invocation", async () => {
    const { handler } = await runtimeOf("fa-agentcore-invoke-refuse-");
    const aws = agentCore(handler);
    try {
      aws.refuse(403, "AccessDeniedException");
      const res = await runInProcess(["agentcore", "invoke", "hi", "--arn", RUNTIME]);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("unauthorized");
    } finally {
      await aws.close();
      await handler.close();
    }
  });
});

describe("connectAgentCore without AWS credentials", () => {
  it("refuses unauthorized, not retryable, when there are none to sign with", async () => {
    // Another region: a client of its own, made with no credentials to find.
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    try {
      const agent = connectAgentCore({
        runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/support-a1b2c3d4e5",
        sessionId: freshInstance(),
      });
      await expect(agent.info()).rejects.toMatchObject({
        code: "unauthorized",
        retryable: false,
        message: expect.stringMatching(/^no AWS credentials to call AgentCore with: /),
      });
    } finally {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
      vi.stubEnv("AWS_EC2_METADATA_DISABLED", undefined);
    }
  });
});

/** EventBridge Scheduler in memory: one schedule group with `.deploy` seeded as `FastAgentResources` writes it. */
function fakeScheduler(group = "alarms-group", state: "ENABLED" | "DISABLED" = "DISABLED") {
  type StoredSchedule = {
    Name: string;
    GroupName: string;
    ScheduleExpression: string;
    ScheduleExpressionTimezone?: string;
    FlexibleTimeWindow: { Mode: "OFF" | "FLEXIBLE" };
    ActionAfterCompletion?: "NONE" | "DELETE";
    State: "ENABLED" | "DISABLED";
    Description?: string;
    Target: { Arn: string; RoleArn: string; Input: string };
  };
  const schedules = new Map<string, StoredSchedule>([
    [
      DEPLOY_SCHEDULE_NAME,
      {
        Name: DEPLOY_SCHEDULE_NAME,
        GroupName: group,
        ScheduleExpression: "rate(1 minute)",
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        State: state,
        Target: {
          Arn: universalTargetArn(),
          RoleArn: "arn:aws:iam::123456789012:role/alarm-role",
          Input: JSON.stringify({
            AgentRuntimeArn: RUNTIME,
            RuntimeSessionId: DEPLOY_SESSION_ID,
            ContentType: "application/json",
            Payload: JSON.stringify({ rearm: true }),
          }),
        },
      },
    ],
  ]);
  const calls: string[] = [];
  let nextError: Error | undefined;
  let afterWrite: ((name: string) => void | Promise<void>) | undefined;
  const notFound = (name: string) =>
    Object.assign(new Error(`Schedule ${name} not found`), { name: "ResourceNotFoundException" });
  return {
    schedules,
    calls,
    failNext(error: Error) {
      nextError = error;
    },
    onWritten(hook: ((name: string) => void | Promise<void>) | undefined) {
      afterWrite = hook;
    },
    client: {
      async send(command: unknown): Promise<unknown> {
        if (nextError !== undefined) {
          const err = nextError;
          nextError = undefined;
          throw err;
        }
        const { constructor: kind, input } = command as {
          constructor: { name: string };
          input: Partial<StoredSchedule> & { Name?: string };
        };
        const name = input.Name ?? "";
        if (kind.name === "GetScheduleCommand") {
          calls.push(`Get:${name}`);
          const found = schedules.get(name);
          if (found === undefined) throw notFound(name);
          return structuredClone(found);
        }
        if (kind.name === "CreateScheduleCommand") {
          calls.push(`Create:${name}`);
          if (schedules.has(name)) throw Object.assign(new Error("exists"), { name: "ConflictException" });
          schedules.set(name, structuredClone(input) as StoredSchedule);
          await afterWrite?.(name);
          return { ScheduleArn: `arn:aws:scheduler:ap-southeast-1:123456789012:schedule/${group}/${name}` };
        }
        if (kind.name === "UpdateScheduleCommand") {
          calls.push(`Update:${name}`);
          if (!schedules.has(name)) throw notFound(name);
          schedules.set(name, structuredClone(input) as StoredSchedule);
          await afterWrite?.(name);
          return { ScheduleArn: `arn:aws:scheduler:ap-southeast-1:123456789012:schedule/${group}/${name}` };
        }
        if (kind.name === "DeleteScheduleCommand") {
          calls.push(`Delete:${name}`);
          if (!schedules.delete(name)) throw notFound(name);
          return {};
        }
        throw new Error(`unexpected command: ${String(command)}`);
      },
    },
  };
}

describe("one EventBridge alarm per AgentCore session", () => {
  it("maps 256-char case-sensitive session ids into <=63-char schedule names and rounds `at` up to the second", () => {
    const shared = `user-${"a".repeat(95)}`;
    const first = alarmNameOf(`${shared}-Alpha-${"x".repeat(150)}`);
    const second = alarmNameOf(`${shared}-alpha-${"x".repeat(150)}`);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);

    const rounded = atExpression(new Date("2026-11-18T09:00:00.250Z"), new Date("2026-11-18T08:59:00.000Z"));
    expect(rounded.expression).toBe("at(2026-11-18T09:00:01)");
  });

  it("arms on a wake-up, stays HealthyBusy while a cold-woken alarm turn runs after answering 200, and disarms once done", async () => {
    const dir = await fauxAgent("fa-agentcore-alarm-", {
      "fastagent.config.ts": `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
faux.setResponses(Array.from({ length: 30 }, () => (context) => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage("scheduled");
  const text = JSON.stringify(last?.content ?? "");
  if (text.includes("wake-me")) return fauxAssistantMessage([fauxToolCall("wake", { in: "10m", prompt: "slow-woken" })], { stopReason: "toolUse" });
  if (text.includes("slow-woken")) return new Promise((r) => setTimeout(() => r(fauxAssistantMessage("woken-reply")), 300));
  return fauxAssistantMessage("plain");
}));
export default { model: "gw/m1", providers: [faux.provider] };
`,
    });
    const definition = await loadSourceDefinition(dir);
    const sched = fakeScheduler();
    let clockNow = new Date("2026-11-18T08:00:00.250Z");
    const makeAlarms = () =>
      createAlarmGroup({ group: "alarms-group", client: sched.client as never, now: () => clockNow });
    const sessionId = freshInstance();
    const alarmName = alarmNameOf(sessionId);
    let handler = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      offline: true,
      alarms: makeAlarms(),
    });
    let aws = agentCore(handler);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      const { id } = await agent.sessions.create();
      await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 });
      // An ordinary short chat turn with no schedules or wake-ups touches EventBridge Scheduler zero times.
      expect(sched.calls).toEqual([]);

      // The model calls `wake`: `observeCommits` arms the session's one EventBridge schedule, and `wakeups.cancel` disarms it.
      await agent.messages.send({ sessionId: id, content: "wake-me" }, { wait: 30 });
      await vi.waitFor(() => expect(sched.schedules.get(alarmName)?.ScheduleExpression).toBeDefined());
      expect(sched.schedules.get(alarmName)?.ActionAfterCompletion).toBe("NONE");
      const pending = await agent.wakeups.list();
      expect(pending).toHaveLength(1);
      await agent.wakeups.cancel(pending[0]!.id);
      await vi.waitFor(() => expect(sched.schedules.has(alarmName)).toBe(false));

      // Arm again, reclaim the microVM (`close`), then deliver EventBridge Scheduler's `{ alarm: true }` to a cold handler.
      await agent.messages.send({ sessionId: id, content: "wake-me" }, { wait: 30 });
      await vi.waitFor(() => expect(sched.schedules.has(alarmName)).toBe(true));
      await aws.close();
      await handler.close();

      clockNow = new Date(Date.now() + 15 * 60_000);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(clockNow);
      handler = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        offline: true,
        alarms: makeAlarms(),
      });
      aws = agentCore(handler);

      const ack = await handler.fetch(invocation(sessionId, { alarm: true }));
      expect([ack.status, await ack.json()]).toEqual([200, { ok: true }]);
      // Acknowledged 200 right away while the 300ms woken turn still runs: `/ping` holds the microVM with HealthyBusy,
      // and the one-shot EventBridge schedule is already deleted.
      const pingDuring = (await (await handler.fetch(new Request("http://runtime/ping"))).json()) as { status: string };
      expect(pingDuring.status).toBe("HealthyBusy");
      expect(sched.schedules.has(alarmName)).toBe(false);

      await vi.waitFor(async () => {
        const pingAfter = (await (await handler.fetch(new Request("http://runtime/ping"))).json()) as {
          status: string;
        };
        expect(pingAfter.status).toBe("Healthy");
      });
      const entries = await agent.sessions.entries(id);
      expect(JSON.stringify(entries.data)).toContain("woken-reply");
    } finally {
      vi.useRealTimers();
      await aws.close();
      await handler.close();
    }
  });

  it("answers an alarm 503 only when the failure passes by itself (so Scheduler retries), and 200 when a person must fix it", async () => {
    const dir = await fauxAgent("fa-agentcore-alarm-err-");
    const definition = await loadSourceDefinition(dir);
    const transient = agentCoreHandler(definition, {
      database: { url: "postgres://postgres@127.0.0.1:1/postgres" },
      root: dir,
      secrets: process.env,
      offline: true,
    });
    const broken = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      offline: true,
      values: async () => {
        throw new Error("the secret support cannot be read: ResourceNotFoundException");
      },
    });
    try {
      const retry = await transient.fetch(invocation(freshInstance(), { alarm: true }));
      expect(retry.status).toBe(503);
      const stop = await broken.fetch(invocation(freshInstance(), { alarm: true }));
      expect([stop.status, await stop.json()]).toEqual([
        200,
        { ok: false, error: "the secret support cannot be read: ResourceNotFoundException" },
      ]);
    } finally {
      await transient.close();
      await broken.close();
    }
  });

  it("re-arms existing and pre-configured instances after a deploy, keeps earlier active wakes, replaces past NONE schedules, and disables .deploy", async () => {
    const dir = await fauxAgent("fa-agentcore-rearm-", {
      "src/schedules/hourly.ts": `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 * * * *", tz: "UTC", prompt: "run hourly" });
`,
    });
    const definition = await loadSourceDefinition(dir);
    const dormant = freshInstance();
    const withEarlierWake = freshInstance();
    const withPastCompleted = freshInstance();
    const preconfigured = freshInstance();

    // Open `dormant`, `withEarlierWake` and `withPastCompleted` once so `durable_metadata` holds them for this agent.
    for (const sid of [dormant, withEarlierWake, withPastCompleted]) {
      const warm = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        offline: true,
      });
      await warm.fetch(invocation(sid, { request: { method: "GET", path: "/v1/agent", headers: {} } }));
      await warm.close();
    }

    const sched = fakeScheduler("alarms-group", "ENABLED");
    // Seed `withEarlierWake` at 10:20 (ahead of the 11:00 hourly slot), and `withPastCompleted` at 09:00 (in the past,
    // already completed under ActionAfterCompletion=NONE so it would never fire again on its own).
    const seed = (sid: string, expr: string) =>
      sched.schedules.set(alarmNameOf(sid), {
        Name: alarmNameOf(sid),
        GroupName: "alarms-group",
        ScheduleExpression: expr,
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "NONE",
        State: "ENABLED",
        Target: { Arn: universalTargetArn(), RoleArn: "arn:aws:iam::123456789012:role/alarm-role", Input: "{}" },
      });
    seed(withEarlierWake, "at(2026-11-18T10:20:00)");
    seed(withPastCompleted, "at(2026-11-18T09:00:00)");

    let clockNow = new Date("2026-11-18T10:05:00.000Z");
    const alarms = createAlarmGroup({
      group: "alarms-group",
      instances: [preconfigured],
      client: sched.client as never,
      now: () => clockNow,
    });
    const handler = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      offline: true,
      alarms,
    });
    try {
      // Only DEPLOY_SESSION_ID may run rearm.
      const wrongSession = await answered(await handler.fetch(invocation(dormant, { rearm: true })));
      expect([wrongSession.status, wrongSession.body.error.code]).toEqual([400, "invalid_request"]);

      const rearmed = await handler.fetch(invocation(DEPLOY_SESSION_ID, { rearm: true }));
      expect([rearmed.status, await rearmed.json()]).toEqual([200, { ok: true }]);

      expect(sched.schedules.get(alarmNameOf(dormant))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      expect(sched.schedules.get(alarmNameOf(preconfigured))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      expect(sched.schedules.get(alarmNameOf(withPastCompleted))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      // The earlier active 10:20 wake-up stays untouched.
      expect(sched.schedules.get(alarmNameOf(withEarlierWake))?.ScheduleExpression).toBe("at(2026-11-18T10:20:00)");
      // `.deploy` disabled itself once rearm succeeded.
      expect(sched.schedules.get(DEPLOY_SCHEDULE_NAME)?.State).toBe("DISABLED");

      // At 11:00:04, delivering the payload `.deploy` armed onto the never-before-opened `preconfigured` session
      // catches up the 11:00:00 cron slot (via `since`) and moves its alarm to 12:00:00.
      const payload = JSON.parse(
        (JSON.parse(sched.schedules.get(alarmNameOf(preconfigured))!.Target.Input) as { Payload: string }).Payload,
      ) as { alarm: boolean; since: string };
      vi.useFakeTimers({ toFake: ["Date", "performance"] });
      clockNow = new Date("2026-11-18T11:00:04.000Z");
      vi.setSystemTime(clockNow);
      const coldSession = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        offline: true,
        alarms,
      });
      // Simulate the process failing right after EventBridge records `at(12:00:00)`: `start({ since })` must have
      // ALREADY claimed the `11:00:00` slot before `setAlarm` ran, so moving the alarm forward never skips 11:00.
      let cutOffOnce = true;
      sched.onWritten((writtenName) => {
        if (cutOffOnce && writtenName === alarmNameOf(preconfigured)) {
          cutOffOnce = false;
          throw new Error("cut off after EventBridge stored 12:00:00");
        }
      });
      await coldSession.fetch(invocation(preconfigured, payload));
      sched.onWritten(undefined);
      await coldSession.close();
      expect(sched.schedules.get(alarmNameOf(preconfigured))?.ScheduleExpression).toBe("at(2026-11-18T12:00:00)");

      const checkSession = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        offline: true,
        alarms,
      });
      const aws = agentCore(checkSession);
      try {
        const preAgent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: preconfigured });
        await vi.waitFor(async () => {
          const states = await preAgent.schedules.list();
          expect(states[0]?.last?.slot).toBe("2026-11-18T11:00:00.000Z");
        });
      } finally {
        await aws.close();
        await checkSession.close();
      }
    } finally {
      vi.useRealTimers();
      await handler.close();
    }
  });

  it("drains a newer clock commit after a failed alarm write, and stops writing as soon as the harness begins closing", async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const clock = clockStore(harness, BACKGROUND_CONTEXT);
    let desired: Date | undefined = new Date("2026-11-18T10:00:00.000Z");
    const seen: Array<string | undefined> = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    const alarm = watchInstanceAlarm({
      harness,
      nextClockDue: async () => desired,
      setAlarm: async (at) => {
        attempts += 1;
        seen.push(at?.toISOString());
        if (attempts === 1) {
          await firstBlocked;
          throw new Error("ThrottlingException");
        }
      },
    });
    try {
      const first = alarm.sync();
      await vi.waitFor(() => expect(attempts).toBe(1));
      // While the first `setAlarm` is in flight, a clock commit clears `desired` (setting `dirty = true`), then the
      // first `setAlarm` fails: the queued `dirty` pass must still run and disarm (with `forceClear` preserved too).
      desired = undefined;
      void alarm.sync({ forceClear: true });
      await clock.wakeups(() => ({ next: [], result: undefined }));
      releaseFirst();
      await expect(first).rejects.toThrow("ThrottlingException");
      await vi.waitFor(() => expect(seen).toEqual(["2026-11-18T10:00:00.000Z", undefined]));
    } finally {
      alarm.stop();
      await harness.close(BACKGROUND_CONTEXT);
    }

    // Second half: `subscribeClose` fences an in-flight read synchronously when `harness.close()` begins.
    const closingHarness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readingStarted = false;
    const fencedWrites: Array<Date | undefined> = [];
    const fencedAlarm = watchInstanceAlarm({
      harness: closingHarness,
      nextClockDue: async () => {
        readingStarted = true;
        await readBlocked;
        return new Date("2026-11-18T18:00:00.000Z");
      },
      setAlarm: async (at) => {
        fencedWrites.push(at);
      },
    });
    const inFlightSync = fencedAlarm.sync();
    await vi.waitFor(() => expect(readingStarted).toBe(true));
    const closePromise = closingHarness.close(BACKGROUND_CONTEXT);
    releaseRead();
    await inFlightSync;
    await closePromise;
    expect(fencedWrites).toEqual([]);
  });

  it("lets a caught-up schedule call `wake` while the cold open's initial alarm write is still in flight", async () => {
    const dir = await fauxAgent("fa-agentcore-boot-wake-", {
      "fastagent.config.ts": `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
faux.setResponses(Array.from({ length: 10 }, () => (context) => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage("done");
  if (JSON.stringify(last?.content ?? "").includes("set-followup")) {
    return fauxAssistantMessage([fauxToolCall("wake", { in: "10m", prompt: "followup" })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
export default { model: "gw/m1", providers: [faux.provider] };
`,
      "src/schedules/hourly.ts": `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 * * * *", tz: "UTC", prompt: "set-followup" });
`,
    });
    const definition = await loadSourceDefinition(dir);
    const sched = fakeScheduler("alarms-group", "ENABLED");
    const sessionId = freshInstance();
    let delayFirstWrite = true;
    sched.onWritten(async (name) => {
      if (delayFirstWrite && name === alarmNameOf(sessionId)) {
        delayFirstWrite = false;
        await new Promise((r) => setTimeout(r, 150));
      }
    });
    const alarms = createAlarmGroup({ group: "alarms-group", client: sched.client as never });
    const handler = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      offline: true,
      alarms,
    });
    const aws = agentCore(handler);
    try {
      // `since` an hour ago guarantees `hourly` catches up immediately inside `serve()`, while `onWritten` holds
      // `serve()`'s initial `watcher.sync()` open for 150ms.
      const since = new Date(Date.now() - 65 * 60_000).toISOString();
      const res = await handler.fetch(invocation(sessionId, { alarm: true, since }));
      expect(res.status).toBe(200);
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId });
      await vi.waitFor(async () => expect(await agent.wakeups.list()).toHaveLength(1));
    } finally {
      sched.onWritten(undefined);
      await aws.close();
      await handler.close();
    }
  });
});
