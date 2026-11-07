// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type McpInstance,
  declareMcp,
  literalCredentials,
  mcpInstance,
  mcpSecrets,
  resolveMcpServers,
} from "../src/mcp/config.ts";

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

  it("refuses a declaration that is not a map, and malformed JSON, instead of treating them as absent", async () => {
    await writeFile(join(dir, "context.json"), JSON.stringify({ mcpServers: [] }));
    expect(() => declareMcp(dir)).toThrow('"mcpServers" must be an object of servers by name');
    await writeFile(join(dir, "context.json"), "{");
    expect(() => declareMcp(dir)).toThrow("context.json is not valid JSON");
  });

  it("does not read a .mcp.json: it is the coding tools' file", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tooling: { command: "npx" } } }));
    expect(declareMcp(dir)).toEqual([]);
  });

  it("names missing variables, but never the configured secret values", async () => {
    await program({ x: { command: "node", env: { TOKEN: "${MISSING}" } } });
    expect(() => resolveMcpServers(declareMcp(dir), {}, undefined, dir, {})).toThrow("x requires MISSING");
  });
});

describe("the servers an instance adds", () => {
  it("come after the program's, each with the file it came from and what its commands are relative to", async () => {
    await program({ docs: { type: "http", url: "https://docs.example.com/mcp" } });
    const config = join(dir, "config");
    await mkdir(config);
    const declared = declareMcp(
      dir,
      instance({ notes: { command: "./notes-server", args: ["${NOTES_DIR}"] } }, config),
    );
    expect(declared.map(({ name, origin, file }) => [name, origin, file])).toEqual([
      ["docs", "program", "context.json"],
      ["notes", "instance", join(config, "fastagent.json")],
    ]);
    const [, notes] = resolveMcpServers(declared, { NOTES_DIR: "/n" }, undefined, dir, {});
    expect(notes).toMatchObject({ command: join(config, "notes-server"), args: ["/n"] });
    expect(mcpSecrets(declared)).toContainEqual({
      name: "NOTES_DIR",
      declaredIn: `${join(config, "fastagent.json")} mcpServers.notes`,
      optional: false,
    });
  });

  it("only add: a name the program declares refuses, naming both files", async () => {
    await program({ docs: { type: "http", url: "https://docs.example.com/mcp" } });
    expect(() => declareMcp(dir, instance({ docs: { command: "node" } }))).toThrow(
      /MCP server "docs" is declared by the program \(context\.json\) and by the instance \(the config object\)/,
    );
  });

  it("refuse a command with a path where there is no file to be relative to, or one the variable made relative", async () => {
    const declared = declareMcp(dir, instance({ a: { command: "./bin/a" }, b: { command: "${BIN}/b" } }));
    expect(() => resolveMcpServers(declared, {}, "a", dir, {})).toThrow(/has a path and no file to be relative to/);
    expect(resolveMcpServers(declared, { BIN: "/opt/bin" }, "b", dir, {})[0]).toMatchObject({ command: "/opt/bin/b" });
    expect(() => resolveMcpServers(declared, { BIN: "bin" }, "b", dir, {})).toThrow(/no file to be relative to/);
  });

  it("are checked like the program's, the refusal naming the instance's file", () => {
    expect(() => declareMcp(dir, instance({ x: { type: "sse" } }))).toThrow(
      /^the config object: invalid MCP configuration/,
    );
    expect(() => declareMcp(dir, instance({ x__y: { command: "node" } }))).toThrow(
      /the config object: server names must be/,
    );
  });

  it("read from a path, an absolute one, whose directory is what its commands are relative to", async () => {
    const path = join(dir, "fastagent.json");
    await writeFile(path, JSON.stringify({ model: "a/b", mcpServers: { local: { command: "./srv" } } }));
    expect(mcpInstance(path)).toMatchObject({ label: path, directory: dir });
    expect(resolveMcpServers(declareMcp(dir, mcpInstance(path)), {}, undefined, dir, {})[0]).toMatchObject({
      command: join(dir, "srv"),
    });
    expect(() => mcpInstance("relative.json")).toThrow("config must be an absolute path");
    expect(() => mcpInstance(join(dir, "missing.json"))).toThrow("cannot read the instance configuration");
    await writeFile(path, "{");
    expect(() => mcpInstance(path)).toThrow(/is not JSON/);
  });
});

it("says each literal credential where the file travels, and not a reference or an empty value", async () => {
  await program({
    docs: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer abc", Empty: "" } },
    files: { command: "npx", env: { TOKEN: "${FILES_TOKEN}", PLAIN: "x" } },
  });
  expect(literalCredentials(declareMcp(dir))).toEqual([
    { file: "context.json", server: "docs", field: "headers", key: "Authorization" },
    { file: "context.json", server: "files", field: "env", key: "PLAIN" },
  ]);
});
