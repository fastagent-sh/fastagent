import { describe, expect, it, vi } from "vitest";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, besideAgent, runInProcess } from "../../doubles/cli-run.ts";
import { gitAnswersIn } from "../../doubles/git-double.ts";

vi.mock("../../../src/git.ts", () => import("../../doubles/git-double.ts"));

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
    const { code, stdout } = await runInProcess(["info", dir, "--json"], undefined, withoutModel());
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info).toMatchObject({
      description: null,
      starters: [],
      agent: { name: expect.any(String), description: null },
    });
    expect(info.tools).toEqual(["lookup"]);
    expect(info.channels).toEqual([{ name: "github", ingress: "webhook" }]);
    expect(info.commands.map((command: { name: string }) => command.name)).toEqual(["skill:greet"]);
    await expect(stat(join(dir, ".state"))).rejects.toMatchObject({ code: "ENOENT" }); // read-only: never creates the state root
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

describe("cli: mcp list", () => {
  it("shows the program's servers and the ones the project's fastagent.json adds, and `info` the same", async () => {
    const dir = await agentWorkspace("fa-cli-mcp-list-", {
      "fastagent.config.ts": `export default ${JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } })};\n`,
      "fastagent.json": JSON.stringify({
        mcpServers: { notes: { type: "http", url: "https://notes.example.com/mcp" } },
      }),
      ".mcp.json": JSON.stringify({ mcpServers: { tooling: { command: "npx" } } }),
    });
    const listed = await runInProcess(["mcp", "list", dir, "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).map((server: { name: string }) => server.name)).toEqual(["docs", "notes"]);
    const info = await runInProcess(["info", "--json"], dir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).mcp.map((server: { name: string }) => server.name)).toEqual(["docs", "notes"]);

    await writeFile(join(dir, "fastagent.json"), JSON.stringify({ mcpServers: { docs: { command: "node" } } }));
    const refused = await runInProcess(["mcp", "list", dir, "--json"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(
      /MCP server "docs" is declared by the program \(fastagent\.config\.ts\) and by the instance/,
    );
  });
});

describe("cli: content", () => {
  it("adds, lists as JSON, removes content, and exits 2 on an unknown name", async () => {
    const dir = await agentWorkspace("fa-cli-content-");
    const rawDocsDir = besideAgent(dir, "docs");
    await mkdir(rawDocsDir, { recursive: true });
    const docsDir = await realpath(rawDocsDir);
    gitAnswersIn(docsDir, { "rev-parse --show-toplevel": undefined });

    const added = await runInProcess(["content", "add", docsDir, dir]);
    expect(added.code, added.stderr).toBe(0);

    const listed = await runInProcess(["content", "list", dir, "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).content).toEqual([expect.objectContaining({ name: "docs", location: docsDir })]);

    const removed = await runInProcess(["content", "remove", "docs", dir]);
    expect(removed.code, removed.stderr).toBe(0);

    const missing = await runInProcess(["content", "remove", "docs", dir]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/no content named "docs"/);
  });
});
