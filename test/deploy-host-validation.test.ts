import { buildable } from "./cli-run.ts";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDeploy } from "../src/cli/commands/deploy.ts";
import { loadEnvValues } from "../src/value-file.ts";
import { type FeishuPlatform, feishuPlatform } from "./feishu-platform.ts";
import { hostCli, resetHostClis } from "./host-cli-double.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));
vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"));
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));

/** Feishu, where the app is created, and the host's CLI, where the deploy is handed off: what each saw, in order. */
let platform: FeishuPlatform;
let atHost: { created: boolean; values: string }[];
function host(bin: "aws" | "docker") {
  hostCli(bin, () => {
    atHost.push({ created: platform.created(), values: readFileSync(valueFile, "utf8") });
    return { code: 1, stderr: `${bin} refuses\n` };
  });
}

let root: string;
let said: string[];
const stopped = new Error("process exit");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-host-validation-"));
  said = [];
  atHost = [];
  platform = feishuPlatform();
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw stopped;
  });
  vi.spyOn(console, "error").mockImplementation((line) => {
    said.push(String(line));
  });
});
afterEach(async () => {
  resetHostClis();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** The file a deployment's credentials are kept in: a deployment has no default one, so each run names it. */
let valueFile: string;

async function agent(name: string, content: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), 'export default { defaults: { model: "openai/gpt-4o" } };\n');
  // A channel that receives either way, for a configuration to name; the pre-flight is this file's.
  await mkdir(join(dir, "src", "channels"), { recursive: true });
  await writeFile(
    join(dir, "src", "channels", "feishu.ts"),
    'export default { kind: "fastagent.by-ingress", webhook: () => ({}), connection: { name: "f", connect() {} } };\n',
  );
  await buildable(dir);
  valueFile = join(root, `${name}.env`);
  await writeFile(valueFile, content);
  return { dir, file: valueFile };
}

/** The configuration a deployment delivers that has the Feishu channel receive by WebSocket. */
async function connectionConfig(): Promise<string> {
  const file = join(root, "websocket.json");
  await writeFile(file, JSON.stringify({ channels: { feishu: { ingress: "connection" } } }));
  return file;
}

it.each([
  {
    host: "agentcore",
    name: "agent",
    content: "",
    connection: true,
    error: "cannot run on AgentCore",
  },
  {
    host: "agentcore",
    name: "a".repeat(41),
    content: "",
    error: "exceed their limits past 40 chars",
  },
] as const)(
  "refuses $host ($error) before creating or configuring an app",
  async ({ host: target, name, content, error, ...rest }) => {
    const { dir, file } = await agent(name, content);
    host("aws");
    const config = "connection" in rest ? { config: await connectionConfig() } : {};
    await expect(runDeploy(target, dir, { run: true, envFile: file, ...config })).rejects.toBe(stopped);
    expect(platform.requests).toEqual([]);
    expect(atHost).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect(said.join("\n")).toContain(error);
  },
);

it("a valid AgentCore setup onboards before the deploy reaches the host", async () => {
  const { dir } = await agent("agent", "");
  host("aws");
  await expect(runDeploy("agentcore", dir, { run: true, envFile: valueFile })).rejects.toBe(stopped);
  expect(atHost[0]?.created).toBe(true);
  expect(loadEnvValues(valueFile).get("FEISHU_APP_ID")).toBe("cli_production");
  expect(atHost[0]?.values).toMatch(/^FEISHU_APP_ID=cli_production$/m);
  expect(atHost[0]?.values).toMatch(/^FEISHU_VERIFICATION_TOKEN=production_token$/m);
});

it("a valid Docker setup (a channel that connects out) onboards before the deploy reaches the host", async () => {
  const { dir } = await agent("agent", "");
  host("docker");
  await expect(
    runDeploy("docker", dir, { run: true, envFile: valueFile, config: await connectionConfig() }),
  ).rejects.toBe(stopped);
  expect(atHost[0]?.created).toBe(true);
  expect(atHost[0]?.values).toMatch(/^FEISHU_APP_ID=cli_production$/m);
});

it("generate-only agentcore still warns without onboarding", async () => {
  const { dir } = await agent("agent", "");
  host("aws");
  await runDeploy("agentcore", dir, { config: await connectionConfig() });
  expect(platform.requests).toEqual([]);
  expect(atHost).toEqual([]);
  expect(said.join("\n")).toContain("[fastagent] warn:");
});
