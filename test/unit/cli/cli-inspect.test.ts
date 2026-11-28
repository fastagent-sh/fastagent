import { describe, expect, it } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";

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
    const { code, stdout } = await runInProcess(["-C", dir, "info", "--json"], undefined, withoutModel());
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info).toMatchObject({
      starters: [],
      agent: { name: expect.any(String), description: null },
    });
    expect(info.harness).toBe("pi-durable");
    expect(info.sandbox).toBeNull();
    expect(info.codingTools).toEqual(["read", "write", "edit", "bash"]);
    expect(info.tools).toEqual(["lookup"]);
    expect(info.commands.map((command: { name: string }) => command.name)).toEqual(["skill:greet"]);
    await expect(stat(join(dir, ".state"))).rejects.toMatchObject({ code: "ENOENT" }); // read-only: never creates the state root
  });

  it("refuses a fastagent.config.ts in the old shape, saying its keys are top-level now", async () => {
    const dir = await agentWorkspace("fa-info-defaults-", {
      "fastagent.config.ts": 'export default { defaults: { model: "openai/gpt-5.5" } };\n',
    });
    const refused = await runInProcess(["-C", dir, "info"], undefined, withoutModel());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/fastagent\.config\.ts: unknown key "defaults": its keys are top-level now/);
    // The top-level shape is the one read.
    const flat = await agentWorkspace("fa-info-flat-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", codingTools: false, maxSteps: 8 };\n',
    });
    const read = await runInProcess(["-C", flat, "info", "--json"], undefined, withoutModel());
    expect(read.code, read.stderr).toBe(0);
    const parsed = JSON.parse(read.stdout);
    expect(parsed.model).toBe("openai/gpt-5.5");
    expect(parsed.codingTools).toEqual([]);
    expect(parsed.maxSteps).toBe(8);

    const badSteps = await agentWorkspace("fa-info-bad-steps-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", maxSteps: 0 };\n',
    });
    const badStepsRes = await runInProcess(["-C", badSteps, "info"], undefined, withoutModel());
    expect(badStepsRes.code).toBe(1);
    expect(badStepsRes.stderr).toMatch(/maxSteps/);
  });

  it("info says why the definition does not open, naming the module, as dev and start would refuse it", async () => {
    // One module's import failing is the registry's, so the agent does not open: said in one line, with the reason.
    const missing = await agentWorkspace("fa-info-toolfail-", {
      "src/tools/broken.ts": 'import "totally-not-a-real-package-xyz";\nexport default {};\n',
    });
    const failed = await runInProcess(["-C", missing, "info"], undefined, withoutModel());
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/totally-not-a-real-package-xyz/);
    expect(failed.stderr).not.toMatch(/\n\s+at /); // a refusal, not a stack
  });
});

