import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run, whileRunning } from "./cli-run.ts";

describe("cli: process contracts", () => {
  it("a command ENTERS the agent's environment: a proxy declared only in .env carries the definition's fetch", async () => {
    // The WIRING half of #474 (the policy itself is test/proxy.test.ts): a real CLI process, a proxy that exists
    // nowhere but the agent's `.env`, and authored code that fetches as it loads. `enterAgentEnv` is what makes the two
    // steps inseparable — the bug was commands that did only the first. The reserved .invalid host resolves
    // nowhere, so a direct connection cannot pass.
    const requests: string[] = [];
    const proxy = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proxied");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      const dir = await agentWorkspace("fa-tool-proxy-", {
        ".secrets/.env": `HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\n`,
        "fastagent.config.ts":
          `const res = await fetch("http://tool-proxy.invalid/probe");\n` +
          `if ((await res.text()) !== "proxied") throw new Error("not proxied");\n` +
          `export default {};\n`,
      });
      const env = { ...process.env };
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
        delete env[key]; // the proxy must come from the agent's .env, read inside the command
      }

      const { code, stderr } = await run(["info", dir], undefined, env);
      expect(code, stderr).toBe(0);
      expect(requests).toContain("http://tool-proxy.invalid/probe");
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("start serves no Agent API a definition turns off, a key the host still holds from an earlier deploy included", async () => {
    const dir = await agentWorkspace("fa-start-api-off-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini", http: { api: false } };\n`,
      ".secrets/production/.env": "FASTAGENT_API_KEY=left-on-the-host\nOPENAI_API_KEY=sk-test\n",
    });
    await whileRunning(
      ["start", dir, "--port", "0", "--bind", "127.0.0.1", "--no-input"],
      /Agent API: .*\n/,
      async (stderr) => {
        expect(stderr).toContain("Agent API: not served — fastagent.config.ts says http.api: false");
        const port = /http host on 127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
        const answer = await fetch(`http://127.0.0.1:${port}/v1/agent`, {
          headers: { authorization: "Bearer left-on-the-host" },
        });
        expect(answer.status).toBe(404);
      },
    );
  });

  it("invoke --url reaches a deployment through the proxy the agent's .env declares", async () => {
    const requests: string[] = [];
    const proxy = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("the proxy's own answer");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      const dir = await agentWorkspace("fa-invoke-url-proxy-", {
        ".secrets/.env": `HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\n`,
      });
      const env = { ...process.env };
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
        delete env[key];
      }
      // The reserved .invalid host resolves nowhere, so only the proxy can carry the request.
      await run(["invoke", "--url", "http://deployment.invalid", "--key", "k", "hello", dir], undefined, env);
      expect(requests).toContain("POST http://deployment.invalid/v1/sessions");
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("start selects production before loading config, even when spawned with dev environment marks", async () => {
    const dir = await agentWorkspace("fa-start-environment-", {
      "fastagent.config.ts": `throw new Error("selected " + process.env.FASTAGENT_ENVIRONMENT + ":" + process.env.FEISHU_APP_ID);\n`,
      ".secrets/.env": "FEISHU_APP_ID=cli_dev\n",
      ".secrets/production/.env": "FEISHU_APP_ID=cli_production\n",
    });
    const env: NodeJS.ProcessEnv = { ...process.env, FASTAGENT_ENVIRONMENT: "dev", FASTAGENT_DEV: "1" };
    delete env.FEISHU_APP_ID;
    const result = await run(["start", dir, "--no-input"], undefined, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("selected production:cli_production");
  });

  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  // One command is enough through the real binary: that a missing required argument is exit 2 on
  // EVERY command is cli-kernel.test.ts's, against the spec table.
  it("invoke without a message is a usage error on stderr, exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'message'/);
    expect(stdout).toBe("");
  });

  it("invoke surfaces a startup error to stderr, keeps stdout empty, exits non-zero", async () => {
    const cwd = await agentWorkspace("fa-cli-inv-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // no model source → assembly fails before any model call (no auth needed)
    const { code, stdout, stderr } = await run(["invoke", "hi", cwd], undefined, env);
    expect(code).toBe(2); // the choice a terminal's picker would have asked for: a usage error
    expect(stderr).toMatch(/missing model/);
    expect(stdout).toBe(""); // a failure never pollutes stdout
  });

  it("start fails when a declared channel cannot mount, instead of serving without it", async () => {
    const dir = await agentWorkspace("fa-cli-channel-fail-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-5.5" };\n`,
      "src/channels/telegram.mjs": `export default () => { throw new Error("TELEGRAM_SECRET_TOKEN required"); };\n`,
    });

    const { code, stderr } = await run(["start", dir, "--port", "0"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/TELEGRAM_SECRET_TOKEN required/);
    expect(stderr).not.toMatch(/routes:/);
  });

  it("a directory that is not an agent fails as a one-line startup error, not a raw stack", async () => {
    // resolvePlacement throws SYNCHRONOUSLY, before any .catch(failStartup) chain exists — without
    // placementOrExit the refusal surfaced as an uncaught stack trace (found in acceptance).
    const dir = await mkdtemp(join(tmpdir(), "fa-not-an-agent-"));
    await writeFile(join(dir, "AGENTS.md"), "# just a project\n"); // context, not a definition
    const { code, stderr } = await run(["info", dir]);
    expect(code).toBe(1); // runtime failure, not a crash
    expect(stderr).toMatch(/^Error: .*not a fastagent agent.*fastagent init/); // the one-line failStartup presentation
    expect(stderr).not.toMatch(/\n\s+at /); // no stack frames — this is a user-fixable refusal, not a bug
  });
});
