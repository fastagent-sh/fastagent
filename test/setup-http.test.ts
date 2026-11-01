import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("malformed request URLs return 400 without killing either setup server", async () => {
  // An unhandled request-handler rejection terminates Node; isolate that failure from the test runner.
  const script = `
    import assert from "node:assert/strict";
    import { request } from "node:http";
    import { startLarkCredentialsPage } from ${JSON.stringify(new URL("../src/channels/lark/credentials-page.ts", import.meta.url).href)};
    import { startSlackSetupServer } from ${JSON.stringify(new URL("../src/channels/slack/setup-server.ts", import.meta.url).href)};

    const lark = await startLarkCredentialsPage({ consoleUrl: "https://open.larksuite.com", check: async () => {} });
    const slack = await startSlackSetupServer();
    try {
      for (const target of [lark.url, "http://127.0.0.1:" + slack.port + "/health"]) {
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
      console.log("setup servers survived");
    } finally {
      await lark.close();
      await slack.close();
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 10_000,
  });
  expect(stdout.trim()).toBe("setup servers survived");
});
