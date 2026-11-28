// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  declareMcp,
  literalCredentials,
  loadMcp,
  mcpSecrets,
  resolveMcpServers,
} from "../../../packages/fastagent/src/mcp/config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const program = (servers: unknown, target = dir) =>
  writeFile(join(target, "fastagent.config.ts"), `export default ${JSON.stringify({ mcpServers: servers })};\n`);

describe("the servers of the project, from .mcp.json / mcp.json and fastagent.config.ts", () => {
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

  const IdentChars = Schema.Array(Schema.Literals(["a", "b", "z", "0", "9", "-"])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
  );
  const EnvChars = Schema.Array(Schema.Literals(["A", "K", "Z", "1", "_"])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
  );
  const SecretValue = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

  it.prop(
    "tracks ${VAR} references in mcpSecrets without flagging them as literals and expands only declared env vars",
    [IdentChars, EnvChars, SecretValue],
    ([serverChars, envChars, rawVal]) => {
      const serverName = `s-${serverChars.join("")}`;
      const envName = `V_${envChars.join("")}`;
      const secretVal = rawVal.replace(/[\r\n\0]/g, "x") || "x";
      const declared = declareMcp(
        { [serverName]: { command: "node", env: { TOKEN: `prefix-\${${envName}}` } } },
        "/tmp/agent",
      );
      expect(mcpSecrets(declared).map((s) => s.name)).toEqual([envName]);
      expect(literalCredentials(declared)).toEqual([]);
      const [resolved] = resolveMcpServers(
        declared,
        { [envName]: secretVal, UNRELATED_SECRET: "must-not-leak" },
        undefined,
        "/tmp/work",
        { PATH: "/usr/bin" },
      );
      expect(resolved?.type).toBe("stdio");
      if (resolved?.type === "stdio") {
        expect(resolved.env.TOKEN).toBe(`prefix-${secretVal}`);
        expect(resolved.env.UNRELATED_SECRET).toBeUndefined();
      }
    },
    { arbitrary: { runs: 30 } },
  );

  it.prop(
    "flags non-empty literal header/env credentials and refuses non-loopback HTTP or credentialed MCP URLs",
    [IdentChars, SecretValue],
    ([serverChars, rawLiteral]) => {
      const serverName = `h-${serverChars.join("")}`;
      const literal = rawLiteral.replace(/\$\{/g, "x").replace(/[\r\n\0]/g, "x") || "lit";
      const declared = declareMcp(
        { [serverName]: { type: "http", url: "https://mcp.example.com/v1", headers: { "x-api-key": literal } } },
        "/tmp/agent",
      );
      expect(literalCredentials(declared)).toEqual([
        { file: "fastagent.config.ts", server: serverName, field: "headers", key: "x-api-key" },
      ]);
      expect(() =>
        declareMcp({ [serverName]: { type: "http", url: `http://${serverName}.example.com/mcp` } }, "/tmp/agent"),
      ).toThrow(/MCP endpoints require HTTPS/);
      expect(() =>
        declareMcp(
          { [serverName]: { type: "http", url: `https://user:pass@${serverName}.example.com/mcp` } },
          "/tmp/agent",
        ),
      ).toThrow(/MCP endpoints require HTTPS/);
    },
    { arbitrary: { runs: 30 } },
  );

  it("discovers .mcp.json / mcp.json (with $schema), merges with fastagent.config.ts, and refuses duplicate server names or dual files", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        $schema: "https://json.schemastore.org/mcp.json",
        mcpServers: {
          duang: {
            type: "http",
            url: "https://duang.example.com/mcp",
            headers: { Authorization: "Bearer ${DUANG_TOKEN}" },
          },
        },
      }),
    );
    await program({
      local: { command: "npx", args: ["-y", "mcp-local"] },
    });

    const merged = await loadMcp(dir);
    expect(merged.map((m) => ({ name: m.name, file: m.file }))).toEqual([
      { name: "duang", file: ".mcp.json" },
      { name: "local", file: "fastagent.config.ts" },
    ]);
    expect(mcpSecrets(merged)).toEqual([
      { name: "DUANG_TOKEN", declaredIn: ".mcp.json mcpServers.duang", optional: false },
    ]);

    // Duplicate server name across .mcp.json and fastagent.config.ts is refused visibly.
    expect(() => declareMcp({ duang: { command: "npx" } }, dir)).toThrow(
      '.mcp.json and fastagent.config.ts both define MCP server "duang"',
    );

    // Having both .mcp.json and mcp.json in the same directory is refused visibly.
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    await expect(loadMcp(dir)).rejects.toThrow(/both \.mcp\.json and mcp\.json exist/);
  });
});
