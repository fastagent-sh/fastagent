/**
 * `deploy --run`'s order around preparing a Feishu/Lark app for webhook: preparing is its first change to anything,
 * so every refusal that touches nothing comes first. The pre-flight, the host driver and the preparation itself are
 * tested elsewhere; here they are stand-ins that record what reached them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

const calls: string[] = [];
let facts: { values: Map<string, string>; modelAuth?: string; channels?: { name: string; ingress: string }[] };
/** Who the last preparation was handed, and who the host's last deploy was. */
let preparedFor: unknown;
/** The file the last preparation was told to keep its credentials in. */
let preparedInto: string | undefined;
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
  loadSourceDefinition: async () => ({}),
}));
vi.mock("../src/harnesses/pi-durable/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/harnesses/pi-durable/config.ts")>()),
  resolveConfig: () => ({ settings: {}, sources: {}, ...config }),
}));
vi.mock("../src/harnesses/pi-durable/build.ts", () => ({ buildProject: async () => ({ warnings: [] }) }));
vi.mock("../src/deploy/preflight.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploy/preflight.ts")>()),
  // The values as a test sets them in `facts`: the real pre-flight reads this command's environment.
  preflightDeploy: async () => {
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
      values: new Map(facts.values),
      valuesFrom: "the environment",
      modelAuth: facts.modelAuth,
      declaredSecrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"].map((name) => ({
        name,
        source: "channels/feishu.ts",
      })),
    };
  },
}));
vi.mock("../src/cli/commands/deploy/channel-apps.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/commands/deploy/channel-apps.ts")>()),
  prepareChannelApps: async (_dir: string, file: string, apps: { kind: string }[], rerun: string, person: unknown) => {
    calls.push(`prepare ${apps.map(({ kind }) => kind).join(",")} rerun=${rerun}`);
    preparedInto = file;
    preparedFor = person;
    facts.values.set("FEISHU_APP_ID", "cli_production");
    facts.values.set("FEISHU_APP_SECRET", "production_secret");
    facts.values.set("FEISHU_VERIFICATION_TOKEN", "captured");
  },
}));
/** What each deploy the host received was told of the Agent API: whether it serves one, so whether the host mints a key. */
const apiSeen: unknown[] = [];
const deployed = vi.fn(
  async (ctx: { pre: { values: Map<string, string> }; answerer: { kind: string }; api: unknown }) => {
    calls.push(`host token=${ctx.pre.values.get("FEISHU_VERIFICATION_TOKEN") ?? "-"}`);
    if (throughTicket !== undefined) {
      const { checkTicket: read } = await import("../src/cli/ticket.ts");
      finishingAtHost = (await read(throughTicket))?.finishing;
    }
    apiSeen.push(ctx.api);
    answeredBy = ctx.answerer.kind;
    return "https://bot.fly.dev";
  },
);
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
// The contract of a host includes the manifest an earlier version wrote; these fakes have none.
const NO_LEGACY_MANIFEST = vi.hoisted(() => ({ file: "", generated: () => false, renamed: () => "" }));
vi.mock("../src/cli/commands/deploy/fly.ts", () => ({
  flyHost: { deploy: deployed, isOurs: () => true, legacyManifest: NO_LEGACY_MANIFEST },
}));
vi.mock("../src/cli/commands/deploy/docker.ts", () => ({
  dockerHost: { deploy: deployed, isOurs: () => true, legacyManifest: NO_LEGACY_MANIFEST },
}));
const { runDeploy } = await import("../src/cli/commands/deploy.ts");

