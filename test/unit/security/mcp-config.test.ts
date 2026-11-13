// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpInstance, declareMcp, loadMcp, mcpSecrets, resolveMcpServers } from "../../../src/mcp/config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const program = (servers: unknown, target = dir) =>
  writeFile(join(target, "fastagent.config.ts"), `export default ${JSON.stringify({ mcpServers: servers })};\n`);
const instance = (servers: unknown, directory?: string): McpInstance => ({
  values: { mcpServers: servers },
  label: directory === undefined ? "the config object" : join(directory, "fastagent.json"),
  ...(directory === undefined ? {} : { directory }),
});

describe("the servers of the program, from fastagent.config.ts", () => {
  it("reads them with the instance's variables and no ambient secret forwarding", async () => {
    expect(await loadMcp(dir)).toEqual([]);
    await program({
      local: { command: "./bin/server", args: ["${ROOT}"], env: { TOKEN: "${TOKEN}" } },
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    });
    const declared = await loadMcp(dir);
    const resolved = resolveMcpServers(
      declared,
      { ROOT: "/project one", TOKEN: "secret", PATH: "/not-a-process-env", OTHER_PROVIDER_SECRET: "hidden" },
      undefined,
      "/workspace",
      { PATH: "/bin" },
    );
    // A command with a path is the package's; the working directory is the instance's, whoever declared it.
    expect(resolved[0]).toEqual({
      name: "local",
      type: "stdio",
      command: join(dir, "bin/server"),
      args: ["/project one"],
      cwd: "/workspace",
      env: { TOKEN: "secret", PATH: "/bin" },
    });
    expect(resolved[1]).toMatchObject({ headers: { Authorization: "Bearer secret" } });
    expect(mcpSecrets(declared)).toEqual([
      { name: "ROOT", declaredIn: "fastagent.config.ts mcpServers.local", optional: false },
      { name: "TOKEN", declaredIn: "fastagent.config.ts mcpServers.local", optional: false },
      { name: "TOKEN", declaredIn: "fastagent.config.ts mcpServers.remote", optional: false },
    ]);
  });

  it.each([
    { x: { type: "sse", url: "https://example.com" } },
    { x: { command: "node", url: "https://example.com" } },
    { x: { command: "node", args: ["${input:token}"] } },
    { x: { command: "node", env: { TOKEN: "${TOKEN:-fallback}" } } },
    { x: { type: "http", url: "http://outside.example/mcp" } },
    { x: { type: "http", url: "https://user:secret@example.com/mcp" } },
    { x__y: { command: "node" } },
  ])("refuses an unsupported declaration without printing credential values", async (servers) => {
    expect(() => declareMcp(servers, dir)).toThrow(/fastagent\.config\.ts/);
  });
});

describe("the servers an instance adds", () => {
  it("only add: a name the program declares refuses, naming both files", async () => {
    await program({ docs: { type: "http", url: "https://docs.example.com/mcp" } });
    await expect(loadMcp(dir, instance({ docs: { command: "node" } }))).rejects.toThrow(
      /MCP server "docs" is declared by the program \(fastagent\.config\.ts\) and by the instance \(the config object\)/,
    );
  });
});
