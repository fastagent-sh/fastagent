import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SetupRefused } from "../src/channels/setup.ts";
import { type CredentialsPage, type CredentialsStep, startCredentialsPage } from "../src/credentials-page.ts";

const STEPS = [
  {
    label: "Bot User OAuth Token",
    guide: { instructions: "Install it.", url: "https://api.slack.com/apps" },
    fields: [{ name: "SLACK_BOT_TOKEN", label: "Bot User OAuth Token" }],
  },
  {
    label: "App-Level Token",
    guide: { instructions: "Generate one." },
    fields: [{ name: "SLACK_APP_TOKEN", label: "App-Level Token" }],
  },
];

const pages: CredentialsPage[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

/** A page over `steps` whose `accept` is told each value by name, whichever step it came with. */
async function start(
  accept: (name: string, value: string) => Promise<void>,
  steps: readonly CredentialsStep[] = STEPS,
) {
  const page = await startCredentialsPage({
    title: "Connect Slack",
    doneHeading: "Slack connected",
    steps,
    accept: async (_step, values) => {
      for (const [name, value] of Object.entries(values)) await accept(name, value);
    },
  });
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

  it("is used once: after it is done, the address is gone", async () => {
    const page = await start(async () => {}, STEPS.slice(0, 1));
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
      STEPS.slice(0, 1),
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
});
