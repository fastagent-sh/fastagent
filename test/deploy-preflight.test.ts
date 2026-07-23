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
    authPathFlag: undefined,
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

  it("agentDir layout: container facts come from the KIT, git is auto-baked, --run stays gated", async () => {
    const dir = await workspace({ "fastagent.config.mjs": `export default { model: "openai/gpt-4o-mini" };\n` });
    const agentDir = join(dir, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "package.json"),
      `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
    );

    // The whole repo-as-workspace shape is experimental for every automated runner, including Docker.
    const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { agentDir, run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/--run is not yet supported for the agentDir layout/);

    // Generate mode remains supported: kit facts drive the image, git rides in apt, and the runbook is explicit.
    const ok = await call(dir, { model: "openai/gpt-4o-mini", deploy: { apt: ["ripgrep"] } }, { agentDir });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.container.kitDir).toBe("agent");
      expect(ok.container.hasPackageJson).toBe(true); // the KIT's manifest, not the (absent) root one
      expect(ok.container.apt).toEqual(["git", "ripgrep"]); // git guaranteed, deploy.apt kept, deduped
      expect(JSON.stringify(ok.messages)).toMatch(/repo-as-workspace/); // the layout note is stated
    }
  });

  it("kit layout + a kept host .dockerignore: specific warns for a .git exclude and a missing **/node_modules", async () => {
    const dir = await workspace({ "fastagent.config.mjs": `export default { model: "openai/gpt-4o-mini" };\n` });
    const agentDir = join(dir, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "package.json"), `{"type":"module"}`);
    await writeFile(join(dir, ".dockerignore"), ".git\nnode_modules\n"); // the host's own — kept, not ours

    const pre = await call(dir, { model: "openai/gpt-4o-mini" }, { agentDir });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const text = JSON.stringify(pre.messages);
      expect(text).toMatch(/excludes \.git/); // write-back's baked copy is dead — named, not silent
      expect(text).toMatch(/lacks .{0,4}\*\*\/node_modules/); // the native-binary clobber hazard — named
    }
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

  it("recognizes Slack as a first-party route channel for secrets/deploy guidance", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "slack.mjs"), "export default () => ({ '/slack': () => new Response() });\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual(["slack"]);
      expect(pre.routeChannels).toEqual(["slack"]);
      expect(pre.messages.some((message) => message.text.includes('channel "slack" is custom'))).toBe(false);
    }
  });

  it("notes a custom channel (its secrets/webhook are the author's to wire)", async () => {
    const dir = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "discord.ts"), "export default () => ({});\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.routeChannels).toEqual(["discord"]);
      expect(pre.longConnectionChannels).toEqual([]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringContaining('route channel "discord" is custom'),
      });
    }
  });

  it("recognizes a long-connection module structurally and reports its always-on requirement", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(
      join(dir, "channels", "feishu.mjs"),
      `export default { name: "feishu websocket", connect() {} };\n`,
    );
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual(["feishu"]);
      expect(pre.routeChannels).toEqual([]);
      expect(pre.longConnectionChannels).toEqual(["feishu"]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel.*keeps one machine running/),
      });
    }
  });

  it("keeps a custom long-connection channel always-on without pretending it has a webhook", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "socket.mjs"), `export default { name: "custom socket", connect() {} };\n`);
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([]);
      expect(pre.routeChannels).toEqual([]);
      expect(pre.longConnectionChannels).toEqual(["socket"]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel "socket".*keep the process running.*skip webhook/),
      });
    }
  });

  it("fails visibly when an enabled channel throws during deployment inspection", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "broken.mjs"), `throw new Error("import exploded");\n`);
    await expect(call(dir, { model: "openai/gpt-4o-mini" })).rejects.toThrow(/cannot inspect.*import exploded/);
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

  it("detects time triggers: schedules/ files OR config.selfSchedule → hasTimeTriggers + a keep-1 note", async () => {
    // Neither → false, no note.
    const none = await call(await workspace(), { model: "openai/gpt-4o-mini" });
    expect(none.ok && !none.hasTimeTriggers).toBe(true);

    // A schedules/ file → true + note (cron has no external wake-up).
    const dir = await workspace();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(dir, "schedules"), { recursive: true });
    await wf(join(dir, "schedules", "daily.ts"), "export default {};\n"); // discovery counts files, not validity
    const withCron = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(withCron.ok && withCron.hasTimeTriggers).toBe(true);
    if (withCron.ok) {
      expect(withCron.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/keeps one machine running/),
      });
    }

    // selfSchedule alone (the wake tool) → true: a wake-up needs the box awake just like a cron.
    const wake = await call(await workspace(), { model: "openai/gpt-4o-mini", selfSchedule: true });
    expect(wake.ok && wake.hasTimeTriggers).toBe(true);
  });

  it("warns a code workspace with no lockfile and no @fastagent-sh/fastagent dep", async () => {
    const dir = await workspace({ "package.json": JSON.stringify({ name: "a", type: "module" }) });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages.some((m) => /no package-lock\.json/.test(m.text) || /not reproducible/.test(m.text))).toBe(
      true,
    );
    expect(pre.messages.some((m) => /does not list @fastagent-sh\/fastagent/.test(m.text))).toBe(true);
  });
});
