import { afterEach, expect, it, vi } from "vitest";
import { registrarsFor } from "../src/cli/commands/deploy/shared.ts";
import { announceWebhooks } from "../src/tunnel.ts";

function platformFetch() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("tenant_access_token"))
        return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
      return Response.json({ code: 0, data: {}, ok: true });
    }),
  );
  return requests;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("every cloud registrar uses carried production credentials, even when the shell holds a dev app", async () => {
  vi.stubEnv("FEISHU_APP_ID", "cli_dev");
  vi.stubEnv("FEISHU_APP_SECRET", "dev_secret");
  vi.stubEnv("LARK_APP_ID", "cli_lark_dev");
  vi.stubEnv("LARK_APP_SECRET", "lark_dev_secret");
  const requests = platformFetch();
  const registrars = registrarsFor(
    "/agent",
    new Map([
      ["FEISHU_APP_ID", "cli_prod"],
      ["FEISHU_APP_SECRET", "prod_secret"],
      ["LARK_APP_ID", "cli_lark_prod"],
      ["LARK_APP_SECRET", "lark_prod_secret"],
    ]),
  );
  expect(await registrars.feishu?.("https://production.test", "feishu")).toBe("registered");
  expect(await registrars.feishu?.("https://production.test", "lark")).toBe("registered");
  const auth = requests.filter(({ url }) => url.includes("tenant_access_token"));
  expect(auth.map(({ body }) => body)).toEqual([
    { app_id: "cli_prod", app_secret: "prod_secret" },
    { app_id: "cli_lark_prod", app_secret: "lark_prod_secret" },
  ]);
  expect(requests.filter(({ url }) => url.includes("/config")).map(({ url }) => url)).toEqual([
    "https://open.feishu.cn/open-apis/application/v7/applications/cli_prod/config",
    "https://open.larksuite.com/open-apis/application/v7/applications/cli_lark_prod/config",
  ]);
});

it("a deployment with no app credentials never registers the shell's dev app", async () => {
  vi.stubEnv("FEISHU_APP_ID", "cli_dev");
  vi.stubEnv("FEISHU_APP_SECRET", "dev_secret");
  const requests = platformFetch();
  expect(await registrarsFor("/agent", new Map()).feishu?.("https://production.test", "feishu")).toBe("manual");
  expect(requests).toEqual([]);
});

it("Docker tunnel registration uses its selected production values, not dev's exported bot token", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "DEV_BOT");
  vi.stubEnv("TELEGRAM_SECRET_TOKEN", "dev_secret");
  const requests = platformFetch();
  await announceWebhooks("/agent", "https://production.test", [{ name: "telegram", ingress: "webhook" }], {
    env: { TELEGRAM_BOT_TOKEN: "PRODUCTION_BOT", TELEGRAM_SECRET_TOKEN: "prod_secret" },
  });
  expect(requests).toEqual([
    {
      url: "https://api.telegram.org/botPRODUCTION_BOT/setWebhook",
      body: { url: "https://production.test/telegram", secret_token: "prod_secret" },
    },
  ]);
});
