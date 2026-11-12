import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { openMcpClients } from "../src/mcp/client.ts";
import { roots, clients, fixture } from "./mcp-client-fixtures.ts";
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("distinguishes a missing executable from a server that exits without exposing args or stderr", async () => {
  const { auth } = await fixture();
  const secret = "DO_NOT_PRINT_CHILD_SECRET";
  const warnings = vi.spyOn(log, "warn").mockImplementation(() => {});
  const open = (command: string, args: string[]) =>
    openMcpClients([{ name: "local", type: "stdio", command, args, env: {}, cwd: process.cwd() }], {
      ...auth,
      bindings: {},
    });
  const failures = await Promise.allSettled([
    open("/nonexistent/mcp-server", [secret]),
    open(process.execPath, ["-e", `console.error("${secret}");process.exit(1)`]),
  ]);
  expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  const messages = failures.map((result) => (result.status === "rejected" ? String(result.reason) : ""));
  expect(messages[0]).toContain("ENOENT");
  expect(messages[1]).toContain("CONNECTION_CLOSED");
  expect(messages[1]).not.toContain("ENOENT");
  expect(messages.join(" ") + JSON.stringify(warnings.mock.calls)).not.toContain(secret);
});
