/**
 * `deploy --run`'s order around preparing a Feishu/Lark app for webhook: preparing is its first change to anything,
 * so every refusal that touches nothing comes first. The pre-flight, the host driver and the preparation itself are
 * tested elsewhere; here they are stand-ins that record what reached them.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

const calls: string[] = [];
let facts: { values: Map<string, string>; modelAuth?: string };
const stopped = new Error("deploy stopped");

let interactive = true;
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  enterAgentDirectory: async (dir: string) => ({ agentDir: dir }),
  isInteractive: () => interactive,
}));
vi.mock("../src/engines/pi/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engines/pi/config.ts")>()),
  loadConfig: async () => ({ config: {} }),
}));
vi.mock("../src/deploy/preflight.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploy/preflight.ts")>()),
  preflightDeploy: async () => {
    calls.push(
      `preflight dev=${process.env[DEV_SERVE_ENV] ?? "-"} token=${facts.values.get("FEISHU_VERIFICATION_TOKEN") ?? "-"}`,
    );
    return {
      ok: true,
      messages: [],
      channels: [{ name: "feishu", ingress: "webhook" }],
      values: new Map(facts.values),
      valueFile: ".secrets/.env",
      modelAuth: facts.modelAuth,
      declaredSecrets: [{ name: "FEISHU_VERIFICATION_TOKEN", source: "channels/feishu.ts" }],
    };
  },
}));
vi.mock("../src/cli/add-feishu.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/add-feishu.ts")>()),
  prepareWebhookApps: async (_dir: string, kinds: string[], rerun: string) => {
    calls.push(`prepare ${kinds.join(",")} rerun=${rerun}`);
    facts.values.set("FEISHU_VERIFICATION_TOKEN", "captured");
  },
}));
const deployed = vi.fn(async (ctx: { pre: { values: Map<string, string> } }) => {
  calls.push(`host token=${ctx.pre.values.get("FEISHU_VERIFICATION_TOKEN") ?? "-"}`);
});
vi.mock("../src/cli/commands/deploy/fly.ts", () => ({ flyHost: { deploy: deployed, isOurs: () => true } }));
vi.mock("../src/cli/commands/deploy/docker.ts", () => ({ dockerHost: { deploy: deployed, isOurs: () => true } }));
const { runDeploy } = await import("../src/cli/commands/deploy.ts");

let dir: string;
let said: string[];
beforeEach(async () => {
  calls.length = 0;
  interactive = true;
  facts = { values: new Map([["FEISHU_APP_ID", "cli_1"]]) };
  dir = join(await mkdtemp(join(tmpdir(), "fa-deploy-order-")), "fastagent");
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_1\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
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
  expect(said.join("\n")).toContain('FEISHU_INGRESS is "websocket" here and "" in .secrets/.env');

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
  expect(calls).toContain("prepare feishu rerun=fastagent deploy docker --run");
});

it("prepares only from a terminal: unattended, it says how to supply the token instead", async () => {
  interactive = false;
  await expect(runDeploy("fly", dir, { run: true })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain(
    "preparing the app opens console pages and may ask for values, so it needs a terminal — run this deploy in one, " +
      "or copy FEISHU_VERIFICATION_TOKEN from the console (Events & Callbacks) into .secrets/.env",
  );

  interactive = true;
  calls.length = 0;
  said.length = 0;
  await expect(runDeploy("fly", dir, { run: true, input: false })).rejects.toBe(stopped);
  expect(calls).toEqual(["preflight dev=- token=-"]);
  expect(said.join("\n")).toContain("run this deploy in one without --no-input");
});

it("generating a plan prepares nothing", async () => {
  await runDeploy("fly", dir, {});
  expect(calls).toEqual(["preflight dev=- token=-", "host token=-"]);
});
