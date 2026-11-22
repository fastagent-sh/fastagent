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
});
