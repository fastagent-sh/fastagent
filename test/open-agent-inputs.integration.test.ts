import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import { fauxAgent } from "./cli-run.ts";
import { scratch, agents, directory, open, BOTH_WAYS } from "./open-agent-inputs-fixtures.ts";

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  await rm(GLOBAL_AUTH_PATH, { force: true });
  vi.unstubAllEnvs();
});

/**
 * What an open, a serve and a message may read of the process's environment: the log level, and what is not FastAgent's
 * own read (SPEC §8). A model provider's SDK reads its own variables, which a faux provider does not exercise.
 */
const READ_ALLOWED = new Set([
  "FASTAGENT_LOG_LEVEL",
  // The MCP SDK reads these six to build a stdio server's default environment; FastAgent withholds every one of them.
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  // The runtime's own, under coverage.
  "NODE_V8_COVERAGE",
]);
const MCP_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

describe("what an open, a serve and a message read of the process", () => {
  it("is the log level, over content, an MCP server, a channel that receives either way, and a turn", async () => {
    const content = await directory("fa-open-content-");
    const dir = await fauxAgent("fa-open-inputs-", {
      "context.json": JSON.stringify({
        mcpServers: { constructor: { command: process.execPath, args: [MCP_FIXTURE] } },
      }),
      "src/channels/both.mjs": BOTH_WAYS,
    });
    const stateDir = join(await directory("fa-open-state-"), "state");
    const real = process.env;
    const reads = new Set<string>();
    const watch = (key: string | symbol) => {
      if (typeof key === "string") reads.add(key);
    };
    process.env = new Proxy(real, {
      get(target, key) {
        watch(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        watch(key);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        watch("<every variable>");
        return Reflect.ownKeys(target);
      },
    });
    try {
      const agent = await open({
        dir,
        stateDir,
        env: { PATH: real.PATH ?? "" },
        config: { content: { docs: { path: content } } },
      });
      const service = await agent.serve();
      expect((await service.fetch(new Request("http://x/health"))).status).toBe(200);
      const session = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 30 });
      expect(message.status).toBe("completed");
      await service.close();
    } finally {
      process.env = real;
    }
    expect([...reads].filter((key) => !READ_ALLOWED.has(key)).sort()).toEqual([]);
  });
});
