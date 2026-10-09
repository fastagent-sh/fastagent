import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareFeishuApps, unpreparedFeishuApps } from "../src/cli/add-feishu.ts";
import { appendChannelDotEnv } from "../src/scaffold/add-channel.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("creates missing apps for either ingress and prepares an existing webhook app without its token", () => {
  const channels = [
    { name: "feishu", ingress: "webhook" },
    { name: "lark", ingress: "long-connection" },
    { name: "telegram", ingress: "webhook" },
  ] as const;
  expect(unpreparedFeishuApps(channels, new Map())).toEqual([
    { kind: "feishu", ingress: "webhook" },
    { kind: "lark", ingress: "websocket" },
  ]);
  const values = new Map([
    ["FEISHU_APP_ID", "f"],
    ["FEISHU_APP_SECRET", "fs"],
    ["LARK_APP_ID", "l"],
    ["LARK_APP_SECRET", "ls"],
  ]);
  expect(unpreparedFeishuApps(channels, values)).toEqual([{ kind: "feishu", ingress: "webhook" }]);
  values.set("FEISHU_VERIFICATION_TOKEN", "t");
  expect(unpreparedFeishuApps(channels, values)).toEqual([]);
  values.set("FEISHU_VERIFICATION_TOKEN", " ");
  expect(unpreparedFeishuApps(channels, values)).toEqual([{ kind: "feishu", ingress: "webhook" }]);
});

it("runs each cloud's existing onboarding in production and writes only that environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-prepare-"));
  dirs.push(dir);
  await mkdir(join(dir, ".secrets"), { recursive: true });
  const dev = "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n";
  await writeFile(join(dir, ".secrets", ".env"), dev);
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "production");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  const onboard = vi.fn(async (target: string, kind: "feishu" | "lark") => {
    if (kind === "feishu") {
      const created = { FEISHU_APP_ID: "cli_prod", FEISHU_APP_SECRET: "prod_secret", FEISHU_VERIFICATION_TOKEN: "t1" };
      await appendChannelDotEnv(target, kind, created, Object.keys(created));
      return undefined;
    }
    return { LARK_APP_ID: "cli_lark_prod", LARK_APP_SECRET: "lark_prod_secret", LARK_VERIFICATION_TOKEN: "t2" };
  });
  await prepareFeishuApps(
    dir,
    [
      { kind: "feishu", ingress: "webhook" },
      { kind: "lark", ingress: "webhook" },
    ],
    "fastagent deploy fly --run",
    onboard,
  );
  expect(onboard.mock.calls).toEqual([
    [dir, "feishu", "webhook", "fastagent deploy fly --run"],
    [dir, "lark", "webhook", "fastagent deploy fly --run"],
  ]);
  const env = await readFile(join(dir, ".secrets", "production", ".env"), "utf8");
  expect(env).toMatch(/^FEISHU_APP_ID=cli_prod$/m);
  expect(env).toMatch(/^LARK_VERIFICATION_TOKEN=t2$/m);
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe(dev);
  expect(printed.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    "preparing the production app for webhook",
  );
});
