/**
 * Feishu's accounts service and Open API, as a new app's setup meets them, through the process's `fetch`: the app is
 * confirmed at the first poll, every scope it asks for is granted, and its configuration holds a Verification Token.
 * What it was asked is recorded; a request to anything else (a loopback server of the test) goes through.
 */
import { vi } from "vitest";
import { feishuAppScopes } from "../src/channels/feishu/setup-mode.ts";

export interface FeishuPlatform {
  /** Each request, as `<method> <path>`. */
  requests: string[];
  /** Whether the person's scan created an app. */
  created(): boolean;
}

export function feishuPlatform(
  app = { id: "cli_production", secret: "secret", verificationToken: "production_token" },
  /** Called as the person's scan is polled for: what a test reads of the run while its person is asked. */
  onPoll: () => void | Promise<void> = () => {},
) {
  const platform: FeishuPlatform = {
    requests: [],
    created: () => platform.requests.some((request) => request.endsWith("/oauth/v1/app/registration poll")),
  };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!/feishu\.cn$|larksuite\.com$/.test(url.hostname)) return real(input, init);
    const method = init.method ?? "GET";
    if (url.pathname === "/oauth/v1/app/registration") {
      const action = new URLSearchParams(String(init.body)).get("action");
      platform.requests.push(`${method} ${url.pathname} ${action}`);
      if (action === "begin") {
        return Response.json({
          device_code: "dev-1",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=AB-CD",
          interval: 0.001,
          expires_in: 600,
        });
      }
      await onPoll();
      return Response.json({ client_id: app.id, client_secret: app.secret, user_info: { tenant_brand: "feishu" } });
    }
    platform.requests.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
    }
    if (url.pathname === "/open-apis/application/v6/scopes") {
      const scopes = feishuAppScopes("webhook").map(({ request }) => ({ scope_name: request, grant_status: 1 }));
      return Response.json({ code: 0, data: { scopes } });
    }
    if (url.pathname.startsWith("/open-apis/application/v6/applications/")) {
      return Response.json({ code: 0, data: { app: { encryption: { verification_token: app.verificationToken } } } });
    }
    return Response.json({ code: 0, data: {} });
  });
  return platform;
}
