import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRuntimeSecrets, readSecretValues } from "../src/deploy/agentcore/runtime-secrets.ts";
import { agentcoreSecretStore } from "../src/deploy/agentcore/store.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

const NAME = "fastagent/bot";
const quiet = () => {};

/** Secrets Manager as the CLI shows it: one secret, or none; `put-secret-value` is read from its `file://` argument. */
function fakeSecretsManager(initial: string | undefined, over: { deleted?: boolean } = {}) {
  let value = initial;
  const calls: { args: string[]; input?: string }[] = [];
  const written: string[] = [];
  const runner: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const reply = (code: number, stdout = "", stderr = "") => ({
      code,
      stdout,
      stderr: opts?.captureStderr ? stderr : undefined,
    });
    const op = args[1];
    const notFound = reply(254, "", "An error occurred (ResourceNotFoundException) when calling the operation");
    if (op === "describe-secret") {
      if (value === undefined) return notFound;
      if (args.includes("ARN")) return reply(0, "arn:aws:secretsmanager:us-west-2:1:secret:fastagent/bot-AbCdEf\n");
      return reply(0, JSON.stringify({ Name: NAME, ...(over.deleted ? { DeletedDate: 1 } : {}) }));
    }
    if (op === "create-secret") {
      value = args[args.indexOf("--secret-string") + 1];
      return reply(0, "{}");
    }
    if (op === "get-secret-value") return value === undefined ? notFound : reply(0, `${value}\n`);
    if (op === "put-secret-value") {
      const file = (args[args.indexOf("--secret-string") + 1] as string).replace("file://", "");
      value = readFileSync(file, "utf8");
      written.push(file);
      return reply(0, '{"VersionId":"v"}');
    }
    return reply(1, "", `unexpected ${args.join(" ")}`);
  };
  return { runner, calls, written, current: () => value };
}

describe("agentcoreSecretStore", () => {
  it("lists the names a secret holds, and reads no value into what it says", async () => {
    const aws = fakeSecretsManager('{"A":"hunter2","B":"x"}');
    expect([...(await agentcoreSecretStore(aws.runner, NAME, quiet).names())]).toEqual(["A", "B"]);
  });

  it("an absent secret is not an error for `exists`, and `ensure` makes it empty", async () => {
    const aws = fakeSecretsManager(undefined);
    const store = agentcoreSecretStore(aws.runner, NAME, quiet);
    expect(await store.exists()).toBe(false);
    await store.ensure();
    expect(aws.current()).toBe("{}");
    expect(await store.exists()).toBe(true);
    const creates = aws.calls.filter((call) => call.args[1] === "create-secret");
    expect(creates).toHaveLength(1);
    await store.ensure();
    expect(aws.calls.filter((call) => call.args[1] === "create-secret")).toHaveLength(1);
  });

  it("a secret scheduled for deletion is refused with the command that brings it back", async () => {
    const aws = fakeSecretsManager("{}", { deleted: true });
    await expect(agentcoreSecretStore(aws.runner, NAME, quiet).exists()).rejects.toThrow(
      "restore-secret --secret-id fastagent/bot",
    );
  });

  it("writes by merging into what it holds, over a file and never argv, removing the file afterwards", async () => {
    const aws = fakeSecretsManager('{"KEEP":"1","A":"old"}');
    await agentcoreSecretStore(aws.runner, NAME, quiet).write({ A: 'new #"quoted"\nline', B: "2" });
    expect(JSON.parse(aws.current() as string)).toEqual({ KEEP: "1", A: 'new #"quoted"\nline', B: "2" });
    const put = aws.calls.find((call) => call.args[1] === "put-secret-value") as { args: string[] };
    expect(put.args.join(" ")).not.toContain("new #");
    expect(put.args.join(" ")).toMatch(/--secret-string file:\/\//);
    expect(() => readFileSync(aws.written[0] as string)).toThrow();
  });

  it("a secret that is not an object of strings is refused, quoting none of it", async () => {
    for (const bad of ["not json hunter2", '["hunter2"]', '{"A":1}']) {
      const aws = fakeSecretsManager(bad);
      const failure = await agentcoreSecretStore(aws.runner, NAME, quiet)
        .names()
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        );
      expect(failure?.message, bad).toContain(`the secret ${NAME}`);
      expect(failure?.message).not.toContain("hunter2");
    }
  });

  it("a failed write is an error and the next values are not lost silently", async () => {
    const aws = fakeSecretsManager("{}");
    const failing: CliRunner = async (args, opts) =>
      args[1] === "put-secret-value"
        ? { code: 254, stdout: "", stderr: opts?.captureStderr ? "AccessDeniedException" : undefined }
        : aws.runner(args, opts);
    await expect(agentcoreSecretStore(failing, NAME, quiet).write({ A: "a" })).rejects.toThrow("AccessDeniedException");
  });

  it("gives the ARN the stack takes", async () => {
    const aws = fakeSecretsManager("{}");
    expect(await agentcoreSecretStore(aws.runner, NAME, quiet).arn()).toBe(
      "arn:aws:secretsmanager:us-west-2:1:secret:fastagent/bot-AbCdEf",
    );
  });
});

const ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:fastagent/bot-AbCdEf";

