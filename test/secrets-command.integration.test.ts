import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { deploymentName } from "../src/deploy/deployment-name.ts";
import { toFlyAppName } from "../src/deploy/fly/plan.ts";
import { run, runInProcess, besideAgent } from "./cli-run.ts";
import { agent, read, fakeFly, fakeAws, realStdin } from "./secrets-command-fixtures.ts";

afterEach(() => {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
});

describe("secrets list", () => {
  it("prints every declared name with whether the target holds it, the model's key included, and no value", async () => {
    const fly = await fakeFly(["GH_TOKEN"]);
    // The project's own files hold values too: a deployment reads none of them, and no value is ever printed.
    const dir = await agent({
      ".secrets/production/.env": "GH_TOKEN=ghp_secret\n",
      ".secrets/.env": "SENTRY_DSN=dsn_secret\n",
    });
    fly.env.FAKE_FLY_APP_EXISTS = "1";
    fly.env.FAKE_FLY_APP = toFlyAppName(await deploymentName(dir));
    const result = await runInProcess(["secrets", "list", "fly", dir, "--json"], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      host: "Fly",
      exists: true,
      secrets: [
        // The model's key is known, and optional: OpenAI has a login to run on the box instead.
        { name: "OPENAI_API_KEY", set: false, required: false, hint: "your model provider key, or a login on the box" },
        { name: "GH_TOKEN", set: true, required: true, hint: expect.stringContaining("required by") },
        { name: "SENTRY_DSN", set: false, required: false },
      ],
    });
    expect(result.stdout).not.toContain("ghp_secret");
    expect(result.stdout).not.toContain("dsn_secret");
    const text = await runInProcess(["secrets", "list", "fly", dir], undefined, fly.env);
    expect(text.stdout).toMatch(
      /^missing {2}OPENAI_API_KEY {2}\(optional: your model provider key, or a login on the box\)$/m,
    );
    expect(text.stdout).toMatch(/^set {6}GH_TOKEN/m);
  });
});

describe("secrets list, for a target with no app yet", () => {
  it("says every name is missing and that the first set, push or deploy makes the app, instead of failing", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    const result = await runInProcess(["secrets", "list", "fly", dir, "--json"], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { exists: boolean; secrets: { name: string; set: boolean }[] };
    expect(report.exists).toBe(false);
    expect(report.secrets.every((entry) => !entry.set)).toBe(true);
    expect(result.stderr).toContain("Fly has no app for this agent yet");
    // Nothing was made to find out.
    expect((await fly.calls()).some((call) => call.startsWith("apps create"))).toBe(false);
  });
});

describe("secrets push", () => {
  it("sets the declared names a file holds, and says which it did not push because nothing declares them", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    const other = besideAgent(dir, "other.env");
    await writeFile(other, "GH_TOKEN=ghp_x\nSENTRY_DSN=https://dsn\nUNDECLARED=nope\nEMPTY=\n");
    const result = await runInProcess(["secrets", "push", "fly", dir, "--env-file", other], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    const staged = await fly.stdin();
    expect(staged).toContain("ghp_x");
    expect(staged).toContain("https://dsn");
    expect(staged).not.toContain("nope");
    expect(result.stderr).toContain("not pushed, since the definition does not declare them: UNDECLARED, EMPTY");
    expect(result.stderr).not.toContain("ghp_x"); // names are said, values are not
  });

  it("--from-env takes only declared names from the environment of the command that injected them", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    const env = { ...fly.env, GH_TOKEN: "ghp_env", HOME_SECRET: "not declared" };
    const result = await runInProcess(["secrets", "push", "fly", dir, "--from-env"], undefined, env);
    expect(result.code, result.stderr).toBe(0);
    const staged = await fly.stdin();
    expect(staged).toContain("ghp_env");
    expect(staged).not.toContain("not declared");
  });

  it("has no default source: the project's files are not read, and the environment only when asked for", async () => {
    const fly = await fakeFly([]);
    const dir = await agent({
      ".secrets/.env": "GH_TOKEN=from-dev\n",
      ".secrets/production/.env": "GH_TOKEN=from-start\n",
    });
    const none = await runInProcess(["secrets", "push", "fly", dir], undefined, { ...fly.env, GH_TOKEN: "ghp_env" });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("a deployment has no default file to push from: pass --env-file <file>");
    expect((await fly.calls()).some((call) => call.startsWith("secrets set"))).toBe(false);
  });

  it("on Fly: each declared name goes in with `NAME=-` over stdin, creating the app first, exactly as the file holds it, restarting once", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    const values = besideAgent(dir, "fly.env");
    await writeFile(values, "GH_TOKEN=ghp_x\nSENTRY_DSN=https://dsn.example/a#b\nUNDECLARED=nope\n");
    const result = await runInProcess(["secrets", "push", "fly", dir, "--env-file", values], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    const calls = await fly.calls();
    expect(calls.some((c) => c.startsWith("apps create "))).toBe(true);
    const sets = calls.filter((c) => c.startsWith("secrets set"));
    // Every value but the last is staged, so a running app restarts once.
    expect(sets).toEqual([
      expect.stringMatching(/^secrets set --stage -a \S+ GH_TOKEN=-$/),
      expect.stringMatching(/^secrets set -a \S+ SENTRY_DSN=-$/),
    ]);
    expect(await fly.stdin()).toBe("ghp_x\nhttps://dsn.example/a#b\n");
    expect(calls.join("\n")).not.toContain("ghp_x"); // never argv
  });
});

