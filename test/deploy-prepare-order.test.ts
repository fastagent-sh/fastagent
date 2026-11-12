/**
 * `deploy --run`'s order around preparing a Feishu/Lark app for webhook: preparing is its first change to anything, so
 * every refusal that touches nothing comes first. Read where it shows: what Feishu was asked (the app made), what the
 * host's CLI was asked and with which values, what the command said, what a ticket records. The pre-flight, the setup
 * and the host's driver are the real ones; Feishu, `fly` and the deployed box's /health are stand-ins at their edges.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";
import { besideAgent, buildable } from "./cli-run.ts";
import { type FeishuPlatform, feishuPlatform } from "./feishu-platform.ts";
import { hostCli, resetHostClis } from "./host-cli-double.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));
vi.mock("../src/git.ts", () => import("./git-double.ts"));
vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"));
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
let interactive = true;
// The person at the terminal: says yes when the deploy offers to set the values its file holds on the host.
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => true,
}));
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => interactive,
}));
const started: Record<string, unknown>[] = [];
vi.mock("../src/cli/ticket.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cli/ticket.ts")>();
  return {
    ...real,
    // The parent's start, recorded: the process it would start is this test's own child half, run below by hand.
    startTicket: async (input: Parameters<typeof real.startTicket>[0]) => {
      started.push(input as unknown as Record<string, unknown>);
      return { ...real.createTicket(input), status: "working" as const };
    },
  };
});
const { createTicket, checkTicket } = await import("../src/cli/ticket.ts");
const { runDeploy } = await import("../src/cli/commands/deploy.ts");

const stopped = new Error("deploy stopped");
/**
 * A channel that receives either way (webhook unless the configuration says not), its file's name what the setup is for,
 * reading the values its app's setup keeps.
 */
const channel = (kind: "FEISHU" | "LARK") => `const needs = (names, value) => ({
  kind: "fastagent.needs",
  secrets: names.map((name) => ({ name: "${kind}_" + name, optional: false })),
  build: () => value,
});
export default {
  kind: "fastagent.by-ingress",
  webhook: needs(["APP_ID", "APP_SECRET", "VERIFICATION_TOKEN"], () => ({})),
  connection: needs(["APP_ID", "APP_SECRET"], { name: "c", connect() {} }),
};
`;

let dir: string;
let said: string[];
let platform: FeishuPlatform;
/** Each call of `fly`: its command, whether Feishu had been asked by then, and the values the deploy was given. */
let fly: { args: string; input?: string; asked: boolean; values: string; finishing?: boolean }[];
let ticketOfRun: string | undefined;
/** The values a deploy is given, and where the credentials of the app it makes are kept. */
let keptIn: string;
const production = () => join(dir, ".secrets", "production", ".env");

/** The names the Fly app below already holds: all a deployment needs but the Verification Token a setup captures. */
const HELD = ["OPENAI_API_KEY", "FASTAGENT_API_KEY", "FEISHU_APP_ID", "FEISHU_APP_SECRET"];

/** Fly, for an account with no app yet, every call succeeding; the deployed box answers /health, its webhook registered. */
function flyAccount() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith(".fly.dev")) return real(input, init);
    return Response.json({ status: "ok", webhooks: [{ channel: "feishu", outcome: "registered" }] });
  });
  hostCli("fly", async ({ args, input }) => {
    fly.push({
      args: args.join(" "),
      ...(input === undefined ? {} : { input }),
      asked: platform.requests.length > 0,
      values: readFileSync(keptIn, "utf8"),
      ...(ticketOfRun === undefined ? {} : { finishing: (await checkTicket(ticketOfRun))?.finishing }),
    });
    if (args[0] === "secrets" && args[1] === "list") return { stdout: JSON.stringify(HELD.map((Name) => ({ Name }))) };
    if (args.includes("--json")) return { stdout: "[]" };
    return {};
  });
}

