/**
 * The page where a person pastes a Lark app's App ID and App Secret: what it accepts, what it refuses, what it never
 * puts back, and who can reach it. The server is real; Lark is the `check` each test hands it.
 */
import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  LarkCredentialsRefused,
  type LarkCredentialsPage,
  startLarkCredentialsPage,
} from "../src/channels/lark/credentials-page.ts";

const CONSOLE = "https://open.larksuite.com/page/launcher?from=backend_oneclick&addons=XYZ";
const pages: LarkCredentialsPage[] = [];

async function open(check: Parameters<typeof startLarkCredentialsPage>[0]["check"] = async () => {}) {
  const page = await startLarkCredentialsPage({ consoleUrl: CONSOLE, check });
  pages.push(page);
  return page;
}

afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields), headers });

/** A request with a Host header of the caller's choosing (fetch will not send one). */
function viaHost(url: string, host: string, method = "GET"): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, method, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("asks for the two values under the names Lark gives them, and sends the person to create the app first", async () => {
  const page = await open();
  const response = await fetch(page.url);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("Connect Lark");
  expect(html).toContain(">App ID<");
  expect(html).toContain(">App Secret<");
  // `&` in an attribute is written `&amp;`; the browser reads the link back as it was.
  expect(html).toContain(`href="${CONSOLE.replaceAll("&", "&amp;")}"`);
  expect(html).toContain('type="password"'); // the Secret is not shown as it is typed
  expect(html).not.toContain('aria-invalid="true"'); // nothing is wrong yet (the style sheet names the attribute)
});

it("is served as a page that takes a secret: not cached, not framed, loading nothing from elsewhere", async () => {
  const page = await open();
  const response = await fetch(page.url);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  const nonce = /style-src 'nonce-([^']+)'/.exec(policy)?.[1];
  const html = await response.text();
  expect(nonce).toBeTruthy();
  expect(html).toContain(`<style nonce="${nonce}">`);
  expect(html).not.toMatch(/<script src|<link |<img |@import|url\(/);
});

it("takes a pair Lark accepts, says so, and hands it on only once that page has been sent", async () => {
  const check = vi.fn(async () => {});
  const page = await open(check);
  const response = await post(page.url, { app_id: " cli_abc ", app_secret: " s3cret " });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(check).toHaveBeenCalledWith({ appId: "cli_abc", appSecret: "s3cret" });
  expect(html).toContain("Lark credentials verified");
  expect(html).toContain("Go back to your coding agent");
  await expect(page.credentials).resolves.toEqual({ appId: "cli_abc", appSecret: "s3cret" });
  // One-time: the pair is taken, and the page is gone.
  const again = await fetch(page.url);
  expect(again.status).toBe(404);
  expect(await again.text()).toContain("no longer in use");
});

it("a pair Lark refuses stays on the page: the error above the fields, the App ID kept, the Secret never put back", async () => {
  const page = await open(async () => {
    throw new LarkCredentialsRefused("Lark refused that App ID or Secret.", {
      fix: "Copy both again from Credentials & Basic Info.",
      why: "Lark said: app secret invalid",
    });
  });
  const response = await post(page.url, { app_id: "cli_abc", app_secret: "wrong-secret" });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("Lark refused that App ID or Secret.");
  // What the person is told to do stays a plain sentence; what Lark said is set apart under it, for whoever has to look it up.
  expect(html).toContain(
    'Copy both again from Credentials &amp; Basic Info.<span class="why">Lark said: app secret invalid</span>',
  );
  expect(html).toContain('value="cli_abc"');
  expect(html).not.toContain("wrong-secret");
  expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
  // The error is the one thing between the heading and the fields: it is read before the fields are.
  expect(html.indexOf("Lark refused")).toBeLessThan(html.indexOf('id="app_id"'));
  // And the page is still there to try again on.
  expect((await fetch(page.url)).status).toBe(200);
});

it("a value that is missing is named, without asking Lark", async () => {
  const check = vi.fn(async () => {});
  const page = await open(check);
  const html = await (await post(page.url, { app_id: "cli_abc", app_secret: "  " })).text();
  expect(html).toContain("Both values are needed.");
  expect(check).not.toHaveBeenCalled();
});

it("shows what it was given as text, never as markup", async () => {
  const page = await open(async () => {
    throw new LarkCredentialsRefused('<img src=x onerror="alert(1)">');
  });
  const html = await (await post(page.url, { app_id: '"><script>alert(1)</script>', app_secret: "x" })).text();
  expect(html).not.toContain("<script>alert(1)");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("answers only at its secret path, and only to a request for this machine's own address", async () => {
  const page = await open();
  const origin = new URL(page.url).origin;
  expect((await fetch(`${origin}/`)).status).toBe(404);
  expect((await fetch(`${origin}/lark/credentials/guess`)).status).toBe(404);
  // A page that rebinds a name of its own to this machine reaches it under that name.
  expect((await viaHost(page.url, "evil.example")).status).toBe(421);
  expect((await viaHost(page.url, `localhost:${new URL(page.url).port}`)).status).toBe(200);
});

it("refuses a form posted from another site", async () => {
  const check = vi.fn(async () => {});
  const page = await open(check);
  const response = await post(page.url, { app_id: "cli_abc", app_secret: "s" }, { "sec-fetch-site": "cross-site" });
  expect(response.status).toBe(403);
  expect(check).not.toHaveBeenCalled();
});

it("takes no more than a short form: a large body is refused", async () => {
  const check = vi.fn(async () => {});
  const page = await open(check);
  const response = await post(page.url, { app_id: "cli_abc", app_secret: "x".repeat(40_000) });
  expect(response.status).toBe(413);
  expect(check).not.toHaveBeenCalled();
});

it.each(["network timeout", "permission denied writing credentials"])(
  "fails the setup instead of requesting new credentials: %s",
  async (message) => {
    const failure = new Error(message);
    const page = await open(async () => {
      throw failure;
    });
    const result = page.credentials.then(
      () => undefined,
      (error: unknown) => error,
    );
    const html = await (await post(page.url, { app_id: "cli_abc", app_secret: "s" })).text();
    expect(html).toContain("Setup stopped");
    expect(html).toContain(message);
    expect(html).not.toContain("Lark refused");
    expect(await result).toBe(failure);
  },
);

it.each([false, true])("settles after a browser disconnects during validation (failure=%s)", async (fails) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("validation unavailable");
  const page = await open(async () => {
    entered.resolve();
    await release.promise;
    if (fails) throw failure;
  });
  let outcome: unknown;
  const result = page.credentials.then(
    (pair) => {
      outcome = pair;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  const abort = new AbortController();
  const sent = fetch(page.url, {
    method: "POST",
    body: new URLSearchParams({ app_id: "cli_abc", app_secret: "s" }),
    signal: abort.signal,
  });
  const interrupted = expect(sent).rejects.toThrow();
  await entered.promise;
  abort.abort();
  await interrupted;
  // Allow the socket close to reach the server before its external validation completes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release.resolve();
  await vi.waitFor(() => expect(outcome).toEqual(fails ? failure : { appId: "cli_abc", appSecret: "s" }));
  await result;
});

it("refuses a second submission while the accepted pair is being persisted", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const check = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const page = await open(check);
  const first = post(page.url, { app_id: "cli_abc", app_secret: "s" });
  await entered.promise;
  expect((await post(page.url, { app_id: "cli_other", app_secret: "other" })).status).toBe(409);
  release.resolve();
  await first;
  expect(check).toHaveBeenCalledOnce();
  await expect(page.credentials).resolves.toEqual({ appId: "cli_abc", appSecret: "s" });
});