describe("secrets set", () => {
  it("--generate sets a random value and prints it once, on stdout, for what FastAgent makes itself", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    const result = await runInProcess(
      ["secrets", "set", "fly", "FASTAGENT_API_KEY", dir, "--generate"],
      undefined,
      fly.env,
    );
    expect(result.code, result.stderr).toBe(0);
    const printed = result.stdout.trim();
    expect(printed).toMatch(/^[\w-]{43}$/);
    expect(await fly.stdin()).toBe(`${printed}\n`);
    expect(result.stderr).not.toContain(printed);
    // Kept nowhere on this machine: it is shown once, and the person who made it holds it.
    for (const file of [".secrets/.env", ".secrets/production/.env"]) {
      await expect(read(join(dir, file))).rejects.toThrow();
    }
  });

  it("--generate's stdout is the key and nothing else, whatever the host CLI prints", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    // A real process, since what is under test is where a child's stdout goes.
    const result = await run(["secrets", "set", "fly", "FASTAGENT_API_KEY", dir, "--generate"], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^[\w-]{43}\n$/);
    // The host CLI's own lines are still said, on stderr.
    expect(result.stderr).toContain("New app created");
    expect(result.stderr).toContain("Secrets are staged");
  }, 30_000);

  it("without a terminal reads the value from standard input, never the command line", async () => {
    const fly = await fakeFly(["GH_TOKEN"]);
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["ghp_from_stdin\n"]), configurable: true });
    const result = await runInProcess(["secrets", "set", "fly", "GH_TOKEN", dir], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    expect(await fly.stdin()).toBe("ghp_from_stdin\n");
    expect((await fly.calls()).join("\n")).not.toContain("ghp_from_stdin");
    expect(result.stdout).toBe("");
  });

  it("warns that a name no declaration reads reaches nothing, and refuses what is not a variable name", async () => {
    const fly = await fakeFly([]);
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["v\n"]), configurable: true });
    const stray = await runInProcess(["secrets", "set", "fly", "STRAY", dir], undefined, fly.env);
    expect(stray.code, stray.stderr).toBe(0);
    expect(stray.stderr).toContain("warn: STRAY is not declared by the definition, so nothing reads it on Fly");
    const bad = await runInProcess(["secrets", "set", "fly", "not a name", dir], undefined, fly.env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not an environment variable name");
  });
});

describe("secrets on AgentCore (one Secrets Manager secret)", () => {
  it("list: a deployment with no secret yet holds nothing, and nothing is created", async () => {
    const aws = await fakeAws();
    const dir = await agent();
    const result = await runInProcess(["secrets", "list", "agentcore", dir, "--json"], undefined, aws.env);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ host: "AWS Secrets Manager", exists: false });
    expect(await aws.held()).toBeUndefined();
    expect(result.stderr).toContain("has no app for this agent yet");
  });

  it("set: creates the secret, merges the value without argv, and says when a running session sees it", async () => {
    const aws = await fakeAws();
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["ghp_value\n"]), configurable: true });
    const result = await runInProcess(["secrets", "set", "agentcore", "GH_TOKEN", dir], undefined, aws.env);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse((await aws.held()) as string)).toEqual({ GH_TOKEN: "ghp_value" });
    expect((await aws.calls()).join("\n")).not.toContain("ghp_value");
    expect(result.stderr).toContain("the runtime reads the secret when a session starts");
  });

  it("push: only declared names go in, the Agent API's key is not one of them (AgentCore does not serve it), and others stay", async () => {
    const aws = await fakeAws('{"KEEP":"1"}');
    const dir = await agent();
    await writeFile(join(dir, "values.env"), "GH_TOKEN=ghp_x\nFASTAGENT_API_KEY=nope\nUNDECLARED=nope\n");
    const result = await runInProcess(
      ["secrets", "push", "agentcore", dir, "--env-file", join(dir, "values.env")],
      undefined,
      aws.env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse((await aws.held()) as string)).toEqual({ KEEP: "1", GH_TOKEN: "ghp_x" });
    expect(result.stderr).toContain("FASTAGENT_API_KEY");
  });
});

describe("secrets with a github content entry", () => {
  it("knows GITHUB_TOKEN as the host's clone reads it: `push` sets it, and `set` does not warn it is unread", async () => {
    const fly = await fakeFly([]);
    const dir = await agent({ "context.json": JSON.stringify({ content: { app: { github: "acme/app" } } }) });
    const values = besideAgent(dir, "clone.env");
    await writeFile(values, "GH_TOKEN=ghp_x\nGITHUB_TOKEN=ghp_clone\n");
    const listed = await runInProcess(["secrets", "list", "fly", dir, "--json"], undefined, fly.env);
    expect(JSON.parse(listed.stdout).secrets).toContainEqual(
      expect.objectContaining({ name: "GITHUB_TOKEN", set: false, required: false }),
    );
    const pushed = await runInProcess(["secrets", "push", "fly", dir, "--env-file", values], undefined, fly.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await fly.stdin()).toContain("ghp_clone");
    Object.defineProperty(process, "stdin", { value: Readable.from(["ghp_other\n"]), configurable: true });
    const set = await runInProcess(["secrets", "set", "fly", "GITHUB_TOKEN", dir], undefined, fly.env);
    expect(set.stderr).not.toContain("is not declared");
  });
});
