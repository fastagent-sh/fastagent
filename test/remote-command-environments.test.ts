import { besideAgent, buildable } from "./cli-run.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDeploy } from "../src/cli/commands/deploy.ts";
import { runDestroy } from "../src/cli/commands/destroy.ts";
import { runLogs } from "../src/cli/commands/logs.ts";
import { runLogin } from "../src/cli/commands/login.ts";
import { hostCli, resetHostClis } from "./host-cli-double.ts";

/**
 * Which AWS account a command that reaches a deployment talks to: what its `aws` is run with. The AWS CLI is the
 * boundary, so it is where this is read; each command stops at the first call it makes, which refuses.
 */
vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));
vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"));
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));

let dir: string;
let reached: string[][];
const exited = new Error("process exited");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-remote-env-"));
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), 'export default { defaults: { model: "openai/gpt-4o" } };\n');
  await buildable(dir);
  await writeFile(join(dir, ".secrets", ".env"), "AWS_PROFILE=dev-account\nAWS_REGION=us-east-1\n");
  await writeFile(
    join(dir, ".secrets", "production", ".env"),
    "AWS_PROFILE=production-account\nAWS_REGION=us-west-2\n",
  );
  reached = [];
  hostCli("aws", ({ env }) => {
    reached.push([env.AWS_PROFILE as string, env.AWS_REGION as string]);
    return { code: 1, stderr: "the account refuses\n" };
  });
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "dev");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  resetHostClis();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** The four commands that reach a deployment's host account, each given what a test says of `--env-file`. */
const commands = (envFile?: string) => [
  () => runDeploy("agentcore", dir, { run: true, input: false, ...(envFile === undefined ? {} : { envFile }) }),
  () => runLogs("agentcore", dir, { ...(envFile === undefined ? {} : { envFile }) }),
  () => runDestroy("agentcore", dir, { run: true, ...(envFile === undefined ? {} : { envFile }) }),
  () => runLogin("openai", { deployment: "agentcore", ...(envFile === undefined ? {} : { envFile }) }),
];

async function reach(envFile?: string): Promise<string[][]> {
  const found: string[][] = [];
  reached.length = 0;
  const shell = { profile: process.env.AWS_PROFILE, region: process.env.AWS_REGION };
  for (const [index, command] of commands(envFile).entries()) {
    // Each command starts from the shell's own variables, as a separate process would.
    vi.stubEnv("AWS_PROFILE", shell.profile);
    vi.stubEnv("AWS_REGION", shell.region);
    const before = reached.length;
    await command().catch((error: unknown) => {
      if (error !== exited) throw error;
    });
    expect(reached.length, `command ${index} reached the AWS CLI`).toBeGreaterThan(before);
    found.push(reached[before] as string[]);
    expect(process.env.FASTAGENT_ENVIRONMENT).toBe("production");
  }
  return found;
}

it("remote commands reach the account their own environment names, and no file of the project", async () => {
  // The project holds a development file and a production one, each naming an account: a deployment has no default
  // file, so neither is read.
  vi.stubEnv("AWS_PROFILE", "ci-account");
  vi.stubEnv("AWS_REGION", "ap-southeast-1");
  expect(await reach()).toEqual(Array(4).fill(["ci-account", "ap-southeast-1"]));
});

it("with nothing in the environment, they reach no account: the project's files are not a fallback", async () => {
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_REGION", undefined);
  const found = await reach();
  for (const row of found) expect(row).toEqual([undefined, undefined]);
});

it("--env-file names the account's variables, under what the environment already holds", async () => {
  // Outside the agent directory, so the image's build context has nothing to say of it.
  const file = besideAgent(dir, "account.env");
  await writeFile(file, "AWS_PROFILE=file-account\nAWS_REGION=eu-west-1\n");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_REGION", undefined);
  expect(await reach(file)).toEqual(Array(4).fill(["file-account", "eu-west-1"]));
  // A variable the shell sets outranks the file, as for every command that enters one.
  vi.stubEnv("AWS_PROFILE", "shell-account");
  vi.stubEnv("AWS_REGION", undefined);
  expect(await reach(file)).toEqual(Array(4).fill(["shell-account", "eu-west-1"]));
});
