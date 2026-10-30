/**
 * `deploy --run`'s order around preparing a Feishu/Lark app for webhook: preparing is its first change to anything,
 * so every refusal that touches nothing comes first. The pre-flight, the host driver and the preparation itself are
 * tested elsewhere; here they are stand-ins that record what reached them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dotEnvPath, loadEnvValues } from "../src/env.ts";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

const calls: string[] = [];
let facts: { values: Map<string, string>; modelAuth?: string; channels?: { name: string; ingress: string }[] };
/** Who the last preparation was handed, and who the host's last deploy was. */
let preparedFor: unknown;
/** The ticket a test runs the deploy through, and its status when the pre-flight first ran. */
let throughTicket: string | undefined;
let statusAtPreflight: string | undefined;
let finishingAtHost: boolean | undefined;
let answeredBy: string | undefined;
const stopped = new Error("deploy stopped");

let interactive = true;
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  enterAgentDirectory: async (dir: string) => ({ agentDir: dir }),
  isInteractive: () => interactive,
}));
let config: Record<string, unknown> = {};
vi.mock("../src/harnesses/pi-durable/open.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/harnesses/pi-durable/open.ts")>()),
  loadConfig: async () => config,
}));
vi.mock("../src/deploy/preflight.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploy/preflight.ts")>()),
  // The values as the real pre-flight reads them, the selected value file, over what a test sets in `facts`.
  preflightDeploy: async ({ agentDir }: { agentDir: string }) => {
    if (throughTicket !== undefined && statusAtPreflight === undefined) {
      const { checkTicket: read } = await import("../src/cli/ticket.ts");
      statusAtPreflight = (await read(throughTicket))?.status;
    }
    calls.push(
      `preflight dev=${process.env[DEV_SERVE_ENV] ?? "-"} token=${facts.values.get("FEISHU_VERIFICATION_TOKEN") ?? "-"}`,
    );
    return {
      ok: true,
      messages: [],
      channels: facts.channels ?? [{ name: "feishu", ingress: "webhook" }],
      values: new Map([...loadEnvValues(dotEnvPath(agentDir)), ...facts.values]),
      valueFile: ".secrets/production/.env",
      modelAuth: facts.modelAuth,
      declaredSecrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"].map((name) => ({
        name,
        source: "channels/feishu.ts",
      })),
    };
  },
}));
vi.mock("../src/cli/add-feishu.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/add-feishu.ts")>()),
  prepareFeishuApps: async (_dir: string, apps: { kind: string }[], rerun: string, person: unknown) => {
    calls.push(`prepare ${apps.map(({ kind }) => kind).join(",")} rerun=${rerun}`);
    preparedFor = person;
    facts.values.set("FEISHU_APP_ID", "cli_production");
    facts.values.set("FEISHU_APP_SECRET", "production_secret");
    facts.values.set("FEISHU_VERIFICATION_TOKEN", "captured");
  },
}));
/** Whether each deploy the host received carries the Agent API's key: what it would set on the host. */
const carriedKey: boolean[] = [];
const deployed = vi.fn(async (ctx: { pre: { values: Map<string, string> }; answerer: { kind: string } }) => {
  calls.push(`host token=${ctx.pre.values.get("FEISHU_VERIFICATION_TOKEN") ?? "-"}`);
  if (throughTicket !== undefined) {
    const { checkTicket: read } = await import("../src/cli/ticket.ts");
    finishingAtHost = (await read(throughTicket))?.finishing;
  }
  carriedKey.push(ctx.pre.values.has("FASTAGENT_API_KEY"));
  answeredBy = ctx.answerer.kind;
  return "https://bot.fly.dev";
});
const started: Record<string, unknown>[] = [];
vi.mock("../src/cli/ticket.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/ticket.ts")>()),
  // The parent's start, recorded: the process it would start is this test's own child half, run below by hand.
  startTicket: async (input: Record<string, unknown>) => {
    started.push(input);
    return {
      ticket: "0123456789abcdef",
      status: "working",
      expiresAt: Date.now() + 60_000,
      check: input.check,
      fields: input.fields,
    };
  },
}));
const { createTicket, checkTicket } = await import("../src/cli/ticket.ts");
const { terminalPerson } = await import("../src/cli/person.ts");
vi.mock("../src/cli/commands/deploy/fly.ts", () => ({ flyHost: { deploy: deployed, isOurs: () => true } }));
vi.mock("../src/cli/commands/deploy/docker.ts", () => ({ dockerHost: { deploy: deployed, isOurs: () => true } }));
const { runDeploy } = await import("../src/cli/commands/deploy.ts");

