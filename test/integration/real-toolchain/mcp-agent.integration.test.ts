// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openSource } from "../../harnesses/open-source.ts";
import { inspectMcp } from "../../../src/mcp/host.ts";
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

it("an instance adds servers through its configuration, beside the program's, and a name in both refuses the open", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const dir = await directory({ mcpServers: { constructor: { command: process.execPath, args: [FIXTURE] } } });
  const added = { command: process.execPath, args: [FIXTURE], env: { MCP_VALUE: "${ADDED_VALUE}" } };
  const config = { mcpServers: { extra: added } };
  expect(await inspectMcp(dir, { config })).toMatchObject([{ name: "constructor" }, { name: "extra" }]);
  const agent = await opened(dir, { config, secrets: { ADDED_VALUE: "mine" } });
  const program = JSON.parse((await ask(agent, "mcp__constructor__who")).answer?.text ?? "null");
  const instance = JSON.parse((await ask(agent, "mcp__extra__who")).answer?.text ?? "null");
  expect(instance).toMatchObject({ value: "mine" });
  expect(program.pid).not.toBe(instance.pid);

  // Refused before anything of the instance is opened, naming both.
  const taken = { mcpServers: { constructor: added } };
  await expect(openSource(dir, { config: taken, stateDir: join(dir, "refused") })).rejects.toThrow(
    /MCP server "constructor" is declared by the program \(context\.json\) and by the instance/,
  );
  await expect(readFile(join(dir, "refused", "agent.sqlite"))).rejects.toThrow(/ENOENT/);
  // The reference an instance's server makes is a secret it needs, like the program's.
  await expect(openSource(dir, { config, secrets: {}, stateDir: join(dir, "third") })).rejects.toThrow(/ADDED_VALUE/);
});
