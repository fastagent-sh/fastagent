import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadDotEnv } from "../src/env.ts";
import { dotEnvPath, loadEnvValues } from "../src/value-file.ts";
import { resolveSecretsDir, resolveStateRoot, selectAgentEnvironment } from "../src/paths.ts";
import { setUpChannel } from "../src/cli/channel-setup.ts";
import { feishuAppAddons, feishuAppScopes } from "../src/channels/feishu/setup-mode.ts";
import { buildContextPaths } from "../src/deploy/build-context.ts";
import { registerFeishuApp } from "../src/channels/feishu/register-app.ts";
import { bootstrapFeishuVerificationToken } from "../src/channels/feishu/bootstrap-token.ts";
import { password } from "@clack/prompts";

vi.mock("../src/channels/feishu/register-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/channels/feishu/register-app.ts")>()),
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
  expect(resolveStateRoot(dir, env)).toBe(join(dir, ".fastagent", "start", ".state"));
  env.FASTAGENT_SECRETS_DIR = "/external/secrets";
  env.FASTAGENT_STATE_DIR = "/external/state";
  expect(resolveSecretsDir(dir, env)).toBe("/external/secrets");
  expect(resolveStateRoot(dir, env)).toBe("/external/state");
  selectAgentEnvironment("dev", env);
  delete env.FASTAGENT_SECRETS_DIR;
  delete env.FASTAGENT_STATE_DIR;
  expect(dotEnvPath(dir, env)).toBe(join(dir, ".secrets", ".env"));
  expect(resolveStateRoot(dir, env)).toBe(join(dir, ".fastagent", "dev", ".state"));
});

it("production never falls back to dev credentials when its file is absent", async () => {
  await mkdir(join(dir, ".secrets"));
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n");
  selectAgentEnvironment("production");
  loadDotEnv(dir);
  expect(process.env.FEISHU_APP_ID).toBeUndefined();
  expect(loadEnvValues(dotEnvPath(dir)).size).toBe(0);
});

it("scan-to-create requests webhook scopes, persists production credentials and resumes without creating another app", async () => {
  await mkdir(join(dir, ".secrets"));
  const dev = "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n";
  await writeFile(join(dir, ".secrets", ".env"), dev);
  selectAgentEnvironment("production");
  const production = () =>
    setUpChannel({
      kind: "feishu",
      agentDir: dir,
      file: dotEnvPath(dir),
      way: "webhook",
      dev: false,
      rerun: "fastagent deploy fly --run",
    });
  // The tenant has not approved the app-config scope: the app is made and kept, and the token cannot be had yet.
  approved = false;
  vi.mocked(password).mockRejectedValueOnce(new Error("setup cancelled"));
  await expect(production()).rejects.toThrow("setup cancelled");
  expect(registerFeishuApp).toHaveBeenCalledWith(expect.objectContaining({ addons: feishuAppAddons("webhook") }));
  const values = loadEnvValues(dotEnvPath(dir));
  expect(values.get("FEISHU_APP_ID")).toBe("cli_production");
  expect(values.get("FEISHU_APP_SECRET")).toBe("production_secret");
  expect(values.has("FEISHU_VERIFICATION_TOKEN")).toBe(false);
  expect((await stat(dotEnvPath(dir))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dir, ".secrets", "production", ".gitignore"), "utf8")).toContain("*");
  approved = true;
  await production();
  expect(registerFeishuApp).toHaveBeenCalledOnce();
  expect(loadEnvValues(dotEnvPath(dir)).get("FEISHU_VERIFICATION_TOKEN")).toBe("production_token");
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe(dev);
});

it("excludes the file --env-file names by its path when it is in the build context, and adds nothing when it is not", async () => {
  const auth = join(resolveSecretsDir(dir), "auth.json");
  const inside = join(dir, "prod.env");
  await writeFile(inside, "OPENAI_API_KEY=sk\n");
  const within = await buildContextPaths(dir, auth, inside);
  // Neither `.env` nor `.env.*`: only its path keeps it out of the image, and a kept ignore file that lacks it leaks.
  expect(within.machineryPaths).toContain("prod.env");
  expect(within.leakCandidates).toContain("prod.env");
  const nested = join(dir, "ops", "keys.env");
  await mkdir(join(dir, "ops"), { recursive: true });
  await writeFile(nested, "K=v\n");
  expect((await buildContextPaths(dir, auth, nested)).machineryPaths).toContain("ops/keys.env");
  // Under the secrets dir the name rules already reach it; outside the directory it is not shipped at all.
  const secret = join(dir, ".secrets", "production", ".env");
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(secret, "K=v\n");
  expect((await buildContextPaths(dir, auth, secret)).machineryPaths).not.toContain(".secrets/production/.env");
  const outside = join(await mkdtemp(join(tmpdir(), "fa-outside-")), "prod.env");
  await writeFile(outside, "K=v\n");
  const away = await buildContextPaths(dir, auth, outside);
  expect(away.machineryPaths).not.toContain(outside);
  expect(away.leakCandidates).not.toContain("prod.env");
  // A file that is not there cannot be baked: no leak candidate, but the exclude is still written.
  const absent = await buildContextPaths(dir, auth, join(dir, "later.env"));
  expect(absent.machineryPaths).toContain("later.env");
  expect(absent.leakCandidates).not.toContain("later.env");
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