let dir: string;
let said: string[];
const production = () => join(dir, ".secrets", "production", ".env");
beforeEach(async () => {
  calls.length = 0;
  carriedKey.length = 0;
  started.length = 0;
  preparedFor = undefined;
  throughTicket = undefined;
  statusAtPreflight = undefined;
  finishingAtHost = undefined;
  answeredBy = undefined;
  interactive = true;
  facts = {
    values: new Map([
      ["FEISHU_APP_ID", "cli_1"],
      ["FEISHU_APP_SECRET", "sec"],
    ]),
  };
  dir = join(await mkdtemp(join(tmpdir(), "fa-deploy-order-")), "fastagent");
  // Run from the agent directory, so the command a step names to run again is the plain one.
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_dev\n");
  // Its key given, so the cases below are about preparing an app; the key's own order is the last cases'.
  await writeFile(production(), "FASTAGENT_API_KEY=k\n");
  config = {};
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.stubEnv("FEISHU_INGRESS", "");
  vi.stubEnv("LARK_INGRESS", "");
  said = [];
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw stopped;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it("refuses before anything when this shell names an ingress the value file does not, and plans as start, not dev", async () => {
  vi.stubEnv("FEISHU_INGRESS", "websocket");
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual([]);
  expect(said.join("\n")).toContain('FEISHU_INGRESS is "websocket" here and "" in .secrets/production/.env');

  vi.stubEnv("FEISHU_INGRESS", "");
  vi.stubEnv(DEV_SERVE_ENV, "1");
  facts.values.set("FEISHU_VERIFICATION_TOKEN", "t");
  await runDeploy("fly", dir, { run: true });
  expect(calls).toEqual(["preflight dev=- token=t", "host token=t"]);
});

it("prepares only once every other value is there, then plans again with what preparing wrote", async () => {
  facts.modelAuth = "OPENAI_API_KEY";
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain("no value for: OPENAI_API_KEY");

  calls.length = 0;
  facts.values.set("OPENAI_API_KEY", "sk");
  await runDeploy("fly", dir, { run: true });
  expect(calls).toEqual([
    "preflight dev=- token=-",
    "prepare feishu rerun=fastagent deploy fly --run",
    "preflight dev=- token=captured",
    "host token=captured",
  ]);
});

it("does not prepare an app a deployment cannot point anywhere, and says what it can do instead", async () => {
  await expect(runDeploy("docker", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toMatch(
    /feishu receive by webhook here, and this Docker deployment has no public URL .*--tunnel.*FEISHU_INGRESS=websocket/,
  );

  calls.length = 0;
  await runDeploy("docker", dir, { run: true, tunnel: true });
  expect(calls).toContain("prepare feishu rerun=fastagent deploy docker --tunnel --run");
});

it("prepares only with a person: with nobody, it names the deploy that hands their part to a coding agent's user", async () => {
  interactive = false;
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain(
    "setting up the separate production app needs a person — run this deploy in a terminal; from a coding agent, " +
      "run `fastagent deploy fly --run --json`, which hands their part to its user",
  );

  interactive = true;
  calls.length = 0;
  said.length = 0;
  await expect(runDeploy("fly", dir, { run: true, input: false })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain("fastagent deploy fly --run --json");
});

it("creates an app when all production app values are absent, instead of gating on values onboarding supplies", async () => {
  facts.values.clear();
  await runDeploy("fly", dir, { run: true });
  expect(calls).toContain("prepare feishu rerun=fastagent deploy fly --run");
  expect(facts.values.get("FEISHU_APP_ID")).toBe("cli_production");
  expect(process.env.FASTAGENT_ENVIRONMENT).toBe("production");
});

it("generating a plan prepares nothing", async () => {
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
});

it("gives a deployment its API key once nothing refuses it, and plans again so that it carries the key", async () => {
  await rm(production());
  facts.modelAuth = "OPENAI_API_KEY";
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");

  calls.length = 0;
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "preflight dev=- token=-", "host token=-"]);
  expect(carriedKey).toEqual([true]);
  expect(await readFile(production(), "utf8")).toMatch(/^FASTAGENT_API_KEY=[\w-]{43}$/m);
  expect(said.join("\n")).toContain("Agent API: generated FASTAGENT_API_KEY in .secrets/production/.env");

  // Given once, kept: the next deploy plans once.
  const given = await readFile(production(), "utf8");
  calls.length = 0;
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
  expect(await readFile(production(), "utf8")).toBe(given);
});

it("says so when the key went into a secrets directory of the operator's that git may track", async () => {
  const secrets = await mkdtemp(join(tmpdir(), "fa-deploy-secrets-"));
  vi.stubEnv("FASTAGENT_SECRETS_DIR", secrets);
  await runDeploy("fly", dir, {});
  expect(carriedKey).toEqual([true]);
  expect(said.join("\n")).toContain(
    `note: ${secrets} (FASTAGENT_SECRETS_DIR) now holds a secret and has no .gitignore`,
  );
  await rm(secrets, { recursive: true, force: true });
});

it("gives no key to a definition that turns the API off, and says the deployment serves none", async () => {
  config = { http: { api: false } };
  await rm(production());
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");
  expect(said.join("\n")).toContain("Agent API: not served — fastagent.config.ts says http.api: false");
});

it("a coding agent's deploy: refused here what can be, the rest started in a ticket it joins if one runs", async () => {
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(runDeploy("fly", dir, { run: true, json: true })).rejects.toBe(stopped);
  // Only the read-only pre-flight ran here; preparing an app and deploying are the ticket's.
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(started).toEqual([
    expect.objectContaining({
      subject: `deploy:fly:${dir}`,
      check: "fastagent deploy fly --check",
      restart: "fastagent deploy fly --run",
      whenRunning: "join",
      waitsFirst: false,
      command: expect.objectContaining({ args: expect.arrayContaining(["deploy", "fly", dir, "--run", "--json"]) }),
    }),
  ]);
  expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({
    status: "working",
    deployment: "fly",
    check_command: "fastagent deploy fly --check 0123456789abcdef --json",
  });
});

it("a coding agent's deploy needing a Lark app without its credentials names them before any ticket", async () => {
  facts.channels = [{ name: "lark", ingress: "webhook" }];
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(runDeploy("fly", dir, { run: true, json: true })).rejects.toBe(stopped);
  expect(started).toEqual([]);
  expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({
    status: "need_user_action",
    variables: ["LARK_APP_ID", "LARK_APP_SECRET"],
    value_file: production(),
    check_command: "fastagent deploy fly --run --json",
  });
});

it("the ticket's run is the whole deploy, each person's step its user's, its result the URL and the API's notes", async () => {
  const { ticket } = createTicket({
    subject: `deploy:fly:${dir}`,
    action: "deploy the agent to fly",
    check: "fastagent deploy fly --check",
    restart: "fastagent deploy fly --run",
    timeoutSeconds: 60,
  });
  throughTicket = ticket;
  await expect(runDeploy("fly", dir, { run: true, json: true, ticket })).rejects.toBe(stopped);
  // Taken before the pre-flight's seconds, so the starting command never finds it unclaimed.
  expect(statusAtPreflight).toBe("working");
  // The host's work runs as the step finishing: the person's deadline never cuts it halfway.
  expect(finishingAtHost).toBe(true);
  expect(calls).toEqual([
    "preflight dev=- token=-",
    "prepare feishu rerun=fastagent deploy fly --run --json",
    "preflight dev=- token=captured",
    "host token=captured",
  ]);
  expect(preparedFor).toBeDefined();
  expect(preparedFor).not.toBe(terminalPerson);
  expect(answeredBy).toBe("ticket");
  expect(await checkTicket(ticket)).toMatchObject({
    status: "done",
    result: {
      url: "https://bot.fly.dev",
      notes: expect.arrayContaining([expect.stringContaining("fastagent invoke --url https://bot.fly.dev")]),
    },
  });
});

it("a deploy refused inside its ticket fails the ticket with the reason, not just that it stopped", async () => {
  facts.modelAuth = "OPENAI_API_KEY";
  const { ticket } = createTicket({
    subject: `deploy:fly:${dir}`,
    action: "deploy the agent to fly",
    check: "fastagent deploy fly --check",
    restart: "fastagent deploy fly --run",
    timeoutSeconds: 60,
  });
  await expect(runDeploy("fly", dir, { run: true, json: true, ticket })).rejects.toBe(stopped);
  expect(await checkTicket(ticket)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("no value for: OPENAI_API_KEY"),
  });
});