beforeEach(async () => {
  started.length = 0;
  fly = [];
  ticketOfRun = undefined;
  interactive = true;
  dir = join(await mkdtemp(join(tmpdir(), "fa-deploy-order-")), "fastagent");
  await mkdir(join(dir, "src", "channels"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), 'export default { defaults: { model: "openai/gpt-4o" } };\n');
  await writeFile(join(dir, "src", "channels", "feishu.ts"), channel("FEISHU"));
  await buildable(dir);
  // The development app's values, which a deployment never reads; and its key in production, which it does not either.
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_dev\n");
  await writeFile(production(), "FASTAGENT_API_KEY=k\n");
  keptIn = besideAgent(dir, "prod.env");
  await writeFile(keptIn, "OPENAI_API_KEY=sk\nFEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=sec\n");
  flyAccount();
  platform = feishuPlatform(undefined, async () => {
    if (ticketOfRun !== undefined) polledWhile = await checkTicket(ticketOfRun);
  });
  // Run from the agent directory, so the command a step names to run again is the plain one.
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  said = [];
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
  vi.spyOn(console, "log").mockImplementation((line) => void said.push(String(line)));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw stopped;
  });
});
afterEach(async () => {
  resetHostClis();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
let polledWhile: Awaited<ReturnType<typeof checkTicket>>;

const deploy = (host: "fly" | "docker", opts: Record<string, unknown>) => runDeploy(host, dir, opts);
const ended = (run: Promise<unknown>) =>
  run.then(
    () => "done",
    (error: unknown) => {
      if (error !== stopped) throw error;
      return "stopped";
    },
  );

it("prepares the app first, then hands the host the values the setup kept, never the development ones", async () => {
  await ended(deploy("fly", { run: true, envFile: keptIn }));
  // Nothing was asked of the host before the app was prepared: not even which names it holds.
  expect(fly.length).toBeGreaterThan(0);
  expect(fly.every((call) => call.asked)).toBe(true);
  // The app the values name is configured, its Verification Token captured into the file before the host is reached.
  expect(platform.requests).toContain("GET /open-apis/application/v6/applications/cli_1");
  expect(fly[0]?.values).toMatch(/^FEISHU_VERIFICATION_TOKEN=production_token$/m);
  // …and it is the token the host is given: the deploy reads its values again after the setup.
  const set = fly.find((call) => /^secrets set .*FEISHU_VERIFICATION_TOKEN=-$/.test(call.args));
  expect(set?.input).toBe("production_token");
  expect(fly.map((call) => `${call.args} ${call.input ?? ""}`).join("\n")).not.toContain("cli_dev");
  expect(said.join("\n")).toContain(`feishu: preparing the production app for webhook in ${keptIn}`);
});

it("plans as start, not dev, whatever spawned it: the channel receives by webhook, so its app is made for one", async () => {
  vi.stubEnv(DEV_SERVE_ENV, "1");
  await ended(deploy("fly", { run: true, envFile: keptIn }));
  expect(said.join("\n")).toContain("feishu: preparing the production app for webhook");
});

it("does not prepare an app a deployment cannot point anywhere, and says what it can do instead", async () => {
  await expect(deploy("docker", { run: true, envFile: keptIn })).rejects.toBe(stopped);
  expect(platform.requests).toEqual([]);
  expect(said.join("\n")).toMatch(
    /feishu receive by webhook here, and this Docker deployment has no public URL .*set up your own ingress.*channels\.feishu\.ingress to "connection" in the configuration --config delivers/,
  );
});

it("prepares only with a person: with nobody, it names the deploy that hands their part to a coding agent's user", async () => {
  interactive = false;
  await expect(deploy("fly", { run: true, envFile: keptIn })).rejects.toBe(stopped);
  expect(platform.requests).toEqual([]);
  expect(fly).toEqual([]);
  expect(said.join("\n")).toContain(
    "setting up the separate production app needs a person — run this deploy in a terminal; from a coding agent, " +
      `run \`fastagent deploy fly --env-file ${keptIn} --run --json\`, which hands their part to its user`,
  );

  interactive = true;
  said.length = 0;
  await expect(deploy("fly", { run: true, input: false, envFile: keptIn })).rejects.toBe(stopped);
  expect(platform.requests).toEqual([]);
  expect(said.join("\n")).toContain("fastagent deploy fly --env-file");
});

it("needs a file to keep the credentials of the app it makes in, since a deployment has no default one", async () => {
  await expect(deploy("fly", { run: true })).rejects.toBe(stopped);
  // Nothing was prepared, and the way to is named: the setup that makes the file, then this deploy with it.
  expect(platform.requests).toEqual([]);
  expect(fly).toEqual([]);
  const out = said.join("\n");
  expect(out).toContain(
    "are not in the values given to this deploy (--env-file or --from-env), so a production feishu app has to be made",
  );
  expect(out).toContain("`fastagent channels setup feishu --env-file <file>`");
  expect(out).toContain("deploy again with --env-file <file>");
});

it("creates an app when all production app values are absent, keeping its credentials in the file it is given", async () => {
  await writeFile(keptIn, "OPENAI_API_KEY=sk\n");
  await ended(deploy("fly", { run: true, envFile: keptIn }));
  expect(platform.created()).toBe(true);
  expect(await readFile(keptIn, "utf8")).toMatch(/^FEISHU_APP_ID=cli_production$/m);
  expect(process.env.FASTAGENT_ENVIRONMENT).toBe("production");
  // The development app's file is the development instance's: a deployment's setup writes nothing there.
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe("FEISHU_APP_ID=cli_dev\n");
});

it("generating a plan prepares nothing and reaches no host", async () => {
  await deploy("fly", {});
  expect(platform.requests).toEqual([]);
  expect(fly).toEqual([]);
});

it("a generated plan says the deployment serves the Agent API, and writes no key itself: the host mints it where it is set", async () => {
  await rm(production());
  await deploy("fly", {});
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");
  // A generate-only deploy has set nothing: it says how the key gets made, not that there is one.
  expect(said.join("\n")).toContain("Agent API:");
  expect(said.join("\n")).not.toContain("Agent API: not served");
});

it("says, when the values hold no key, that `invoke --url` is given one with --key: nothing of this machine's holds it", async () => {
  await ended(deploy("fly", { run: true, envFile: keptIn }));
  expect(said.join("\n")).toContain("holds none, so pass the key to `fastagent invoke --url` with --key");
});

it("a definition that turns the API off serves none, and says so", async () => {
  await writeFile(
    join(dir, "fastagent.config.ts"),
    'export default { defaults: { model: "openai/gpt-4o", http: { api: false } } };\n',
  );
  await rm(production());
  await deploy("fly", {});
  await expect(readFile(production(), "utf8")).rejects.toThrow("ENOENT");
  expect(said.join("\n")).toContain("Agent API: not served — the configuration says http.api: false");
});

it("a coding agent's deploy: refused here what can be, the rest started in a ticket it joins if one runs", async () => {
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(deploy("fly", { run: true, json: true })).rejects.toBe(stopped);
  // Only the read-only pre-flight ran here; preparing an app and deploying are the ticket's.
  expect(platform.requests).toEqual([]);
  expect(fly).toEqual([]);
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
  const report = JSON.parse(String(printed.mock.calls[0]?.[0]));
  expect(report).toMatchObject({
    status: "working",
    deployment: "fly",
    check_command: `fastagent deploy fly --check ${report.ticket} --json`,
  });
});

it("a coding agent's ticket re-runs the deploy with the sources it was given, so the child reads what the parent did", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(deploy("fly", { run: true, json: true, envFile: keptIn, fromEnv: true })).rejects.toBe(stopped);
  expect(started[0]).toMatchObject({
    restart: `fastagent deploy fly --env-file ${keptIn} --from-env --run`,
    command: { args: expect.arrayContaining(["--env-file", keptIn, "--from-env", "--run", "--json"]) },
  });
});

it("a coding agent's deploy needing a Lark app without its credentials takes them in the ticket, not in a file", async () => {
  await rm(join(dir, "src", "channels", "feishu.ts"));
  await writeFile(join(dir, "src", "channels", "lark.ts"), channel("LARK"));
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(deploy("fly", { run: true, json: true })).rejects.toBe(stopped);
  // The deploy is one ticket like any other: the person's page is a step of its run, and nothing is asked of them
  // first, in the agent's conversation or in a value file.
  expect(started).toHaveLength(1);
  const report = String(printed.mock.calls[0]?.[0]);
  expect(JSON.parse(report)).toMatchObject({ status: "working", deployment: "fly" });
  expect(report).not.toContain("value_file");
});

it("the ticket's run is the whole deploy: its user scans for the app, the host's work runs as finishing, and what the new app's values need is said", async () => {
  const { ticket } = createTicket({
    subject: `deploy:fly:${dir}`,
    action: "deploy the agent to fly",
    check: "fastagent deploy fly --check",
    restart: "fastagent deploy fly --run",
    timeoutSeconds: 60,
  });
  ticketOfRun = ticket;
  await writeFile(keptIn, "OPENAI_API_KEY=sk\n");
  await ended(deploy("fly", { run: true, json: true, ticket, envFile: keptIn }));
  // The person's part was the ticket's: the scan's address was there while Feishu waited on it.
  expect(polledWhile).toMatchObject({ status: "need_user_action", url: expect.stringContaining("user_code=AB-CD") });
  // The host's work runs as the step finishing: the person's deadline never cuts it halfway.
  expect(fly.length).toBeGreaterThan(0);
  expect(fly.every((call) => call.asked && call.finishing === true)).toBe(true);
  // Nobody at a terminal to say yes to setting the new app's values on the host: the ticket says how, from the file
  // that holds them, and nothing is set without it.
  expect(await checkTicket(ticket)).toMatchObject({
    status: "failed",
    message: expect.stringContaining(`fastagent secrets push fly --env-file ${keptIn}`),
  });
  expect(fly.some((call) => call.args.startsWith("secrets set"))).toBe(false);
});

it("a deploy refused inside its ticket fails the ticket with the reason, not just that it stopped", async () => {
  const { ticket } = createTicket({
    subject: `deploy:fly:${dir}`,
    action: "deploy the agent to fly",
    check: "fastagent deploy fly --check",
    restart: "fastagent deploy fly --run",
    timeoutSeconds: 60,
  });
  await expect(deploy("docker", { run: true, json: true, ticket, envFile: keptIn })).rejects.toBe(stopped);
  expect(await checkTicket(ticket)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("this Docker deployment has no public URL"),
  });
});
