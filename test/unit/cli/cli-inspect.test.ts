import { describe, expect, it, vi } from "vitest";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";

vi.mock("../../../packages/fastagent/src/git.ts", () => import("../../doubles/git-double.ts"));

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
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const { code, stdout } = await runInProcess(["info", dir, "--json"], undefined, withoutModel());
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info).toMatchObject({
      starters: [],
      agent: { name: expect.any(String), description: null },
    });
    expect(info.tools).toEqual(["lookup"]);
    expect(info.commands.map((command: { name: string }) => command.name)).toEqual(["skill:greet"]);
    await expect(stat(join(dir, ".state"))).rejects.toMatchObject({ code: "ENOENT" }); // read-only: never creates the state root
  });

  it("refuses a fastagent.config.ts in the old shape, saying its keys are top-level now", async () => {
    const dir = await agentWorkspace("fa-info-defaults-", {
      "fastagent.config.ts": 'export default { defaults: { model: "openai/gpt-5.5" } };\n',
    });
    const refused = await runInProcess(["info", dir], undefined, withoutModel());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/fastagent\.config\.ts: unknown key "defaults": its keys are top-level now/);
    // The top-level shape is the one read.
    const flat = await agentWorkspace("fa-info-flat-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5" };\n',
    });
    const read = await runInProcess(["info", flat, "--json"], undefined, withoutModel());
    expect(read.code, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).model).toBe("openai/gpt-5.5");
  });

  it("info says why the definition does not open, naming the module, as dev and start would refuse it", async () => {
    // One module's import failing is the registry's, so the agent does not open: said in one line, with the reason.
    const missing = await agentWorkspace("fa-info-toolfail-", {
      "src/tools/broken.ts": 'import "totally-not-a-real-package-xyz";\nexport default {};\n',
    });
    const failed = await runInProcess(["info", missing], undefined, withoutModel());
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/totally-not-a-real-package-xyz/);
    expect(failed.stderr).not.toMatch(/\n\s+at /); // a refusal, not a stack

    // A schedule its cron refuses is the same: the agent would not start on it.
    const badCron = await agentWorkspace("fa-info-schedfail-", {
      "src/schedules/bad.ts": 'export default { kind: "fastagent.schedule", cron: "not a cron", prompt: "x" };\n',
    });
    const refused = await runInProcess(["info", badCron], undefined, withoutModel());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/src\/schedules\/bad\.ts/);
  });
});

describe("cli: info's MCP servers", () => {
  it("are the program's, and nothing a tool's own file declares", async () => {
    const dir = await agentWorkspace("fa-cli-mcp-list-", {
      "fastagent.config.ts": `export default ${JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } })};\n`,
      ".mcp.json": JSON.stringify({ mcpServers: { tooling: { command: "npx" } } }),
    });
    const info = await runInProcess(["info", "--json"], dir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).mcp).toEqual([
      { name: "docs", transport: "http", url: "https://docs.example.com/mcp" },
    ]);
  });
});
