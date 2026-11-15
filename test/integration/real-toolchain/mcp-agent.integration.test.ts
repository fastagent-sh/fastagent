// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { openSource } from "../../harnesses/open-source.ts";
import { roots, agents, FIXTURE, directory, opened, ask } from "./mcp-agent-fixtures.ts";

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("an MCP ${VAR} reference is resolved from the instance's secrets, never from the process's environment", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  vi.stubEnv("FA_MCP_REF", "from-the-process");
  const dir = await directory({
    mcpServers: { constructor: { command: process.execPath, args: [FIXTURE], env: { MCP_VALUE: "${FA_MCP_REF}" } } },
  });
  await expect(openSource(dir, { secrets: {} })).rejects.toThrow(/FA_MCP_REF/);
  const agent = await opened(dir, { secrets: { FA_MCP_REF: "from-the-secrets" } });
  expect(JSON.parse((await ask(agent, "mcp__constructor__who")).answer?.text ?? "null")).toMatchObject({
    value: "from-the-secrets",
  });
});