/** The microVM's metadata service and Secrets Manager, as the container reaches them. */
function stubAws(secretString: string, over: { secretStatus?: number; roleStatus?: number } = {}) {
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers,
        body: init?.body as string | undefined,
      });
      const u = String(url);
      if (u.endsWith("/api/token")) return new Response("imds-token");
      if (u.endsWith("/security-credentials/")) return new Response("execution_role");
      if (u.endsWith("/security-credentials/execution_role")) {
        return over.roleStatus
          ? new Response("no", { status: over.roleStatus })
          : Response.json({ AccessKeyId: "AKIA", SecretAccessKey: "secret", Token: "session" });
      }
      if (u.startsWith("https://secretsmanager.")) {
        return over.secretStatus
          ? new Response('{"__type":"AccessDeniedException"}', { status: over.secretStatus })
          : Response.json({ SecretString: secretString });
      }
      throw new Error(`unexpected ${u}`);
    }),
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("the container's read of its secret", () => {
  it("signs GetSecretValue with the execution role's credentials, in the region the ARN names", async () => {
    const requests = stubAws('{"A":"1","B":"two"}');
    expect(await readSecretValues(ARN)).toEqual({ A: "1", B: "two" });
    const call = requests.find((r) => r.url.startsWith("https://secretsmanager."))!;
    expect(call.url).toBe("https://secretsmanager.ap-southeast-1.amazonaws.com/");
    expect(call.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(JSON.parse(call.body as string)).toEqual({ SecretId: ARN });
    const auth = Object.entries(call.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/ap-southeast-1\/secretsmanager\/aws4_request/);
    expect(Object.keys(call.headers).map((name) => name.toLowerCase())).toContain("x-amz-security-token");
    // IMDSv2: a token first, then the role, then its credentials.
    expect(requests.slice(0, 3).map((r) => r.method)).toEqual(["PUT", "GET", "GET"]);
    expect(requests[1]?.headers["x-aws-ec2-metadata-token"]).toBe("imds-token");
  });

  it("puts the values into the environment, except a name the platform already set", async () => {
    stubAws('{"A":"from-secret","B":"from-secret"}');
    const env: NodeJS.ProcessEnv = { FASTAGENT_SECRET_ARN: ARN, B: "platform" };
    await applyRuntimeSecrets(env);
    expect(env).toMatchObject({ A: "from-secret", B: "platform" });
  });

  it("does nothing, and asks nothing, without FASTAGENT_SECRET_ARN", async () => {
    const requests = stubAws("{}");
    const env: NodeJS.ProcessEnv = {};
    await applyRuntimeSecrets(env);
    expect(env).toEqual({});
    expect(requests).toEqual([]);
  });

  it("a refused read says where and why, and puts nothing into the environment", async () => {
    stubAws("{}", { secretStatus: 400 });
    const env: NodeJS.ProcessEnv = { FASTAGENT_SECRET_ARN: ARN };
    await expect(applyRuntimeSecrets(env)).rejects.toThrow(
      `could not read the deployment's values from ${ARN}: GetSecretValue answered 400: {"__type":"AccessDeniedException"}`,
    );
    expect(Object.keys(env)).toEqual(["FASTAGENT_SECRET_ARN"]);
  });

  it("credentials the metadata service will not give are a failure naming the request", async () => {
    stubAws("{}", { roleStatus: 404 });
    await expect(readSecretValues(ARN)).rejects.toThrow("security-credentials/execution_role answered 404");
  });

  it("a secret that is not an object of strings fails without quoting its text", async () => {
    for (const bad of ["not json hunter2", '["hunter2"]', '{"A":1}']) {
      stubAws(bad);
      const failure = await readSecretValues(ARN).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message, bad).toContain(ARN);
      expect(failure?.message).not.toContain("hunter2");
      vi.unstubAllGlobals();
    }
  });

  it("an ARN of another service is refused before any request", async () => {
    const requests = stubAws("{}");
    await expect(readSecretValues("arn:aws:s3:::bucket")).rejects.toThrow("not a Secrets Manager ARN");
    expect(requests).toEqual([]);
  });
});

describe("AgentCore's first invocation", () => {
  it("reads the deployment's values before it takes the storage, and a failed read stops there", async () => {
    const { prepareAgentcoreWorkspace } = await import("../src/cli/commands/start.ts");
    const saved = { arn: process.env.FASTAGENT_SECRET_ARN, name: process.env.SPIKE_VALUE };
    process.env.FASTAGENT_SECRET_ARN = ARN;
    try {
      stubAws('{"SPIKE_VALUE":"from-secret"}');
      expect(await prepareAgentcoreWorkspace("/agent")).toBe("/agent");
      expect(process.env.SPIKE_VALUE).toBe("from-secret");
      delete process.env.SPIKE_VALUE;

      stubAws("{}", { secretStatus: 400 });
      await expect(prepareAgentcoreWorkspace("/agent")).rejects.toThrow("could not read the deployment's values");
      expect(process.env.SPIKE_VALUE).toBeUndefined();
    } finally {
      if (saved.arn === undefined) delete process.env.FASTAGENT_SECRET_ARN;
      else process.env.FASTAGENT_SECRET_ARN = saved.arn;
      if (saved.name === undefined) delete process.env.SPIKE_VALUE;
      else process.env.SPIKE_VALUE = saved.name;
    }
  });
});
