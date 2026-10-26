import { describe, expect, it } from "vitest";
import { stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

/** What `info` runs with: no model from this machine's shell. */
const withoutModel = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.FASTAGENT_MODEL;
  return env;
};

describe("cli: info", () => {
  it("info reports what the directory builds into as JSON, read-only (no state root)", async () => {
    const dir = await agentWorkspace("fa-info-", {
      "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greet warmly.\n---\nHi.\n",
      "skills/bad/SKILL.md": "---\nname: bad\n---\nno description.\n", // malformed: skipped
      "src/tools/lookup.mjs":
        'export default { name: "lookup", description: "Lookup", parameters: { type: "object" }, async execute() { return {}; } };\n',
      "src/channels/github.ts": 'export default () => ({ "POST /x": () => new Response("ok") });\n',
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const { code, stdout } = await run(["info", dir, "--json"], undefined, withoutModel());
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info.tools).toEqual(["lookup"]);
    expect(info.channels).toEqual([{ name: "github", ingress: "webhook" }]);
    expect(info.commands.map((command: { name: string }) => command.name)).toEqual(["skill:greet"]);
    await expect(stat(join(dir, ".state"))).rejects.toThrow(); // read-only: never creates the state root
  });

  it("info reports the declared environment without installing it, and says why a refused one stops the agent", async () => {
    // No mise is installed in this agent: `info` must not need one (it only reads the declaration).
    const environment = {
      packages: { jq: "1.8.1" },
      aptPackages: ["chromium"],
      variables: { FA_TEST_HOST: { description: "the GitHub host gh talks to" } },
    };
    const dir = await agentWorkspace("fa-info-env-", { "context.json": JSON.stringify({ environment }) });
    const ok = await run(["info", dir, "--json"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      environment,
      // Required like a tool's secret, attributed to the file that declares it.
      secrets: [
        {
          name: "FA_TEST_HOST",
          optional: false,
          declaredIn: ["context.json"],
          description: "the GitHub host gh talks to",
        },
      ],
      unsetSecrets: ["FA_TEST_HOST"],
    });
    expect((await run(["info", dir])).stdout).toMatch(/^secrets: +FA_TEST_HOST \(context\.json\)$/m);
    expect((await run(["info", dir])).stdout).toMatch(/^environment: +jq 1\.8\.1, apt:chromium$/m);
    await writeFile(
      join(dir, "context.json"),
      JSON.stringify({ content: { notes: { github: "acme/notes" } }, environment: { packages: { "cargo:x": "1" } } }),
    );
    // The environment's variables are part of what the agent declares, so a refused environment is a definition that
    // does not open: said as the refusal dev and start stop on, never a fall back to the machine's commands.
    const refused = await run(["info", dir, "--json"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/package "cargo:x" installs with cargo:/);
  });

  it("info RESOLVES the model spec against the definition's providers, and says so when it does not", async () => {
    // The docs point at `info` to confirm what an agent resolved, so it must not merely echo the spec: a provider in
    // code changes which specs exist, and reporting a healthy-looking one that `dev`/`start` then reject is the
    // failure this pre-empts. Non-fatal: diagnosing a broken agent is the job, so the verdict is DATA (exit 0).
    const dir = await agentWorkspace("fa-info-models-", {
      "fastagent.config.ts":
        'import { fauxProvider } from "@earendil-works/pi-ai";\n' +
        'export default { providers: [fauxProvider({ provider: "gw", models: [{ id: "m1" }] }).provider] };\n',
    });
    await symlink(new URL("../node_modules", import.meta.url).pathname, join(dir, "node_modules"), "dir");

    const ok = JSON.parse((await run(["info", dir, "--json", "--model", "gw/m1"], undefined, withoutModel())).stdout);
    expect(ok.model).toBe("gw/m1");
    expect(ok.modelError).toBeNull(); // the definition's provider offers it

    const bad = await run(["info", dir, "--json", "--model", "gw/not-declared"], undefined, withoutModel());
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.stdout).modelError).toBe('no provider "gw" offers "not-declared"');
  });

  it("info says why the definition does not open, naming the module, as dev and start would refuse it", async () => {
    // One module's import failing is the registry's, so the agent does not open: said in one line, with the reason.
    const missing = await agentWorkspace("fa-info-toolfail-", {
      "src/tools/broken.ts": 'import "totally-not-a-real-package-xyz";\nexport default {};\n',
    });
    const failed = await run(["info", missing], undefined, withoutModel());
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/totally-not-a-real-package-xyz/);
    expect(failed.stderr).not.toMatch(/\n\s+at /); // a refusal, not a stack

    // A schedule its cron refuses is the same: the agent would not start on it.
    const badCron = await agentWorkspace("fa-info-schedfail-", {
      "src/schedules/bad.ts": 'export default { kind: "fastagent.schedule", cron: "not a cron", prompt: "x" };\n',
    });
    const refused = await run(["info", badCron], undefined, withoutModel());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/src\/schedules\/bad\.ts/);
  });

  it("info carries each schedule's next instant", async () => {
    const dir = await agentWorkspace("fa-info-sched-", {
      "src/schedules/good.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * *", tz: "UTC", prompt: "digest" };\n',
    });
    const { code, stdout } = await run(["info", dir, "--json"], undefined, withoutModel());
    expect(code).toBe(0);
    const info = JSON.parse(stdout);
    expect(info.schedules).toEqual([
      { name: "good", cron: "0 9 * * *", tz: "UTC", next: expect.stringMatching(/T09:00:00\.000Z$/) },
    ]);
    const text = await run(["info", dir], undefined, withoutModel());
    expect(text.stdout).toMatch(/schedules:\s+good \(next .*T09:00:00\.000Z\)/);
  });
});
