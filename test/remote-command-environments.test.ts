import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDeploy } from "../src/cli/commands/deploy.ts";
import { runDestroy } from "../src/cli/commands/destroy.ts";
import { runLogs } from "../src/cli/commands/logs.ts";
import { runLogin } from "../src/cli/commands/login.ts";

const ports = vi.hoisted(() => ({ deploy: vi.fn(), shell: vi.fn(), logs: vi.fn(), destroy: vi.fn() }));
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));
vi.mock("../src/cli/box-login.ts", () => ({ loginOnBox: async () => undefined }));
vi.mock("../src/cli/commands/deploy/agentcore.ts", () => ({
  agentcoreHost: { deploy: ports.deploy, shell: ports.shell },
}));
vi.mock("../src/deploy/preflight.ts", () => ({
  preflightDeploy: async () => ({ ok: true, channels: [], messages: [], values: new Map() }),
}));
vi.mock("../src/deploy/runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploy/runner.ts")>()),
  awsRunner: () => ({}),
}));
vi.mock("../src/deploy/agentcore/logs.ts", () => ({ tailAgentcoreLogs: ports.logs }));
vi.mock("../src/deploy/agentcore/destroy.ts", () => ({ destroyAgentcoreDeployment: ports.destroy }));

let dir: string;
let reached: string[][];
const exited = new Error("process exited");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-remote-env-"));
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai/gpt-4o" };\n');
  await writeFile(join(dir, ".secrets", ".env"), "AWS_PROFILE=dev-account\nAWS_REGION=us-east-1\n");
  await writeFile(
    join(dir, ".secrets", "production", ".env"),
    "AWS_PROFILE=production-account\nAWS_REGION=us-west-2\n",
  );
  reached = [];
  const record = () => reached.push([process.env.AWS_PROFILE as string, process.env.AWS_REGION as string]);
  ports.deploy.mockImplementation(async () => {
    record();
  });
  ports.shell.mockImplementation(async () => {
    record();
    return {};
  });
  ports.logs.mockImplementation(async () => {
    record();
    return { ok: true };
  });
  ports.destroy.mockImplementation(async () => {
    record();
    return { ok: true, found: [], removed: [], kept: [] };
  });
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "dev");
  vi.stubEnv("FEISHU_INGRESS", "");
  vi.stubEnv("LARK_INGRESS", "");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it.each([false, true])(
  "remote commands reach deploy's account and region (explicit override: %s)",
  async (override) => {
    if (override) {
      const secrets = join(dir, "custom-secrets");
      await mkdir(secrets);
      await writeFile(join(secrets, ".env"), "AWS_PROFILE=custom-account\nAWS_REGION=eu-west-1\n");
      vi.stubEnv("FASTAGENT_SECRETS_DIR", secrets);
    }
    const expected = override ? ["custom-account", "eu-west-1"] : ["production-account", "us-west-2"];
    const commands = [
      () => runDeploy("agentcore", dir, { input: false }),
      () => runLogs("agentcore", dir, {}),
      () => runDestroy("agentcore", dir, { run: true }),
      () => runLogin("openai", { deployment: "agentcore" }),
    ];
    for (const [index, command] of commands.entries()) {
      vi.stubEnv("AWS_PROFILE", undefined);
      vi.stubEnv("AWS_REGION", undefined);
      vi.stubEnv("FASTAGENT_ENVIRONMENT", "dev");
      if (index === 3) await expect(command()).rejects.toBe(exited);
      else await command();
      expect(reached[index]).toEqual(expected);
      expect(process.env.FASTAGENT_ENVIRONMENT).toBe("production");
    }
  },
);
