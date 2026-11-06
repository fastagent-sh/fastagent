import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SetupRefused } from "../src/channels/setup.ts";
import { type CredentialsPage, startCredentialsPage } from "../src/credentials-page.ts";

const FIELDS = [
  {
    name: "SLACK_BOT_TOKEN",
    label: "Bot User OAuth Token",
    guide: { instructions: "Install it.", url: "https://api.slack.com/apps" },
  },
  { name: "SLACK_APP_TOKEN", label: "App-Level Token", guide: { instructions: "Generate one." } },
];

const pages: CredentialsPage[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

async function start(accept: (name: string, value: string) => Promise<void>, fields = FIELDS) {
  const page = await startCredentialsPage({ title: "Connect Slack", doneHeading: "Slack connected", fields, accept });
  pages.push(page);
  page.done.catch(() => {});
  return page;
}

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields), headers });

describe("credentials page", () => {
  it("shows each value's step, with where to find it, and never puts a pasted value back", async () => {
    const page = await start(async () => {
      throw new SetupRefused("nope", { fix: "Try again." });
    });
    const html = await (await fetch(page.url)).text();
    expect(html).toContain("Bot User OAuth Token");
    expect(html).toContain("Install it.");
    expect(html).toContain("https://api.slack.com/apps");
    expect(html).toContain("App-Level Token");

    const refused = await (
      await post(page.url, { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_APP_TOKEN: "xapp-secret" })
    ).text();
    expect(refused).toContain("nope");
    expect(refused).toContain("Try again.");
    expect(refused).not.toContain("xoxb-secret");
    expect(refused).not.toContain("xapp-secret");
  });

  it("hands each value over as it is checked, and asks only for what is left after a refusal", async () => {
    const kept: [string, string][] = [];
    const page = await start(async (name, value) => {
      if (value === "bad") throw new SetupRefused("That is not it.");
      kept.push([name, value]);
    });
    const first = await (await post(page.url, { SLACK_BOT_TOKEN: "good-1", SLACK_APP_TOKEN: "bad" })).text();
    expect(kept).toEqual([["SLACK_BOT_TOKEN", "good-1"]]);
    expect(first).toContain("That is not it.");
    expect(first).toContain("Saved.");
    expect(first).not.toContain('name="SLACK_BOT_TOKEN"');
    expect(first).toContain('name="SLACK_APP_TOKEN"');

    const second = await (await post(page.url, { SLACK_APP_TOKEN: "good-2" })).text();
    expect(second).toContain("Slack connected");
    await page.done;
    expect(kept).toEqual([
      ["SLACK_BOT_TOKEN", "good-1"],
      ["SLACK_APP_TOKEN", "good-2"],
    ]);
  });

  it("asks for a value that was left empty, and keeps going no further than it", async () => {
    const kept: string[] = [];
    const page = await start(async (name) => {
      kept.push(name);
    });
    const html = await (await post(page.url, { SLACK_BOT_TOKEN: "  ", SLACK_APP_TOKEN: "xapp-1" })).text();
    expect(html).toContain("Bot User OAuth Token is needed.");
    expect(kept).toEqual([]);
  });

  it("a failure that is not a refusal ends the page with its reason, and the page is used up", async () => {
    const page = await start(async () => {
      throw new Error("getaddrinfo ENOTFOUND slack.com");
    });
    const stopped = await (await post(page.url, { SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y" })).text();
    expect(stopped).toContain("Setup stopped");
    expect(stopped).toContain("ENOTFOUND slack.com");
    await expect(page.done).rejects.toThrow("ENOTFOUND slack.com");
    expect((await fetch(page.url)).status).toBe(404);
  });

  it("is used once: after it is done, the address is gone", async () => {
    const page = await start(async () => {}, FIELDS.slice(0, 1));
    expect((await post(page.url, { SLACK_BOT_TOKEN: "x" })).status).toBe(200);
    await page.done;
    expect((await post(page.url, { SLACK_BOT_TOKEN: "y" })).status).toBe(404);
  });

  it("answers only this machine, to a request that came from this site's own form", async () => {
    const kept: string[] = [];
    const page = await start(
      async (name) => {
        kept.push(name);
      },
      FIELDS.slice(0, 1),
    );
    // Another site's page posting here: the browser says where it came from.
    expect((await post(page.url, { SLACK_BOT_TOKEN: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // A request addressed to some other host (a DNS rebind) is not this page's.
    const port = new URL(page.url).port;
    const path = new URL(page.url).pathname;
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(rebound).toBe(421);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
    expect(kept).toEqual([]);
  });

  it("refuses a body larger than a pasted token could be", async () => {
    const page = await start(async () => {}, FIELDS.slice(0, 1));
    expect((await post(page.url, { SLACK_BOT_TOKEN: "x".repeat(20_000) })).status).toBe(413);
  });
});
