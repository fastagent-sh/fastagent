import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

it("`mcp list` shows the program's servers and the ones the project's fastagent.json adds, and `info` the same", async () => {
  const dir = await agentWorkspace("fa-cli-mcp-list-", {
    "context.json": JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } }),
    "fastagent.json": JSON.stringify({ mcpServers: { notes: { type: "http", url: "https://notes.example.com/mcp" } } }),
    // The coding tools' file is not read.
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
  expect(refused.stderr).toMatch(/MCP server "docs" is declared by the program \(context\.json\) and by the instance/);
});

it("`mcp --env production` lists what `start` opens: the configuration named, never the project's own", async () => {
  const dir = await agentWorkspace("fa-cli-mcp-env-", {
    "context.json": JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } }),
    "fastagent.json": JSON.stringify({ mcpServers: { personal: { type: "http", url: "https://me.example.com/mcp" } } }),
  });
  const names = async (args: string[], env?: Record<string, string>) => {
    const listed = await runInProcess(["mcp", "list", dir, "--json", ...args], undefined, env);
    expect(listed.code, listed.stderr).toBe(0);
    return JSON.parse(listed.stdout).map((server: { name: string }) => server.name);
  };
  expect(await names([])).toEqual(["docs", "personal"]);
  expect(await names(["--env", "production"])).toEqual(["docs"]);
  const named = join(await mkdtemp(join(tmpdir(), "fa-cli-mcp-env-config-")), "production.json");
  await writeFile(
    named,
    JSON.stringify({ mcpServers: { deployed: { type: "http", url: "https://prod.example.com/mcp" } } }),
  );
  expect(await names(["--env", "production"], { FASTAGENT_CONFIG: named })).toEqual(["docs", "deployed"]);
  expect(await names([], { FASTAGENT_CONFIG: named })).toEqual(["docs", "deployed"]);
});