describe("cli: info's MCP servers", () => {
  it("discovers project-root .mcp.json alongside fastagent.config.ts while ignoring editor dotfiles", async () => {
    const dir = await agentWorkspace("fa-cli-mcp-list-", {
      "fastagent.config.ts": `export default ${JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } })};\n`,
      ".mcp.json": JSON.stringify({ mcpServers: { tooling: { command: "npx" } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { ignored_editor: { command: "npx" } } }),
    });
    const info = await runInProcess(["info", "--json"], dir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).mcp).toEqual([
      { name: "tooling", transport: "stdio" },
      { name: "docs", transport: "http", url: "https://docs.example.com/mcp" },
    ]);
  });

  it("info reports harness and sandbox from config or CLI overrides, and refuses invalid combinations", async () => {
    const dir = await agentWorkspace("fa-info-harness-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5" };\n',
    });
    const dshFlag = await runInProcess(["-C", dir, "info", "--harness", "dsh", "--sandbox", "read-only", "--json"]);
    expect(dshFlag.code, dshFlag.stderr).toBe(0);
    expect(JSON.parse(dshFlag.stdout)).toMatchObject({ harness: "dsh", sandbox: "read-only" });

    const sandboxOnPi = await runInProcess(["-C", dir, "info", "--sandbox", "workspace"]);
    expect(sandboxOnPi.code).toBe(2);
    expect(sandboxOnPi.stderr).toMatch(/requires harness: "dsh"/);

    const invalidHarness = await runInProcess(["-C", dir, "info", "--harness", "../bad"]);
    expect(invalidHarness.code).toBe(2);
    expect(invalidHarness.stderr).toMatch(/invalid harness name/);

    const missingHarness = await runInProcess(["-C", dir, "info", "--harness", "bogus"]);
    expect(missingHarness.code).toBe(2);
    expect(missingHarness.stderr).toContain('harness "bogus" requires @fastagent-sh/harness-bogus');

    // Installed third-party harness with supportsSandbox: false: --sandbox exits 2 (usage), config sandbox exits 1 (startup).
    const customPkgDir = join(dir, "node_modules", "@fastagent-sh", "harness-nosb");
    await mkdir(customPkgDir, { recursive: true });
    await writeFile(
      join(customPkgDir, "package.json"),
      JSON.stringify({
        name: "@fastagent-sh/harness-nosb",
        type: "module",
        exports: { "./provider": "./provider.js" },
      }),
    );
    await writeFile(
      join(customPkgDir, "provider.js"),
      'export const harnessProvider = { name: "nosb", supportsSandbox: false, openStorage: () => ({ close() {} }), openAgent: async () => { throw new Error("unused"); } };\n',
    );
    const flagSandbox = await runInProcess(["-C", dir, "info", "--harness", "nosb", "--sandbox", "read-only"]);
    expect(flagSandbox.code).toBe(2);
    expect(flagSandbox.stderr).toContain('sandbox ("read-only") is not supported by harness "nosb"');

    const cfgDir = await agentWorkspace("fa-info-nosb-cfg-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "nosb", sandbox: "read-only" };\n',
    });
    const cfgPkgDir = join(cfgDir, "node_modules", "@fastagent-sh", "harness-nosb");
    await mkdir(cfgPkgDir, { recursive: true });
    await writeFile(
      join(cfgPkgDir, "package.json"),
      JSON.stringify({
        name: "@fastagent-sh/harness-nosb",
        type: "module",
        exports: { "./provider": "./provider.js" },
      }),
    );
    await writeFile(
      join(cfgPkgDir, "provider.js"),
      'export const harnessProvider = { name: "nosb", supportsSandbox: false, openStorage: () => ({ close() {} }), openAgent: async () => { throw new Error("unused"); } };\n',
    );
    const cfgSandbox = await runInProcess(["-C", cfgDir, "info"]);
    expect(cfgSandbox.code).toBe(1);
    expect(cfgSandbox.stderr).toContain('sandbox ("read-only") is not supported by harness "nosb"');

    const configured = await agentWorkspace("fa-info-dsh-cfg-", {
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "dsh", sandbox: "off" };\n',
    });
    const fromCfg = await runInProcess(["-C", configured, "info", "--json"]);
    expect(fromCfg.code, fromCfg.stderr).toBe(0);
    expect(JSON.parse(fromCfg.stdout)).toMatchObject({ harness: "dsh", sandbox: "off" });
  });

  it("inspects a bare zero-ceremony AAIF directory (AGENTS.md + .mcp.json, no fastagent.config.ts) and tracks .mcp.json secrets", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const bareDir = await mkdtemp(join(tmpdir(), "fa-info-bare-"));
    await writeFile(join(bareDir, "AGENTS.md"), "# Cloud Triage Agent\n");
    await writeFile(
      join(bareDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          duang: {
            type: "http",
            url: "https://duang.example.com/mcp",
            headers: { Authorization: `Bearer \${DUANG_API_TOKEN}` },
          },
        },
      }),
    );
    const env = withoutModel();
    delete env.DUANG_API_TOKEN;
    const res = await runInProcess(["-C", bareDir, "info", "--json"], undefined, env);
    expect(res.code, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcp).toEqual([{ name: "duang", transport: "http", url: "https://duang.example.com/mcp" }]);
    expect(parsed.secrets).toEqual([
      { name: "DUANG_API_TOKEN", optional: false, declaredIn: [".mcp.json mcpServers.duang"] },
    ]);
    expect(parsed.unsetSecrets).toEqual(["DUANG_API_TOKEN"]);

    // Malformed .mcp.json prints a clean one-line startup error without leaking a raw McpError stack trace.
    await writeFile(join(bareDir, ".mcp.json"), "{ invalid json");
    const badMcp = await runInProcess(["-C", bareDir, "info"], undefined, env);
    expect(badMcp.code).toBe(1);
    expect(badMcp.stderr).toMatch(/^Error: \.mcp\.json: invalid JSON:/);
    expect(badMcp.stderr).not.toMatch(/\n\s+at /);
  });
});
