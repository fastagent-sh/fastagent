import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("malformed request URLs return 400 without killing either setup server", async () => {
  // An unhandled request-handler rejection terminates Node; isolate that failure from the test runner.
  const script = `
    import assert from "node:assert/strict";
    import { request } from "node:http";
    import { startLarkCredentialsPage } from ${JSON.stringify(new URL("../src/channels/lark/credentials-page.ts", import.meta.url).href)};
    import { startCredentialsPage } from ${JSON.stringify(new URL("../src/credentials-page.ts", import.meta.url).href)};

    const lark = await startLarkCredentialsPage({ consoleUrl: "https://open.larksuite.com", check: async () => {} });
    const kept = [];
    const pasted = await startCredentialsPage({
      title: "Connect Slack",
      doneHeading: "Slack connected",
      fields: [{ name: "SLACK_BOT_TOKEN", label: "Bot User OAuth Token", guide: { instructions: "Copy it." } }],
      accept: async (name, value) => { kept.push([name, value]); },
    });
    try {
      for (const target of [lark.url, pasted.url]) {
        const port = new URL(target).port;
        // Fetch would normalize or reject this request target before it reaches the server.
        const reply = await new Promise((resolve, reject) => {
          const req = request({ host: "127.0.0.1", port, path: "//[", method: "GET" }, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body }));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.end();
        });
        assert.deepEqual(reply, { status: 400, body: "invalid request URL\\n" });
        const healthy = await fetch(target);
        assert.equal(healthy.status, 200);
        await healthy.text();
      }
      const accepted = await fetch(lark.url, {
        method: "POST", body: new URLSearchParams({ app_id: "cli_test", app_secret: "test-secret" }),
      });
      assert.equal(accepted.status, 200);
      await accepted.text();
      assert.deepEqual(await lark.credentials, { appId: "cli_test", appSecret: "test-secret" });
      const saved = await fetch(pasted.url, {
        method: "POST", body: new URLSearchParams({ SLACK_BOT_TOKEN: "xoxb-test" }),
      });
      assert.equal(saved.status, 200);
      await saved.text();
      await pasted.done;
      assert.deepEqual(kept, [["SLACK_BOT_TOKEN", "xoxb-test"]]);
      console.log("setup servers survived");
    } finally {
      await lark.close();
      await pasted.close();
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 10_000,
  });
  expect(stdout.trim()).toBe("setup servers survived");
});
