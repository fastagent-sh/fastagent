import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareWebhookApps, unpreparedWebhookApps } from "../src/cli/add-feishu.ts";
import { appendChannelDotEnv } from "../src/scaffold/add-channel.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("an app needs preparing when the deployment receives its channel by webhook and holds no token for it", () => {
  const channels = [
    { name: "feishu", ingress: "webhook" },
    { name: "lark", ingress: "long-connection" },
    { name: "telegram", ingress: "webhook" },
  ] as const;
  expect(unpreparedWebhookApps(channels, new Map())).toEqual(["feishu"]);
  expect(unpreparedWebhookApps(channels, new Map([["FEISHU_VERIFICATION_TOKEN", "t"]]))).toEqual([]);
  expect(
    unpreparedWebhookApps([{ name: "lark", ingress: "webhook" }], new Map([["LARK_VERIFICATION_TOKEN", ""]])),
  ).toEqual(["lark"]);
});

it("prepares each app as add --ingress webhook does, and writes what the guided flow returns", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-prepare-")), "fastagent");
  dirs.push(dir);
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_1\nLARK_APP_ID=cli_2\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  // The scan-to-create resume writes the token itself; the guided Lark flow returns it for the caller to write.
  const onboard = vi.fn(async (target: string, kind: "feishu" | "lark") => {
    if (kind === "feishu") {
      await appendChannelDotEnv(target, "feishu", { FEISHU_VERIFICATION_TOKEN: "t1" }, ["FEISHU_VERIFICATION_TOKEN"]);
      return undefined;
    }
    return { LARK_VERIFICATION_TOKEN: "t2" };
  });
  await prepareWebhookApps(dir, ["feishu", "lark"], onboard);
  expect(onboard.mock.calls).toEqual([
    [dir, "feishu", "webhook"],
    [dir, "lark", "webhook"],
  ]);
  const env = await readFile(join(dir, ".secrets", ".env"), "utf8");
  expect(env).toMatch(/^FEISHU_VERIFICATION_TOKEN=t1$/m);
  expect(env).toMatch(/^LARK_VERIFICATION_TOKEN=t2$/m);
  expect(printed.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    "feishu: this deployment receives by webhook (FEISHU_INGRESS is not websocket)",
  );
});
