// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readMcpConfiguration, resolveMcpServers, mcpSecrets } from "../src/mcp/config.ts";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = (data: unknown) => writeFile(join(dir, ".mcp.json"), JSON.stringify(data));
it("reads only the explicit file, with instance variables and no ambient secret forwarding", async () => {
  expect(readMcpConfiguration(dir).mcpServers).toEqual({});
  await file({
    mcpServers: {
      local: { command: "./bin/server", args: ["${ROOT}"], env: { TOKEN: "${TOKEN}" } },
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    },
  });
  const resolved = resolveMcpServers(
    dir,
    { ROOT: "/project one", TOKEN: "secret", PATH: "/not-a-process-env", OTHER_PROVIDER_SECRET: "hidden" },
    undefined,
    dir,
    { PATH: "/bin" },
  );
  expect(resolved[0]).toEqual({
    name: "local",
    type: "stdio",
    command: join(dir, "bin/server"),
    args: ["/project one"],
    cwd: dir,
    env: { TOKEN: "secret", PATH: "/bin" },
  });
  expect(resolved[1]).toMatchObject({ headers: { Authorization: "Bearer secret" } });
  expect(mcpSecrets(dir).map((s) => s.name)).toEqual(["ROOT", "TOKEN", "TOKEN"]);
});
it.each([
  { servers: {} },
  { mcpServers: { x: { type: "sse", url: "https://example.com" } } },
  { mcpServers: { x: { command: "node", url: "https://example.com" } } },
  { mcpServers: { x: { command: "node", args: ["${input:token}"] } } },
  { mcpServers: { x: { command: "node", env: { TOKEN: "${TOKEN:-fallback}" } } } },
  { mcpServers: { x: { type: "http", url: "http://outside.example/mcp" } } },
  { mcpServers: { x: { type: "http", url: "https://user:secret@example.com/mcp" } } },
  { mcpServers: { x__y: { command: "node" } } },
])("refuses an unsupported declaration without printing credential values", async (config) => {
  await file(config);
  expect(() => readMcpConfiguration(dir)).toThrow();
});
it("names missing variables, but never the configured secret values", async () => {
  await file({ mcpServers: { x: { command: "node", env: { TOKEN: "${MISSING}" } } } });
  expect(() => resolveMcpServers(dir, {}, undefined, dir, {})).toThrow("x requires MISSING");
});
it("refuses malformed JSON instead of treating it as absent", async () => {
  await writeFile(join(dir, ".mcp.json"), "{");
  expect(() => readMcpConfiguration(dir)).toThrow(".mcp.json");
});
