import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dotEnvPath, loadDotEnv, loadEnvValues } from "../src/env.ts";
import { resolveSecretsDir, resolveStateRoot, selectAgentEnvironment } from "../src/paths.ts";
import { assertIndependentFeishuApps, onboardFeishuCloudApp } from "../src/cli/add-feishu.ts";
import { feishuAppAddons, feishuAppScopes } from "../src/channels/feishu/setup-mode.ts";
import { buildContextPaths } from "../src/deploy/build-context.ts";
import { registerFeishuApp } from "../src/channels/feishu/register-app.ts";
import { bootstrapFeishuVerificationToken } from "../src/channels/feishu/bootstrap-token.ts";
import { text, password } from "@clack/prompts";

vi.mock("../src/channels/feishu/register-app.ts", () => ({
  registerFeishuApp: vi.fn(async () => ({
    appId: "cli_production",
    appSecret: "production_secret",
    tenantBrand: "feishu",
  })),
}));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  password: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn() },
}));
vi.mock("../src/channels/feishu/bootstrap-token.ts", () => ({
  bootstrapFeishuVerificationToken: vi.fn(async () => "production_token"),
}));
let approved = true;
vi.mock("../src/channels/feishu/feishu-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/channels/feishu/feishu-api.ts")>()),
  createFeishuApi: () => ({
    listAppScopes: async () =>
      feishuAppScopes("webhook").map(({ request }) => ({
        name: request,
        type: "tenant",
        grantStatus: approved || request !== "application:application:patch" ? 1 : 0,
      })),
    verifyCredentials: async () => {},
    getAppConfig: async () => {
      if (!approved) throw new Error("awaiting tenant approval");
      return { verificationToken: "production_token" };
    },
  }),
}));

let dir: string;
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-environments-"));
  approved = true;
  vi.mocked(registerFeishuApp).mockClear();
  vi.mocked(bootstrapFeishuVerificationToken).mockClear();
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.stubEnv("FEISHU_APP_ID", undefined);
  vi.stubEnv("FEISHU_APP_SECRET", undefined);
  vi.stubEnv("FEISHU_VERIFICATION_TOKEN", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  await rm(dir, { recursive: true, force: true });
});

it("selects complete independent value files and onboarding state; explicit path overrides still win", () => {
  const env: NodeJS.ProcessEnv = {};
  selectAgentEnvironment("production", env);
  expect(dotEnvPath(dir, env)).toBe(join(dir, ".secrets", "production", ".env"));
  expect(resolveStateRoot(dir, env)).toBe(join(dir, ".state", "production"));
  env.FASTAGENT_SECRETS_DIR = "/external/secrets";
  env.FASTAGENT_STATE_DIR = "/external/state";
  expect(resolveSecretsDir(dir, env)).toBe("/external/secrets");
  expect(resolveStateRoot(dir, env)).toBe("/external/state");
  selectAgentEnvironment("dev", env);
  delete env.FASTAGENT_SECRETS_DIR;
  delete env.FASTAGENT_STATE_DIR;
  expect(dotEnvPath(dir, env)).toBe(join(dir, ".secrets", ".env"));
  expect(resolveStateRoot(dir, env)).toBe(join(dir, ".state"));
});

it("production never falls back to dev credentials when its file is absent", async () => {
  await mkdir(join(dir, ".secrets"));
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n");
  selectAgentEnvironment("production");
  loadDotEnv(dir);
  expect(process.env.FEISHU_APP_ID).toBeUndefined();
  expect(loadEnvValues(dotEnvPath(dir)).size).toBe(0);
});

