import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";
import { isRunning } from "./cli-deploy-fixtures.ts";

// A deploy's step that runs a host CLI's own sign-in: that sign-in is a process of the host CLI's (host-login.ts spawns it),
// and `--stop` stops it with the step. The rest of a deploy's ticket is cli-deploy-ticket.test.ts's, in process.
describe("cli: deploy", () => {
  it.each([
    [
      "fly",
      'case "$1 $2" in "auth whoami") exit 1;; "auth login") echo "Open https://fly.io/app/auth/cli/abc123"; sleep 30;; esac',
      // A code the approval page shows comes back through --check --code.
      { url: "https://fly.io/app/auth/cli/abc123", resume_command: expect.stringMatching(/--check \w+ --code/) },
    ],
    [
      "railway",
      'case "$1" in whoami) exit 1;; login) echo "https://railway.com/activate?user_code=AB-12" >&2; sleep 30;; esac',
      { url: "https://railway.com/activate?user_code=AB-12", code: "AB-12" },
    ],
  ])("deploy %s --run --json hands a signed-out host CLI's sign-in to the person", async (host, body, expected) => {
    const dir = await agentWorkspace(`fa-deploy-${host}-login-`, {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "OPENAI_API_KEY=sk\n",
    });
    const bin = await mkdtemp(join(tmpdir(), "fa-host-cli-"));
    await writeFile(join(bin, host), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    let report = JSON.parse((await run(["deploy", host, dir, "--run", "--json"], undefined, env)).stdout);
    try {
      for (let tries = 0; report.status === "working" && tries < 40; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        report = JSON.parse((await run(["deploy", host, "--check", report.ticket], undefined, env)).stdout);
      }
      expect(report).toMatchObject({
        status: "need_user_action",
        deployment: host,
        ...expected,
        stop_command: `fastagent deploy ${host} --check ${report.ticket} --stop --json`,
      });
      // The way out of a deploy no deadline cuts: stopped where it is, with what it started.
      const stopped = await run(["deploy", host, "--check", report.ticket, "--stop", "--json"], undefined, env);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        status: "failed",
        message: expect.stringMatching(/^stopped on request/),
      });
    } finally {
      const ticket = JSON.parse(
        await readFile(
          join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${report.ticket}.json`),
          "utf8",
        ),
      );
      expect(ticket.pid === undefined || !isRunning(ticket.pid)).toBe(true);
      if (ticket.pid && isRunning(ticket.pid)) process.kill(ticket.pid);
    }
  });
});
