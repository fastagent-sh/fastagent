// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpInstance, declareMcp, mcpSecrets, resolveMcpServers } from "../src/mcp/config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const program = (servers: unknown) => writeFile(join(dir, "context.json"), JSON.stringify({ mcpServers: servers }));
const instance = (servers: unknown, directory?: string): McpInstance => ({
  values: { mcpServers: servers },
  label: directory === undefined ? "the config object" : join(directory, "fastagent.json"),
  ...(directory === undefined ? {} : { directory }),
});

describe("the servers of the program, from context.json", () => {
  it("reads them with the instance's variables and no ambient secret forwarding", async () => {
    expect(declareMcp(dir)).toEqual([]);
    await program({
      local: { command: "./bin/server", args: ["${ROOT}"], env: { TOKEN: "${TOKEN}" } },
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    });
    const declared = declareMcp(dir);
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
      { name: "ROOT", declaredIn: "context.json mcpServers.local", optional: false },
      { name: "TOKEN", declaredIn: "context.json mcpServers.local", optional: false },
      { name: "TOKEN", declaredIn: "context.json mcpServers.remote", optional: false },
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
    await program(servers);
    expect(() => declareMcp(dir)).toThrow(/context\.json/);
  });
});

describe("the servers an instance adds", () => {
  it("only add: a name the program declares refuses, naming both files", async () => {
    await program({ docs: { type: "http", url: "https://docs.example.com/mcp" } });
    expect(() => declareMcp(dir, instance({ docs: { command: "node" } }))).toThrow(
      /MCP server "docs" is declared by the program \(context\.json\) and by the instance \(the config object\)/,
    );
  });
});
