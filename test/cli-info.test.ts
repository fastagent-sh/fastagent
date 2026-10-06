import { describe, expect, it } from "vitest";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

describe("cli: info", () => {
  it("info reports the assembled surface as JSON (incl. load diagnostics), read-only (no sessions dir)", async () => {
    const dir = await agentWorkspace("fa-info-", {
      "fastagent.config.ts": "export default {};\n",
      "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greet warmly.\n---\nHi.\n",
      "skills/bad/SKILL.md": "---\nname: bad\n---\nno description.\n", // malformed
      "tools/lookup.mjs":
        'export default { description: "Lookup", parameters: { type: "object" }, async execute() { return "ok"; } };\n',
      "channels/github.ts": 'export default () => ({ "POST /x": () => new Response("ok") });\n',
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info.codingTools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
    expect(info.tools).toEqual(["lookup"]);
    expect(info.skills.map((s: { name: string }) => s.name)).toEqual(["greet"]); // the malformed skill is skipped
    expect(JSON.stringify(info.diagnostics)).toMatch(/description/); // info SURFACES loader diagnostics
    expect(info.channels).toEqual(["github"]);
    await expect(stat(join(dir, ".state"))).rejects.toThrow(); // read-only: never creates the state root
  });

  it("info RESOLVES the model spec against the agent's own models.json, and says so when it does not", async () => {
    // The docs point at `info` to confirm what an agent resolved, so it must not merely echo the spec:
    // a custom endpoint changes which specs exist, and reporting a healthy-looking one that `dev`/`start`
    // then reject is the failure this pre-empts. Read-only and non-fatal — diagnosing a broken agent is
    // the job, so the verdict is DATA (exit 0), not a throw.
    const dir = await agentWorkspace("fa-info-models-", {
      "models.json": JSON.stringify({
        providers: {
          mygw: {
            baseUrl: "http://vllm.internal:8000/v1",
            api: "openai-completions",
            apiKey: "$FA_TEST_KEY",
            models: [{ id: "deepseek-v3" }],
          },
        },
      }),
    });
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;

    const ok = JSON.parse((await run(["info", dir, "--json", "--model", "mygw/deepseek-v3"], undefined, env)).stdout);
    expect(ok.model).toBe("mygw/deepseek-v3");
    expect(ok.modelError).toBeNull(); // declared in models.json — it resolves

    const bad = await run(["info", dir, "--json", "--model", "mygw/not-declared"], undefined, env);
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.stdout).modelError).toMatch(/not in registry/);
  });

  it("info names the machine's models.json and says when the model's endpoint comes from it", async () => {
    const dir = await agentWorkspace("fa-info-machine-models-");
    const machine = join(dir, "machine-models.json");
    await writeFile(
      machine,
      JSON.stringify({
        providers: {
          localgw: {
            baseUrl: "http://127.0.0.1:8000/v1",
            api: "openai-completions",
            apiKey: "x",
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, FASTAGENT_MODELS_PATH: machine };
    delete env.FASTAGENT_MODEL;

    const report = JSON.parse((await run(["info", dir, "--json", "--model", "localgw/m"], undefined, env)).stdout);
    expect(report.modelError).toBeNull();
    expect(report.modelFromMachine).toBe(true);
    expect(report.machineModels).toEqual({ path: machine, inherited: ["localgw"], overridden: [] });
  });

  it("info degrades when a tool can't load (missing dep) — reports it, still shows the surface, exits 0", async () => {
    // The scaffold ships tools/ that import @fastagent-sh/fastagent; before `npm install` the import fails.
    // A broken tool file is ISOLATED (skipped + reported, not thrown) so it can't crash the load — info
    // reports it, and dev/start degrade the SAME way (G2): the agent keeps serving without that one tool.
    const dir = await agentWorkspace("fa-info-toolfail-", {
      "tools/broken.ts": 'import "totally-not-a-real-package-xyz";\nexport default {};\n',
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;

    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.tools).toEqual([]); // the broken tool isn't loaded…
    expect(JSON.stringify(info.toolFailures)).toMatch(/broken\.ts/); // …it's surfaced as a per-file load failure
    expect(info.toolError).toBeNull(); // isolated, so NOT a whole-load abort
    expect(info.skills).toEqual([]); // the rest of the surface still shows
    await expect(stat(join(dir, ".state"))).rejects.toThrow(); // still read-only

    // text mode: the tools line degrades and the reason goes to stderr as a warning
    const text = await run(["info", dir], undefined, env);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/tools:\s+\(none\)/); // the broken tool was skipped, nothing else to show
    expect(text.stderr).toMatch(/broken\.ts/); // the reason is a warning on stderr
  });

  it("info loads schedules — a broken one is reported (exit 0), a good one carries its next instant", async () => {
    // Same G2 isolation as tools: a broken schedule file (bad cron) is skipped + reported at info time,
    // not first at `dev`; the good schedule still shows, with its next fire instant.
    const dir = await agentWorkspace("fa-info-schedfail-", {
      "schedules/good.md": '---\ncron: "0 9 * * *"\ntz: UTC\n---\ndigest\n',
      "schedules/bad.md": "---\ncron: not a cron\n---\nx\n",
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;

    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.schedules).toHaveLength(1);
    expect(info.schedules[0]).toMatchObject({ name: "good", cron: "0 9 * * *" });
    expect(info.schedules[0].next).toMatch(/T09:00:00\.000Z$/); // loaded → the next instant is printable
    expect(JSON.stringify(info.scheduleFailures)).toMatch(/bad\.md/); // the broken one is surfaced per-file
    expect(info).not.toHaveProperty("selfSchedule"); // not a switch: every serve mounts the wake tool
    expect(info.codingTools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]); // omitted = everything

    // text mode: next instant on the schedules line, the failure as a stderr warning
    const text = await run(["info", dir], undefined, env);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/schedules:\s+good \(next .*T09:00:00\.000Z\)/);
    expect(text.stderr).toMatch(/bad\.md/);
  });
});
