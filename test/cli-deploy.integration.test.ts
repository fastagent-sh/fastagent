import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run, runInProcess } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";
import { isRunning } from "./cli-deploy-fixtures.ts";

describe("cli: deploy", () => {
  it("warns that git would track a value file in the agent directory, and says nothing when it is ignored, outside it, or there is no checkout", async () => {
    const dir = await agentWorkspace("fa-deploy-tracked-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const file = join(dir, "prod.env");
    await writeFile(file, "OPENAI_API_KEY=sk\n");
    const tracked = /prod\.env holds secrets and is not ignored by git/;
    // Not a checkout: nothing git could commit.
    expect((await runInProcess(["deploy", "docker", dir, "--env-file", file])).stderr).not.toMatch(tracked);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // The scaffold's rules are `.env` and `.env.*`: this name is matched by none of them.
    const warned = await runInProcess(["deploy", "docker", dir, "--env-file", file, "--force"]);
    expect(warned.code, warned.stderr).toBe(0);
    expect(warned.stderr).toMatch(tracked);
    // Ignored by the author's own rule: silent.
    await writeFile(join(dir, ".gitignore"), "prod.env\n");
    expect((await runInProcess(["deploy", "docker", dir, "--env-file", file, "--force"])).stderr).not.toMatch(tracked);
    // Outside the directory: its own place to protect, and not the repository's.
    await writeFile(join(dir, ".gitignore"), "");
    const outside = join(await mkdtemp(join(tmpdir(), "fa-outside-values-")), "prod.env");
    await writeFile(outside, "OPENAI_API_KEY=sk\n");
    expect((await runInProcess(["deploy", "docker", dir, "--env-file", outside, "--force"])).stderr).not.toMatch(
      tracked,
    );
  });

  /** An `aws` and a `docker` on PATH that answer the reads before the build; `held` is what the secret holds. */
  async function fakeAwsAndDocker(held: string) {
    const bin = await mkdtemp(join(tmpdir(), "fa-aws-"));
    const called = join(bin, "called");
    await writeFile(
      join(bin, "aws"),
      `#!/bin/sh
echo "$@" >> ${called}
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"123456789012"}';;
  "configure get") echo us-west-2;;
  "cloudformation describe-stacks") echo "Stack with id x does not exist" >&2; exit 254;;
  "secretsmanager describe-secret") echo '{"Name":"x"}';;
  "secretsmanager get-secret-value") echo '${held}';;
  "bedrock-agentcore-control list-agent-runtimes") echo '{}';;
  *) exit 1;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh\necho "docker $@" >> ${called}\ncase "$1" in version|buildx) exit 0;; esac\nexit 1\n`,
      { mode: 0o755 },
    );
    return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls: () => readFile(called, "utf8") };
  }

  it("deploy agentcore --run with a login to redo and no terminal stops before the build and the stack", async () => {
    // Every AgentCore deploy wipes the runtime's login; with nobody to redo it, the deploy would replace a serving
    // runtime with one that cannot answer. Decided once the target's values are known, and before anything is built.
    const dir = await agentWorkspace("fa-deploy-ac-login-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const aws = await fakeAwsAndDocker("{}");
    const result = await runInProcess(["deploy", "agentcore", dir, "--run"], undefined, aws.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/wipes the runtime's openai login.*run this deploy in a terminal/);
    // The coding agent's way names this agent, run from wherever this deploy was; the key's variable is named.
    expect(result.stderr).toContain(
      `\`fastagent deploy agentcore ${dir} --run --json\`, which hands the login to its user`,
    );
    expect(result.stderr).toContain("fastagent secrets set agentcore OPENAI_API_KEY");
    const calls = await aws.calls();
    expect(calls).not.toMatch(/cloudformation deploy|ecr |s3 |s3api |docker buildx build|docker login/);
  });

  it("deploy agentcore --run goes on when the target already holds the model's key: there is no login to redo", async () => {
    const dir = await agentWorkspace("fa-deploy-ac-key-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const aws = await fakeAwsAndDocker('{"OPENAI_API_KEY":"sk"}');
    const result = await runInProcess(["deploy", "agentcore", dir, "--run"], undefined, aws.env);
    expect(result.stderr).not.toContain("wipes the runtime");
    // Past the stop: the docker CLI of the fake refuses, which is the next thing the deploy needs.
    expect(await aws.calls()).toContain("ecr describe-repositories");
  });

  it("deploy agentcore --run --json goes on past that stop: its ticket has someone to redo the login", async () => {
    const dir = await agentWorkspace("fa-deploy-ac-ticket-", {
      "fastagent.config.ts": `export default { defaults: { model: "${CODEX_MODEL}" } };\n`,
    });
    const bin = await mkdtemp(join(tmpdir(), "fa-aws-"));
    const called = join(bin, "called");
    await writeFile(join(bin, "aws"), `#!/bin/sh\necho "$@" >> ${called}\nexit 1\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const started = await run(["deploy", "agentcore", dir, "--run", "--json"], undefined, env);
    let report = JSON.parse(started.stdout);
    for (let tries = 0; report.status === "working" && tries < 40; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      report = JSON.parse((await run(["deploy", "agentcore", "--check", report.ticket], undefined, env)).stdout);
    }
    // Past the stop: the AWS CLI was asked, and what it answered is the ticket's reason.
    expect(report).toMatchObject({ status: "failed", deployment: "agentcore", message: expect.stringMatching(/AWS/) });
    expect(await readFile(called, "utf8")).toContain("sts get-caller-identity");
  });

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
