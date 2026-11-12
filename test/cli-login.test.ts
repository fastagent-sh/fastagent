import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, runInProcess, withRepoModules } from "./cli-run.ts";

describe("cli: login and models", () => {
  it("login OUTSIDE an agent announces the global credential — the scope switch is never silent", async () => {
    // Every other command refuses a non-agent dir; login has the one legitimate fallback (there is no
    // project credential to write). It must SAY so: the global file is not what dev/start in a real
    // agent would read, so a silent switch would strand the credential invisibly.
    const home = await mkdtemp(join(tmpdir(), "fa-login-global-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-global-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.FASTAGENT_AUTH_PATH;
    const { code, stderr } = await runInProcess(["login", "no-such-provider"], cwd, env);
    expect(code).not.toBe(0);
    // The marker names itself, at both positions the lookup checks.
    expect(stderr).toMatch(/no agent here \(no fastagent\.config\.ts\)/);
    await expect(stat(join(cwd, ".secrets"))).rejects.toMatchObject({ code: "ENOENT" }); // nothing created in the non-agent dir

    // …and it is silent when FASTAGENT_AUTH_PATH outranks the fallback: an announcement naming a file the
    // run does not write would be worse than none.
    const directed = await runInProcess(["login", "no-such-provider"], cwd, {
      ...env,
      FASTAGENT_AUTH_PATH: join(cwd, "auth.json"),
    });
    expect(directed.stderr).not.toMatch(/logging in GLOBALLY/);

    // Standing INSIDE an agent is NOT "outside an agent" — findAgentDir refuses that position with
    // its own way out, and login must tell the same story as every other command instead of quietly
    // switching scope.
    const inside = join(cwd, "agent", "tools");
    await mkdir(inside, { recursive: true });
    await writeFile(join(cwd, "agent", "fastagent.config.ts"), "export default {};\n");
    const nested = await runInProcess(["login", "no-such-provider"], inside, env);
    expect(nested.stderr).toMatch(/is inside the agent .* — run from/);
    expect(nested.stderr).not.toMatch(/logging in GLOBALLY/);
  });

  it("models in an agent lists its definition's providers, without the secrets a serve needs", async () => {
    // A secret not filled in yet (`add telegram` writes none) stops dev and start; listing models must not need it.
    const dir = await agentWorkspace("fa-models-shape-", {
      "fastagent.config.ts":
        'import { fauxProvider } from "@earendil-works/pi-ai";\n' +
        "export default { providers: [{\n" +
        '  kind: "fastagent.needs", secrets: [{ name: "FA_TEST_GATEWAY_KEY", optional: false }],\n' +
        '  build: () => fauxProvider({ provider: "gw", models: [{ id: "m1" }] }).provider,\n' +
        "}] };\n",
    });
    await withRepoModules(dir);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FA_TEST_GATEWAY_KEY;
    const listed = await runInProcess(["models", "gw/"], dir, env);
    expect([listed.code, listed.stdout.trim()], listed.stderr).toEqual([0, "gw/m1"]);
    const json = await runInProcess(["models", "gw/", "--json"], dir, env);
    expect(JSON.parse(json.stdout)).toEqual([{ spec: "gw/m1", provider: "gw", id: "m1", name: "m1" }]);
  });

  it("without a terminal, a choice not given is answered with the choices and a command for each (exit 2)", async () => {
    // runInProcess() pipes stdio, as a coding agent's shell does.
    const cwd = await agentWorkspace("fa-login-agent-");
    const unnamed = await runInProcess(["login"], cwd);
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toMatch(/name the provider to sign in to \(one of .*openai-codex.*\)/);
    const both = await runInProcess(["login", "OpenAI", "--json"], cwd);
    expect(both.code).toBe(2);
    expect(JSON.parse(both.stdout)).toMatchObject({
      status: "need_choice",
      message: "OpenAI signs in with an account or an API key: pass --method account or --method api-key",
      choices: [
        {
          provider: "openai",
          method: "account",
          label: "Sign in with ChatGPT",
          command: "fastagent login openai --method account --json",
        },
        { provider: "openai", method: "api-key", command: "fastagent login openai --method api-key --json" },
      ],
      agent_next_steps: expect.stringContaining("Ask the user which"),
    });
    expect((await runInProcess(["login", "openai", "--method", "key"], cwd)).stderr).toMatch(
      /--method must be account or api-key/,
    );
  });
});
