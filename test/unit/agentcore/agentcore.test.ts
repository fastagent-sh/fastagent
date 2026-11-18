import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectAgentCore } from "../../../packages/agentcore/src/client.ts";
import { DSQL_LIMITS, createIndexAsync, dsqlDatabase } from "../../../packages/agentcore/src/index.ts";
import { SESSION_HEADER, agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { secretValues } from "../../../packages/agentcore/src/secrets.ts";
import { Unavailable } from "../../../packages/fastagent/src/unavailable.ts";
import agentcorePackage from "../../../packages/agentcore/package.json" with { type: "json" };
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
      // A refusal keeps its code through AgentCore, which would have made a 404 its own 424.
      await expect(agent.sessions.get("no-such-session")).rejects.toMatchObject({ code: "not_found" });
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

describe("fastagent agentcore init", () => {
  it("writes the container and the AgentCore project, says what to create and how to deploy, and keeps the project after", async () => {
    const dir = await fauxAgent("fa-agentcore-init-", {
      "src/tools/ticket.ts": [
        `import { defineTool } from "@earendil-works/pi-durable";`,
        `import { obj } from "@earendil-works/pi-schema";`,
        `import { needs } from "@fastagent-sh/fastagent";`,
        `export default needs(["ZENDESK_TOKEN"], () => defineTool({ name: "ticket", description: "File a ticket.", parameters: obj({}), execute: async () => ({ output: [] }) }));`,
      ].join("\n"),
    });
    const first = await runInProcess(["agentcore", "init", "--no-install"], dir);
    expect(first.code, first.stderr).toBe(0);
    const name = basename(dir);
    expect(first.stdout).toContain(
      `aws secretsmanager create-secret --name ${name} --secret-string file://<values.json>`,
    );
    expect(first.stdout).toContain("npx -y @aws/agentcore@1.0.3 deploy");
    expect(first.stdout).toContain("ZENDESK_TOKEN, which its code declares");

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^# Generated by `fastagent agentcore init`/);
    expect(dockerfile).toContain('CMD ["./node_modules/.bin/fastagent", "agentcore", "start", "/app"]');
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
    const again = await runInProcess(["agentcore", "init", "--no-install"], dir);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).toContain("kept agentcore/ (yours once written)");
    expect(await readFile(join(dir, "agentcore", "agentcore.json"), "utf8")).toBe('{ "mine": true }\n');
  });

  it("refuses a flag of init's on another command, and a start with no build to serve", async () => {
    const dir = await fauxAgent("fa-agentcore-usage-");
    const flag = await runInProcess(["agentcore", "start", "--force"], dir);
    expect([flag.code, flag.stderr.split("\n")[0]]).toEqual([2, "Error: --force and --no-install are init's"]);
    // The one thing the container cannot serve without: the build it runs.
    const unbuilt = await runInProcess(["agentcore", "start"], dir);
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.stderr).toContain("holds no build");
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
