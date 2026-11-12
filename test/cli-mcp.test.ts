import { writeFile } from "node:fs/promises";
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
