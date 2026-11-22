/**
 * An instance a host opens of its own, beside `fastagent dev`'s: its root, its model credentials from the secrets it
 * is given, and its model lists.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgent } from "../../../packages/fastagent/src/index.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { openSource } from "../../harnesses/open-source.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a host's own instance of an agent", () => {
  it("opens beside the directory's own instance, authenticated by its secrets, offering each model's context window", async () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
      vi.stubEnv(name, undefined);
    const base = await mkdtemp(join(tmpdir(), "fa-host-instance-"));
    const dir = join(base, "agent");
    await mkdir(dir);
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
    const root = join(homedir(), "host-instances", "agent");
    const stateDir = join(root, ".state");

    const definition = await loadSourceDefinition(dir);
    await expect(openAgent(definition, { root: "host-instances" })).rejects.toThrow(
      'root must be an absolute path, and is "host-instances"',
    );
    const hosted = await openAgent(definition, { root, secrets: { ANTHROPIC_API_KEY: "sk-host" } });
    // The directory's own instance (what `fastagent dev` opens) is not held by the host's.
    const own = await openSource(dir);
    try {
      expect(existsSync(join(stateDir, "agent.sqlite"))).toBe(true);
      const offered = (await hosted.info()).models;
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
      expect(offered.every((model) => (model.contextWindow ?? 0) > 0)).toBe(true);
      expect((await own.info()).models).toEqual([]);
    } finally {
      await own.close();
      await hosted.close();
    }
    expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(true);
  });

  it("isolates busy() per opened instance when two instances run in the same process", async () => {
    const base = await mkdtemp(join(tmpdir(), "fa-busy-isolation-"));
    const dir = join(base, "agent");
    await mkdir(join(dir, "src", "tools"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "busy-iso", type: "module" }));
    await writeFile(
      join(dir, "fastagent.config.ts"),
      `import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineAgent } from "@fastagent-sh/fastagent";
const core = createFauxCore({ provider: "iso", api: "iso" });
const stream = (...args) => {
  const last = args[1].messages.at(-1);
  core.appendResponses([
    last?.role === "toolResult"
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" }),
  ]);
  return core.streamSimple(...args);
};
export default defineAgent({
  model: "iso/" + core.getModel().id,
  codingTools: false,
  providers: [
    createProvider({
      id: "iso",
      auth: { apiKey: { name: "ISO", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream, streamSimple: stream },
    }),
  ],
});
`,
    );
    await writeFile(
      join(dir, "src", "tools", "pause.ts"),
      `import { defineTool } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "pause",
  description: "Pauses briefly",
  parameters: { type: "object", properties: {} } as const,
  execute: async () => {
    await new Promise((r) => setTimeout(r, 150));
    return "ok";
  },
});
`,
    );
    const definition = await loadSourceDefinition(dir);
    const rootA = join(base, "root-a");
    const rootB = join(base, "root-b");
    await mkdir(rootA);
    await mkdir(rootB);
    const agentA = await openAgent(definition, { root: rootA });
    const agentB = await openAgent(definition, { root: rootB });
    try {
      const sA = await agentA.sessions.create();
      const pending = agentA.messages.send({ sessionId: sA.id, content: "go" }, { wait: 10 });
      await vi.waitFor(() => {
        expect(agentA.busy()).toBe(true);
      });
      expect(agentB.busy()).toBe(false);
      expect((await pending).status).toBe("completed");
      await vi.waitFor(() => {
        expect(agentA.busy()).toBe(false);
      });
    } finally {
      await agentA.close();
      await agentB.close();
    }
  });
});
