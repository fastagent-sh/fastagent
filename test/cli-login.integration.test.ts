import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

describe("cli: login and models", () => {
  it("login --deployment without a terminal: the ticket's process holds the box's shell until the box answers", async () => {
    const dir = await agentWorkspace("fa-login-deployment-ticket-");
    const bin = await mkdtemp(join(tmpdir(), "fa-fake-docker-"));
    // The box, as `docker compose exec` reaches it: a device sign-in's page and code, then the box's result.
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
echo "$@" > "${bin}/args"
echo '{"type":"open","url":"https://auth.example/device","userCode":"AB-12"}'
sleep 1
echo '{"type":"result","ok":true,"provider":"openai","method":"oauth","path":"/data/.secrets/auth.json"}'
`,
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const started = await run(["login", "openai", "--method", "account", "--deployment", "docker", "--json"], dir, env);
    expect(started.code).toBe(0);
    const ticket = JSON.parse(started.stdout);
    expect(ticket).toMatchObject({
      status: "need_user_action",
      provider: "openai",
      deployment: "docker",
      url: "https://auth.example/device",
      code: "AB-12",
      check_command: `fastagent login --check ${ticket.ticket} --json`,
    });
    expect(await readFile(join(bin, "args"), "utf8")).toContain("login --stdio openai --method account");
    // One subject with a sign-in to openai on this machine: both hold its callback port here, so each replaces the other.
    const stored = JSON.parse(
      await readFile(
        join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${ticket.ticket}.json`),
        "utf8",
      ),
    );
    expect(stored).toMatchObject({ subject: "login:openai", fields: { deployment: "docker" } });
    let checked: { status: string } = ticket;
    for (let tries = 0; checked.status === "need_user_action" && tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      checked = JSON.parse((await run(["login", "--check", ticket.ticket, "--json"], dir, env)).stdout);
    }
    expect(checked).toMatchObject({ status: "done", provider: "openai", deployment: "docker" });
  });
});