it("refuses copying the dev app into production before any registration", async () => {
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_dev\nLARK_APP_ID=cli_lark_dev\n");
  selectAgentEnvironment("production");
  for (const [kind, name, value] of [
    ["feishu", "FEISHU_APP_ID", "cli_dev"],
    ["lark", "LARK_APP_ID", "cli_lark_dev"],
  ] as const) {
    expect(() => assertIndependentFeishuApps(dir, [kind], new Map([[name, value]]))).toThrow(/same app/);
    const credentials = `${name}=${value}\n${name.replace("_APP_ID", "_APP_SECRET")}=dev_secret\n`;
    await writeFile(dotEnvPath(dir), credentials);
    await expect(onboardFeishuCloudApp(dir, kind, "webhook")).rejects.toThrow(/same app/);
    expect(await readFile(dotEnvPath(dir), "utf8")).toBe(credentials);
  }
  expect(() =>
    assertIndependentFeishuApps(dir, ["feishu"], new Map([["FEISHU_APP_ID", "cli_production"]])),
  ).not.toThrow();
});

it.each(["fastagent add lark --env production", "fastagent deploy fly --run"])(
  "rejects a newly entered dev Lark app before webhook bootstrap (%s)",
  async (rerun) => {
    await mkdir(join(dir, ".secrets"));
    const dev = "LARK_APP_ID=cli_lark_dev\nLARK_APP_SECRET=dev_secret\n";
    await writeFile(join(dir, ".secrets", ".env"), dev);
    selectAgentEnvironment("production");
    vi.mocked(text).mockResolvedValue(" cli_lark_dev ");
    vi.mocked(password).mockResolvedValue("dev_secret");
    await expect(onboardFeishuCloudApp(dir, "lark", "webhook", rerun)).rejects.toThrow(/same app/);
    expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
    expect(loadEnvValues(dotEnvPath(dir)).size).toBe(0);
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe(dev);

    vi.mocked(text).mockResolvedValue("cli_lark_production");
    await expect(onboardFeishuCloudApp(dir, "lark", "webhook", rerun)).resolves.toMatchObject({
      LARK_APP_ID: "cli_lark_production",
      LARK_VERIFICATION_TOKEN: "production_token",
    });
    expect(bootstrapFeishuVerificationToken).toHaveBeenCalledOnce();
  },
);

it("scan-to-create requests webhook scopes, persists production credentials and resumes without creating another app", async () => {
  await mkdir(join(dir, ".secrets"));
  const dev = "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n";
  await writeFile(join(dir, ".secrets", ".env"), dev);
  selectAgentEnvironment("production");
  approved = false;
  await onboardFeishuCloudApp(dir, "feishu", "webhook", "fastagent deploy fly --run");
  expect(registerFeishuApp).toHaveBeenCalledWith(expect.objectContaining({ addons: feishuAppAddons("webhook") }));
  const values = loadEnvValues(dotEnvPath(dir));
  expect(values.get("FEISHU_APP_ID")).toBe("cli_production");
  expect(values.get("FEISHU_APP_SECRET")).toBe("production_secret");
  expect(values.get("FEISHU_VERIFICATION_TOKEN")).toBe("");
  expect((await stat(dotEnvPath(dir))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dir, ".secrets", "production", ".gitignore"), "utf8")).toContain("*");
  approved = true;
  await onboardFeishuCloudApp(dir, "feishu", "webhook", "fastagent deploy fly --run");
  expect(registerFeishuApp).toHaveBeenCalledOnce();
  expect(loadEnvValues(dotEnvPath(dir)).get("FEISHU_VERIFICATION_TOKEN")).toBe("production_token");
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe(dev);
});

it("checks both environments for secrets leaked by a kept Docker ignore file", async () => {
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_SECRET=dev\n");
  await writeFile(join(dir, ".secrets", "production", ".env"), "FEISHU_APP_SECRET=prod\n");
  selectAgentEnvironment("production");
  const paths = await buildContextPaths(dir, join(resolveSecretsDir(dir), "auth.json"));
  expect(paths.leakCandidates).toEqual(expect.arrayContaining([".secrets/.env", ".secrets/production/.env"]));
  expect(paths.machineryPaths).toContain(".secrets");
});
