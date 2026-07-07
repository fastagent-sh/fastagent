import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightDeploy } from "../src/deploy/preflight.ts";
import type { FastagentConfig } from "../src/engines/pi/config.ts";

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-preflight-"));
  await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const call = (target: string, config: FastagentConfig, over: Partial<Parameters<typeof preflightDeploy>[0]> = {}) =>
  preflightDeploy({
    target,
    agentDir: target, // flat by default; a test overrides via `over` to exercise config.agentDir
    config,
    modelSpec: config.model,
    run: false,
    force: false,
    authPathOverride: undefined,
    ...over,
  });

describe("deploy/preflight: the host-neutral pre-flight", () => {
  it("gates --run when the model isn't in config (would ship a crash-loop)", async () => {
    const dir = await workspace();
    // model resolved via --model/FASTAGENT_MODEL, absent from config → won't travel.
    const pre = await call(dir, {}, { modelSpec: "openai/gpt-4o-mini", run: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toMatch(/fastagent\.config/);
  });

  it("agentDir with its own package.json: gates --run (kit deps never installed on the box), warns without", async () => {
    const dir = await workspace({ "fastagent.config.mjs": `export default { model: "openai/gpt-4o-mini" };\n` });
    const agentDir = join(dir, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), `{"type":"module"}`);

    const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { agentDir, run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/agentDir.*package\.json/);

    const warned = await call(dir, { model: "openai/gpt-4o-mini" }, { agentDir });
    expect(warned.ok).toBe(true);
    if (warned.ok) expect(JSON.stringify(warned.messages)).toMatch(/agentDir/);
  });

  it("warns (not gates) about the same model issue without --run", async () => {
    const dir = await workspace();
    const pre = await call(dir, {}, { modelSpec: "openai/gpt-4o-mini", run: false });
    expect(pre.ok).toBe(true);
    if (pre.ok)
      expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/fastagent\.config/) });
  });

  it("computes container facts and no model message when the model is in config (markdown agent)", async () => {
    const dir = await workspace();
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.container.hasPackageJson).toBe(false); // markdown/skills agent → global-install path
    expect(pre.container.runtime).toBe("node");
    expect(pre.port).toBe(8787);
    expect(pre.messages.some((m) => /fastagent\.config/.test(m.text))).toBe(false);
  });

  it("notes a custom channel (its secrets/webhook are the author's to wire)", async () => {
    const dir = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "slack.ts"), "export default () => ({});\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok)
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringContaining('channel "slack" is custom'),
      });
  });

  it("warns a KEPT hand-written Dockerfile that deploy.apt won't reach; --force suppresses it", async () => {
    const dir = await workspace({ Dockerfile: "FROM python:3.12\n" }); // no generated marker → hand-written
    const config: FastagentConfig = { model: "openai/gpt-4o-mini", deploy: { apt: ["git"] } };

    const kept = await call(dir, config, { force: false });
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/deploy\.apt.*NOT applied/) });
    }

    // --force regenerates the Dockerfile, so the kept-hand-written warning does not apply.
    const forced = await call(dir, config, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.messages.some((m) => /NOT applied/.test(m.text))).toBe(false);
  });

  it("warns a code workspace with no lockfile and no @kid7st/fastagent dep", async () => {
    const dir = await workspace({ "package.json": JSON.stringify({ name: "a", type: "module" }) });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages.some((m) => /no package-lock\.json/.test(m.text) || /not reproducible/.test(m.text))).toBe(
      true,
    );
    expect(pre.messages.some((m) => /does not list @kid7st\/fastagent/.test(m.text))).toBe(true);
  });
});
