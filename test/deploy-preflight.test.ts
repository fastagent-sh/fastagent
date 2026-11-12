import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_MODEL } from "./codex-model.ts";
import { agent, call } from "./deploy-preflight-fixtures.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

describe("deploy/preflight: the host-neutral pre-flight", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gates --run when NO source resolves a model (would ship a crash-loop)", async () => {
    const dir = await agent(); // .secrets/.env holds no FASTAGENT_MODEL, config holds no model
    vi.stubEnv("FASTAGENT_MODEL", undefined);
    const pre = await call(dir, {}, { run: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toMatch(/no model resolves/);
  });

  it("a kept ignore that misses the secrets gates NAMING the leaking FILE, not the directory", async () => {
    const agentDir = await agent();
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) {
      expect(gated.gate).toMatch(/BAKE SECRETS INTO THE IMAGE/);
      expect(gated.gate).toMatch(/`\.secrets\/auth\.json`/); // the FILE — actionable, not a directory
      expect(gated.gate).toMatch(/`\.secrets\/\.env`/);
    }
  });

  it("loads the definition the box will load: a refusal in it gates --run instead of shipping a crash-loop", async () => {
    const dir = await agent({ "src/tools/x.ts": "export default { name: 'x' };\n" });
    const config = { model: CODEX_MODEL };
    const gated = await call(dir, config, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok)
      expect(gated.gate).toMatch(/definition does not build.*src\/tools\/x\.ts: must default-export a tool/);
    const warned = await call(dir, config, { run: false });
    expect(warned.ok).toBe(true);
    if (warned.ok)
      expect(warned.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(/definition does not build/),
      });
  });
});
