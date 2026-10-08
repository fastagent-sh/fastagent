import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareWebhookApps } from "../src/cli/add-feishu.ts";
import { appendChannelDotEnv } from "../src/scaffold/add-channel.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agent(env: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-prepare-")), "fastagent");
  dirs.push(dir);
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), env);
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  return dir;
}

it("prepares only a Feishu/Lark app the deployment receives by webhook and that has no Verification Token", async () => {
  const dir = await agent("FEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=s\nLARK_APP_ID=cli_2\nLARK_APP_SECRET=s\n");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  // The scan-to-create resume writes the token itself; the guided Lark flow returns it for the caller to write.
  const onboard = vi.fn(async (target: string, kind: "feishu" | "lark") => {
    if (kind === "feishu") {
      await appendChannelDotEnv(target, "feishu", { FEISHU_VERIFICATION_TOKEN: "t1" }, ["FEISHU_VERIFICATION_TOKEN"]);
      return undefined;
    }
    return { LARK_VERIFICATION_TOKEN: "t2" };
  });
  await prepareWebhookApps(
    dir,
    [
      { name: "feishu", ingress: "webhook" },
      { name: "lark", ingress: "webhook" },
      { name: "telegram", ingress: "webhook" },
    ],
    onboard,
  );
  expect(onboard.mock.calls).toEqual([
    [dir, "feishu", "webhook"],
    [dir, "lark", "webhook"],
  ]);
  const env = await readFile(join(dir, ".secrets", ".env"), "utf8");
  expect(env).toMatch(/^FEISHU_VERIFICATION_TOKEN=t1$/m);
  expect(env).toMatch(/^LARK_VERIFICATION_TOKEN=t2$/m);
  const out = printed.mock.calls.map((call) => String(call[0])).join("\n");
  expect(out).toContain("feishu: this deployment receives by webhook (FEISHU_INGRESS is not websocket)");
  expect(out).toContain("lark: the app is in webhook mode now, so `dev` on this machine receives nothing from it");

  // Prepared once: the next deploy finds the token and touches nothing.
  onboard.mockClear();
  await prepareWebhookApps(dir, [{ name: "feishu", ingress: "webhook" }], onboard);
  // A WebSocket deployment needs no preparation.
  await prepareWebhookApps(
    await agent("FEISHU_APP_ID=cli_1\n"),
    [{ name: "feishu", ingress: "long-connection" }],
    onboard,
  );
  expect(onboard).not.toHaveBeenCalled();
});

it("an app that could not be prepared is not said to be in webhook mode", async () => {
  const dir = await agent("FEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=s\n");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  await prepareWebhookApps(dir, [{ name: "feishu", ingress: "webhook" }], async () => undefined);
  expect(printed.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("webhook mode now");
});
