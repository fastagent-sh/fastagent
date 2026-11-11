import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installProxyFetch } from "../src/proxy.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

// What reaches the platform goes through the proxy the environment declares: whether it does is asked of this seam.
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

/** A deployment's public face: its /health, answering what the box reports of `channel`. */
async function deployment(outcome: string, channel = "lark"): Promise<{ url: string; close(): void }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", webhooks: [{ channel, outcome }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe("cli: channels setup --record-url", () => {
  it("records the URL once the deployment reports it reached there, and refuses before", async () => {
    const dir = await agentWorkspace("fa-record-url-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const values = join(dir, "..", "prod.env");
    await writeFile(values, "LARK_APP_ID=cli_lark\n");
    const config = join(dir, "..", "prod.json");
    await writeFile(config, JSON.stringify({ settings: {} }));

    const pending = await deployment("manual");
    try {
      const refused = await runInProcess([
        "channels",
        "setup",
        "lark",
        dir,
        "--record-url",
        "--config",
        config,
        "--env-file",
        values,
        "--url",
        pending.url,
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        `lark: the deployment at ${pending.url} reports it manual, not reached at ${pending.url}/lark yet`,
      );
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ settings: {} });
    } finally {
      pending.close();
    }

    const confirmed = await deployment("registered");
    try {
      const done = await runInProcess([
        "channels",
        "setup",
        "lark",
        dir,
        "--record-url",
        "--config",
        config,
        "--env-file",
        values,
        "--url",
        confirmed.url,
        "--json",
      ]);
      expect(done.code, done.stderr).toBe(0);
      expect(JSON.parse(done.stdout)).toMatchObject({ status: "done", channel: "lark", url: `${confirmed.url}/lark` });
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
        settings: {},
        channels: { lark: { app: { id: "cli_lark", url: `${confirmed.url}/lark` } } },
      });
    } finally {
      confirmed.close();
    }
  });

  it("reads /health at --url, records the configuration's own URL, and names the app from the bot token", async () => {
    const dir = await agentWorkspace("fa-record-url-own-", {
      "fastagent.config.ts": `export default {};\n`,
    });
    const config = join(dir, "..", "own.json");
    await writeFile(config, JSON.stringify({ http: { publicUrl: "https://agent.acme.com" } }));
    const values = join(dir, "..", "own.env");
    const box = await deployment("registered", "slack");
    const real = globalThis.fetch;
    const slack: string[] = [];
    const events: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://slack.com/api/")) return real(input, init);
      const method = (url.split("/").pop() as string).split("?")[0] as string;
      slack.push(`${url.split("/").pop()} ${new Headers(init?.headers).get("authorization")}`);
      events.push("slack");
      return Response.json(
        method === "auth.test"
          ? { ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }
          : { ok: true, bot: { id: "B1", app_id: "A1" } },
      );
    });
    try {
      const args = [
        "channels",
        "setup",
        "slack",
        dir,
        "--record-url",
        "--config",
        config,
        "--env-file",
        values,
        "--url",
        box.url,
      ];
      await writeFile(values, "OPENAI_API_KEY=sk\n");
      const noToken = await runInProcess(args);
      expect(noToken.code).toBe(1);
      expect(noToken.stderr).toContain("no SLACK_BOT_TOKEN in the values");

      await writeFile(values, "SLACK_BOT_TOKEN=xoxb-held\n");
      vi.mocked(installProxyFetch).mockImplementation(() => {
        events.push("proxy");
      });
      const done = await runInProcess(args);
      // The Slack calls that name the app are made after the proxy is installed, not before.
      expect(events).toEqual(["proxy", "slack", "slack"]);
      expect(done.code, done.stderr).toBe(0);
      expect(slack).toEqual(["auth.test Bearer xoxb-held", "bots.info?bot=B1 Bearer xoxb-held"]);
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
        http: { publicUrl: "https://agent.acme.com" },
        channels: { slack: { app: { id: "A1", team: "T1", url: "https://agent.acme.com/slack" } } },
      });
    } finally {
      vi.unstubAllGlobals();
      box.close();
    }
  });

  it("names what is missing: the mode, a channel with such a URL, the configuration, its URL", async () => {
    const dir = await agentWorkspace("fa-record-url-usage-", {
      "fastagent.config.ts": `export default {};\n`,
    });
    const config = join(dir, "..", "bare.json");
    await writeFile(config, "{}");
    const cases: [string[], string][] = [
      [["channels", "setup", "whatsapp", dir], "sets up telegram, slack, feishu and lark"],
      [["channels", "setup", "telegram", dir, "--record-url"], "only slack and lark have a URL a person sets"],
      [["channels", "setup", "slack", dir, "--record-url"], "pass --config <file>"],
      [["channels", "setup", "slack", dir, "--record-url", "--config", config], "names no http.publicUrl: pass --url"],
    ];
    for (const [argv, said] of cases) {
      const result = await runInProcess(argv);
      expect([result.code, result.stderr]).toEqual([2, expect.stringContaining(said)]);
    }
  });
});
