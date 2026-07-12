import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLarkApp } from "../src/channels/lark/register-app.ts";

const FEISHU = "http://accounts.feishu.test";
const LARK = "http://accounts.lark.test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fake the accounts endpoint: `begin` answers immediately; `poll` walks through `pollResponses`. */
function stubAccounts(pollResponses: Record<string, unknown>[], beginOver: Record<string, unknown> = {}) {
  const polls: { base: string; params: URLSearchParams }[] = [];
  let pollIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const params = new URLSearchParams(String(init.body));
      const base = String(url).replace("/oauth/v1/app/registration", "");
      if (params.get("action") === "begin") {
        return Response.json({
          device_code: "dev-1",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=AB-CD",
          interval: 0.001, // fast polling for the test (seconds)
          expires_in: 600,
          ...beginOver,
        });
      }
      polls.push({ base, params });
      const body = pollResponses[Math.min(pollIndex, pollResponses.length - 1)];
      pollIndex++;
      // RFC 8628 delivers pending/slow_down as HTTP 400 — the flow must read them as data, not failures.
      const isError = typeof (body as { error?: string }).error === "string";
      return Response.json(body, { status: isError ? 400 : 200 });
    }),
  );
  return { polls };
}

describe("registerLarkApp (scan-to-create device flow)", () => {
  it("begins, decorates the verification URL (attribution + presets), polls through pending → credentials", async () => {
    const { polls } = stubAccounts([
      { error: "authorization_pending" },
      { client_id: "cli_new", client_secret: "s3cret", user_info: { open_id: "ou_me", tenant_brand: "feishu" } },
    ]);
    let shown: { url: string; expiresInS: number } | undefined;
    const app = await registerLarkApp({
      name: "{user}'s agent",
      desc: "Served by fastagent",
      accountsBaseUrl: FEISHU,
      larkAccountsBaseUrl: LARK,
      onVerificationUrl: (info) => {
        shown = info;
      },
    });
    expect(app).toEqual({ appId: "cli_new", appSecret: "s3cret", tenantBrand: "feishu", openId: "ou_me" });
    const url = new URL(shown?.url ?? "");
    expect(url.searchParams.get("user_code")).toBe("AB-CD"); // the platform's one-time code survives
    expect(url.searchParams.get("source")).toBe("fastagent"); // attribution
    expect(url.searchParams.get("name")).toBe("{user}'s agent");
    expect(shown?.expiresInS).toBe(600);
    expect(polls.length).toBe(2);
    expect(polls[0]?.params.get("device_code")).toBe("dev-1");
  });

  it("addons ride the URL gzip+base64url-encoded (extra scopes/events layered onto the template)", async () => {
    stubAccounts([{ client_id: "cli_a", client_secret: "s" }]);
    let shown: { url: string } | undefined;
    await registerLarkApp({
      accountsBaseUrl: FEISHU,
      addons: {
        scopes: { tenant: ["application:application:patch"] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
      },
      onVerificationUrl: (info) => {
        shown = info;
      },
    });
    const raw = new URL(shown?.url ?? "").searchParams.get("addons") ?? "";
    const decoded = JSON.parse(
      gunzipSync(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toString("utf8"),
    ) as { scopes: { tenant: string[] }; events: { items: { tenant: string[] } } };
    expect(decoded.scopes.tenant).toEqual(["application:application:patch"]);
    expect(decoded.events.items.tenant).toEqual(["im.message.receive_v1"]);
  });

  it("a Lark-tenant confirmation switches polling to the Lark accounts domain (once) and completes there", async () => {
    const { polls } = stubAccounts([
      { user_info: { tenant_brand: "lark" } }, // brand signal, no credentials yet
      { client_id: "cli_intl", client_secret: "s", user_info: { tenant_brand: "lark" } },
    ]);
    const app = await registerLarkApp({
      accountsBaseUrl: FEISHU,
      larkAccountsBaseUrl: LARK,
      onVerificationUrl: () => {},
    });
    expect(app.tenantBrand).toBe("lark");
    expect(polls[0]?.base).toBe(FEISHU); // started on the Feishu accounts endpoint …
    expect(polls[1]?.base).toBe(LARK); // … and switched over for the rest of the flow
  });

  it("slow_down backs the polling interval off and still completes", async () => {
    stubAccounts([{ error: "slow_down" }, { client_id: "cli_x", client_secret: "s" }]);
    const app = await registerLarkApp({
      accountsBaseUrl: FEISHU,
      onVerificationUrl: () => {},
    });
    expect(app.appId).toBe("cli_x");
  });

  it("denial and unknown errors reject with self-describing messages", async () => {
    stubAccounts([{ error: "access_denied" }]);
    await expect(registerLarkApp({ accountsBaseUrl: FEISHU, onVerificationUrl: () => {} })).rejects.toThrow(/declined/);
    stubAccounts([{ error: "invalid_grant", error_description: "device code revoked" }]);
    await expect(registerLarkApp({ accountsBaseUrl: FEISHU, onVerificationUrl: () => {} })).rejects.toThrow(
      /invalid_grant — device code revoked/,
    );
  });

  it("a begin without a device code fails visibly (never a silent undefined URL)", async () => {
    stubAccounts([], { device_code: undefined });
    await expect(registerLarkApp({ accountsBaseUrl: FEISHU, onVerificationUrl: () => {} })).rejects.toThrow(
      /begin returned no device code/,
    );
  });

  it("an aborted signal stops the polling with a plain error", async () => {
    stubAccounts([{ error: "authorization_pending" }]);
    const ctl = new AbortController();
    const p = registerLarkApp({ accountsBaseUrl: FEISHU, signal: ctl.signal, onVerificationUrl: () => ctl.abort() });
    await expect(p).rejects.toThrow(/aborted/);
  });
});