let dir: string;
let said: string[];
const production = () => join(dir, ".secrets", "production", ".env");
/** Where a deploy keeps the credentials of the app it makes: a file named, since a deployment has no default one. */
const keptIn = () => join(dir, "prod.env");
beforeEach(async () => {
  calls.length = 0;
  apiSeen.length = 0;
  started.length = 0;
  preparedFor = undefined;
  preparedInto = undefined;
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

it("plans as start, not dev, whatever spawned it", async () => {
  vi.stubEnv(DEV_SERVE_ENV, "1");
  facts.values.set("FEISHU_VERIFICATION_TOKEN", "t");
  await runDeploy("fly", dir, { run: true });
  expect(calls).toEqual(["preflight dev=- token=t", "host token=t"]);
});

it("prepares the app without asking the target for other names: the host does that, once its app exists", async () => {
  facts.modelAuth = "OPENAI_API_KEY";
  await runDeploy("fly", dir, { run: true, envFile: keptIn() });
  expect(preparedInto).toBe(keptIn());
  expect(calls).toEqual([
    "preflight dev=- token=-",
    `prepare feishu rerun=fastagent deploy fly --env-file ${keptIn()} --run`,
    "preflight dev=- token=captured",
    "host token=captured",
  ]);
});

it("does not prepare an app a deployment cannot point anywhere, and says what it can do instead", async () => {
  await expect(runDeploy("docker", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toMatch(
    /feishu receive by webhook here, and this Docker deployment has no public URL .*set up your own ingress.*channels\.feishu\.ingress to "connection" in the configuration --config delivers/,
  );
});

it("prepares only with a person: with nobody, it names the deploy that hands their part to a coding agent's user", async () => {
  interactive = false;
  await expect(runDeploy("fly", dir, { run: true, envFile: keptIn() })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain(
    "setting up the separate production app needs a person — run this deploy in a terminal; from a coding agent, " +
      `run \`fastagent deploy fly --env-file ${keptIn()} --run --json\`, which hands their part to its user`,
  );

  interactive = true;
  calls.length = 0;
  said.length = 0;
  await expect(runDeploy("fly", dir, { run: true, input: false, envFile: keptIn() })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain("fastagent deploy fly --env-file");
});

it("needs a file to keep the credentials of the app it makes in, since a deployment has no default one", async () => {
  facts.values.clear();
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  // Nothing was prepared, and the way to is named: the setup that makes the file, then this deploy with it.
  expect(calls).toEqual(["preflight dev=- token=-"]);
  const out = said.join("\n");
  expect(out).toContain("are not in the environment, so a production feishu app has to be made");
  expect(out).toContain("`fastagent channels setup feishu --env-file <file>`");
  expect(out).toContain("deploy again with --env-file <file>");
});

it("creates an app when all production app values are absent, instead of gating on values onboarding supplies", async () => {
  facts.values.clear();
  await runDeploy("fly", dir, { run: true, envFile: keptIn() });
  expect(calls).toContain(`prepare feishu rerun=fastagent deploy fly --env-file ${keptIn()} --run`);
  expect(facts.values.get("FEISHU_APP_ID")).toBe("cli_production");
  expect(process.env.FASTAGENT_ENVIRONMENT).toBe("production");
});

it("generating a plan prepares nothing", async () => {
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
});

it("tells the host the deployment serves the Agent API, and writes no key itself: the host mints it where it is set", async () => {
  await rm(production());
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
  expect(apiSeen).toEqual([{ served: true }]);
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");
  // A generate-only deploy has set nothing: it says how the key gets made, not that there is one.
  expect(said.join("\n")).toContain("Agent API:");
});

it("says, when the values hold no key, that `invoke --url` is given one with --key: nothing of this machine's holds it", async () => {
  await runDeploy("fly", dir, { run: true, envFile: keptIn() });
  expect(said.join("\n")).toContain(
    "the environment holds none, so pass the key to `fastagent invoke --url` with --key",
  );
});

it("tells the host a definition that turns the API off serves none, and says so", async () => {
  config = { http: { api: false } };
  await rm(production());
  await runDeploy("fly", dir, {});
  expect(apiSeen).toEqual([{ served: false, why: expect.stringContaining("http.api: false") }]);
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");
  expect(said.join("\n")).toContain("Agent API: not served — the configuration says http.api: false");
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

it("a coding agent's deploy needing a Lark app without its credentials takes them in the ticket, not in a file", async () => {
  facts.channels = [{ name: "lark", ingress: "webhook" }];
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(runDeploy("fly", dir, { run: true, json: true })).rejects.toBe(stopped);
  // The deploy is one ticket like any other: the person's page is a step of its run (add-lark-page.test.ts), and nothing
  // is asked of them first, in the agent's conversation or in a value file.
  expect(started).toHaveLength(1);
  const report = String(printed.mock.calls[0]?.[0]);
  expect(JSON.parse(report)).toMatchObject({ status: "working", deployment: "fly" });
  expect(report).not.toContain("value_file");
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
  // The key is in the values this deploy was given, so the report can say how to check the API with it.
  facts.values.set("FASTAGENT_API_KEY", "k");
  await expect(runDeploy("fly", dir, { run: true, json: true, ticket, envFile: keptIn() })).rejects.toBe(stopped);
  // Taken before the pre-flight's seconds, so the starting command never finds it unclaimed.
  expect(statusAtPreflight).toBe("working");
  // The host's work runs as the step finishing: the person's deadline never cuts it halfway.
  expect(finishingAtHost).toBe(true);
  expect(calls).toEqual([
    "preflight dev=- token=-",
    `prepare feishu rerun=fastagent deploy fly --env-file ${keptIn()} --run --json`,
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
  const { ticket } = createTicket({
    subject: `deploy:fly:${dir}`,
    action: "deploy the agent to fly",
    check: "fastagent deploy fly --check",
    restart: "fastagent deploy fly --run",
    timeoutSeconds: 60,
  });
  await expect(runDeploy("docker", dir, { run: true, json: true, ticket })).rejects.toBe(stopped);
  expect(await checkTicket(ticket)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("this Docker deployment has no public URL"),
  });
});
