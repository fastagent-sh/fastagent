import { describe, expect, it } from "vitest";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgentForEmbed, inMemorySessionStore } from "../src/index.ts";

/** A minimal workspace folder: AGENTS.md + an optional config. */
async function makeWorkspace(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-embed-ws-"));
  await writeFile(join(dir, "AGENTS.md"), "# Embed Bot\nYou are a test agent.\n");
  if (config !== undefined) await writeFile(join(dir, "fastagent.config.mjs"), config);
  return dir;
}

describe("createPiAgentForEmbed", () => {
  it("reads the workspace config (model) and returns an embeddable agent", async () => {
    const dir = await makeWorkspace(`export default { model: "openai-codex/gpt-5.5" };`);
    const result = await createPiAgentForEmbed(dir);

    expect(result.modelSpec).toBe("openai-codex/gpt-5.5");
    expect(result.configPath).toMatch(/fastagent\.config\.mjs$/);
    expect(result.definition.instructions).toBeDefined(); // AGENTS.md loaded
    expect(typeof result.agent.invoke).toBe("function");
  });

  it("lets the embedder override the model spec without a config", async () => {
    const dir = await makeWorkspace(); // no config file
    const result = await createPiAgentForEmbed(dir, { model: "openai-codex/gpt-5.5" });
    expect(result.modelSpec).toBe("openai-codex/gpt-5.5");
    expect(result.configPath).toBeUndefined();
  });

  it("accepts injected K ports (no model object required)", async () => {
    const dir = await makeWorkspace(`export default { model: "openai-codex/gpt-5.5" };`);
    // The point of the opener: config convenience AND K injection in one call.
    const result = await createPiAgentForEmbed(dir, {
      model: "openai-codex/gpt-5.5",
      sessions: inMemorySessionStore(),
    });
    expect(typeof result.agent.invoke).toBe("function");
  });

  it("creates no .fastagent state directory (unlike the dev opener)", async () => {
    const dir = await makeWorkspace(`export default { model: "openai-codex/gpt-5.5" };`);
    await createPiAgentForEmbed(dir);
    await expect(access(join(dir, ".fastagent"))).rejects.toThrow(); // ENOENT: nothing materialized
  });

  it("fails visibly when no model source is set", async () => {
    const dir = await makeWorkspace(`export default {};`); // config present but no model
    const saved = process.env.FASTAGENT_MODEL;
    delete process.env.FASTAGENT_MODEL;
    try {
      await expect(createPiAgentForEmbed(dir)).rejects.toThrow(/missing model/);
    } finally {
      if (saved !== undefined) process.env.FASTAGENT_MODEL = saved;
    }
  });
});
