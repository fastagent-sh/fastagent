import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTS, runDeploy } from "../src/cli/commands/deploy.ts";
import { dotEnvPath, loadEnvValues } from "../src/env.ts";
import { registerFeishuApp } from "../src/channels/feishu/register-app.ts";
import { createFeishuApi } from "../src/channels/feishu/feishu-api.ts";
import { feishuAppScopes } from "../src/channels/feishu/setup-mode.ts";

let changedIngress = false;

vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));
vi.mock("../src/deploy/preflight.ts", () => ({
  preflightDeploy: async ({ agentDir }: { agentDir: string }) => {
    const values = loadEnvValues(dotEnvPath(agentDir));
    const webhook = !changedIngress && values.get("FEISHU_INGRESS") !== "websocket";
    return {
      ok: true,
      messages: [],
      values,
      valueFile: dotEnvPath(agentDir),
      channels: [{ name: "feishu", ingress: webhook ? "webhook" : "long-connection" }],
      declaredSecrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", ...(webhook ? ["FEISHU_VERIFICATION_TOKEN"] : [])].map(
        (name) => ({ name, source: "channels/feishu.ts" }),
      ),
    };
  },
}));
vi.mock("../src/channels/feishu/register-app.ts", () => ({
  registerFeishuApp: vi.fn(async () => ({ appId: "cli_production", appSecret: "secret", tenantBrand: "feishu" })),
}));
vi.mock("../src/channels/feishu/feishu-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/channels/feishu/feishu-api.ts")>()),
  createFeishuApi: vi.fn(() => ({
    listAppScopes: async () =>
      feishuAppScopes("webhook").map(({ request }) => ({ name: request, type: "tenant", grantStatus: 1 })),
    getAppConfig: async () => ({ verificationToken: "production_token" }),
  })),
}));

let root: string;
let said: string[];
const stopped = new Error("process exit");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-host-validation-"));
  said = [];
  changedIngress = false;
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.stubEnv("FEISHU_INGRESS", undefined);
  vi.stubEnv("LARK_INGRESS", undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw stopped;
  });
  vi.spyOn(console, "error").mockImplementation((line) => {
    said.push(String(line));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function agent(name: string, content: string, relocated = false) {
  const dir = join(root, name);
  const secrets = relocated ? join(root, "relocated-secrets") : join(dir, ".secrets/production");
  await mkdir(secrets, { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai/gpt-4o" };\n');
  await writeFile(join(secrets, ".env"), content);
  if (relocated) vi.stubEnv("FASTAGENT_SECRETS_DIR", secrets);
  return { dir, file: join(secrets, ".env") };
}

it.each([
  {
    host: "agentcore",
    name: "agent",
    content: "FEISHU_INGRESS=websocket\n",
    relocated: false,
    error: "cannot run on AgentCore",
  },
  {
    host: "agentcore",
    name: "a".repeat(41),
    content: "",
    relocated: false,
    error: "exceed their limits past 40 chars",
  },
  { host: "docker", name: "agent", content: "", relocated: true, error: "generated Compose reads" },
  {
    host: "docker",
    name: "agent",
    content: "FEISHU_APP_ID=cli_existing\nFEISHU_APP_SECRET=secret\n",
    relocated: true,
    error: "generated Compose reads",
  },
] as const)(
  "refuses $host ($error) before creating or configuring an app",
  async ({ host, name, content, relocated, error }) => {
    const { dir, file } = await agent(name, content, relocated);
    await expect(runDeploy(host, dir, { run: true, tunnel: host === "docker" })).rejects.toBe(stopped);
    expect(registerFeishuApp).not.toHaveBeenCalled();
    expect(createFeishuApi).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(content);
    expect(said.join("\n")).toContain(error);
  },
);

it.each(["agentcore", "docker"] as const)("valid %s setup still onboards before deployment", async (host) => {
  const { dir } = await agent("agent", "");
  const deploy = vi.spyOn(HOSTS[host], "deploy").mockImplementation(async (ctx) => {
    expect(registerFeishuApp).toHaveBeenCalledOnce();
    expect(ctx.pre.values.get("FEISHU_APP_ID")).toBe("cli_production");
    expect(ctx.pre.values.get("FEISHU_VERIFICATION_TOKEN")).toBe("production_token");
  });
  await runDeploy(host, dir, { run: true, tunnel: host === "docker" });
  expect(deploy).toHaveBeenCalledOnce();
});

it("validates the refreshed channel facts after onboarding before handing off to the host", async () => {
  const { dir } = await agent("agent", "");
  vi.mocked(registerFeishuApp).mockImplementationOnce(async () => {
    changedIngress = true;
    return { appId: "cli_production", appSecret: "secret", tenantBrand: "feishu" };
  });
  const deploy = vi.spyOn(HOSTS.agentcore, "deploy").mockResolvedValue();
  await expect(runDeploy("agentcore", dir, { run: true })).rejects.toBe(stopped);
  expect(registerFeishuApp).toHaveBeenCalledOnce();
  expect(deploy).not.toHaveBeenCalled();
  expect(said.join("\n")).toContain("cannot run on AgentCore");
});

it.each(["agentcore", "docker"] as const)("generate-only %s still warns without onboarding", async (host) => {
  const { dir } = await agent("agent", host === "agentcore" ? "FEISHU_INGRESS=websocket\n" : "", host === "docker");
  const deploy = vi.spyOn(HOSTS[host], "deploy").mockResolvedValue();
  await runDeploy(host, dir, { tunnel: host === "docker" });
  expect(registerFeishuApp).not.toHaveBeenCalled();
  expect(createFeishuApi).not.toHaveBeenCalled();
  expect(deploy).toHaveBeenCalledOnce();
  expect(said.join("\n")).toContain("[fastagent] warn:");
});
