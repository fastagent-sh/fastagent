import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

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
    await mkdir(join(dir, ".secrets", "production"), { recursive: true });
    await writeFile(join(dir, ".secrets", "production", ".env"), "LARK_APP_ID=cli_lark\n");
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

  it("reads /health at --url, records the configuration's own URL, and takes an app this machine did not create", async () => {
    const dir = await agentWorkspace("fa-record-url-own-", {
      "fastagent.config.ts": `export default {};\n`,
    });
    const config = join(dir, "..", "own.json");
    await writeFile(config, JSON.stringify({ http: { publicUrl: "https://agent.acme.com" } }));
    const box = await deployment("registered", "slack");
    try {
      const noApp = await runInProcess([
        "channels",
        "setup",
        "slack",
        dir,
        "--record-url",
        "--config",
        config,
        "--url",
        box.url,
      ]);
      expect(noApp.code).toBe(1);
      expect(noApp.stderr).toContain("name it with --app <id> (and --team <id>)");
      const done = await runInProcess([
        "channels",
        "setup",
        "slack",
        dir,
        "--record-url",
        "--config",
        config,
        "--url",
        box.url,
        "--app",
        "A1",
        "--team",
        "T1",
      ]);
      expect(done.code, done.stderr).toBe(0);
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
        http: { publicUrl: "https://agent.acme.com" },
        channels: { slack: { app: { id: "A1", team: "T1", url: "https://agent.acme.com/slack" } } },
      });
    } finally {
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
      [["channels", "setup", "slack", dir], "pass --record-url"],
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
