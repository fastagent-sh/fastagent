/**
 * The instance text a deploy delivers (agent-artifact.md §6.1): copied beside the configuration into
 * `fastagent.deploy/` so the paths it wrote resolve in the image, replaced whole by each deploy, and refused when it
 * could not be delivered or would not open there.
 */
import { access, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { deliveredTextProblem } from "../src/deploy/delivered-text.ts";
import { readInstanceConfigFile } from "../src/harnesses/pi-durable/config.ts";
import { openText, readCommands } from "../src/harnesses/pi-durable/text.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nHow to ${name}.\n`;

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
}

/** A project to deploy, and a directory holding the configuration and its text. */
async function layout(config: object, files: Record<string, string>) {
  const dir = await agentWorkspace("fa-text-deploy-", {
    "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    "skills/triage/SKILL.md": skill("triage"),
    ".secrets/production/.env": "OPENAI_API_KEY=sk\n",
  });
  const configDir = realpathSync(await mkdtemp(join(tmpdir(), "fa-text-config-")));
  await write(configDir, { "fastagent.json": JSON.stringify(config), ...files });
  return { dir, configDir, config: join(configDir, "fastagent.json") };
}

const FILES = {
  "notes/rules.md": "Answer in English.\n",
  "extra-skills/audit/SKILL.md": skill("audit"),
  "extra-prompts/review.md": "Review $1.\n",
};
const DECLARED = { instructions: ["./notes/rules.md"], skills: ["./extra-skills"], prompts: ["./extra-prompts"] };

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("deploy: the instance text it delivers", () => {
  it("copies what the configuration names beside it, so the image's /etc/fastagent opens the same text", async () => {
    const { dir, config } = await layout(DECLARED, FILES);
    const run = await runInProcess(["deploy", "docker", dir, "--config", config]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("delivered 3 path(s) of the instance's text into fastagent.deploy/");
    for (const file of Object.keys(FILES)) expect(await exists(join(dir, "fastagent.deploy", file)), file).toBe(true);

    // What the box does: the delivered directory is /etc/fastagent, and its configuration is read from there.
    const onTheBox = await readInstanceConfigFile(join(dir, "fastagent.deploy", "fastagent.json"));
    const text = openText(dir, onTheBox);
    expect(text.instructions.map((entry) => entry.path)).toEqual([join(dir, "fastagent.deploy/notes/rules.md")]);
    expect(
      readCommands(text)
        .map((command) => command.name)
        .sort(),
    ).toEqual(["review", "skill:audit", "skill:triage"]);
  });

  it("replaces what an earlier deploy delivered: a path dropped from the configuration, or the configuration itself", async () => {
    const { dir, configDir, config } = await layout(DECLARED, FILES);
    expect((await runInProcess(["deploy", "docker", dir, "--config", config])).code).toBe(0);
    await writeFile(config, JSON.stringify({ skills: ["./extra-skills"] }));
    const fewer = await runInProcess(["deploy", "docker", dir, "--config", config]);
    expect(fewer.code, fewer.stderr).toBe(0);
    expect(await exists(join(dir, "fastagent.deploy/extra-skills/audit/SKILL.md"))).toBe(true);
    expect(await exists(join(dir, "fastagent.deploy/notes"))).toBe(false);
    expect(await exists(join(dir, "fastagent.deploy/extra-prompts"))).toBe(false);

    const none = await runInProcess(["deploy", "docker", dir]);
    expect(none.code, none.stderr).toBe(0);
    expect(await exists(join(dir, "fastagent.deploy/extra-skills"))).toBe(false);
    expect(await readFile(join(dir, "fastagent.deploy/fastagent.json"), "utf8")).toBe("{}\n");
    expect(await exists(join(configDir, "extra-skills/audit/SKILL.md"))).toBe(true);
  });

  it("stops --run, before anything is built, on text it cannot deliver or that would not open there", async () => {
    const { dir, config } = await layout({}, { ...FILES, "triage/triage/SKILL.md": skill("triage") });
    const elsewhere = join(dirname(dir), "elsewhere-skills");
    await write(elsewhere, { "x/SKILL.md": skill("x") });
    const stops = async (values: object, message: string | RegExp) => {
      await writeFile(config, JSON.stringify(values));
      const run = await runInProcess(["deploy", "docker", dir, "--config", config, "--run"]);
      expect(run.code, run.stderr).toBe(1);
      expect(run.stderr).toMatch(message);
    };
    await stops({ skills: [elsewhere] }, /skills ".*elsewhere-skills" is not relative to the configuration/);
    await write(homedir(), { "skills/x/SKILL.md": skill("x") });
    await stops({ skills: ["~/skills"] }, /is not relative to the configuration/);
    await stops({ skills: [relative(dirname(config), elsewhere)] }, /is outside the configuration's directory/);
    await stops({ skills: ["."] }, /is outside the configuration's directory/);
    await stops({ skills: ["./missing"] }, /is not a directory/);
    await stops({ instructions: ["./extra-skills"] }, /is not a file/);
    await stops({ skills: ["./triage"] }, /skill "triage" is declared by/);
  });

  it("carries out nothing it would refuse: a generate-only deploy stops too, and writes nothing outside fastagent.deploy/", async () => {
    const { dir, configDir, config } = await layout({}, {});
    const elsewhere = join(dirname(configDir), `elsewhere-${basename(configDir)}`);
    await write(elsewhere, { "x/SKILL.md": skill("x") });
    // Relative to the configuration, it would land beside fastagent.deploy/ in the agent directory, over what is there.
    await writeFile(config, JSON.stringify({ skills: [relative(configDir, elsewhere)] }));
    const run = await runInProcess(["deploy", "docker", dir, "--config", config]);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/is outside the configuration's directory/);
    expect(await exists(join(dir, basename(elsewhere)))).toBe(false);
    expect(await exists(join(dir, "fastagent.deploy"))).toBe(false);
  });

  it("refuses a configuration kept inside fastagent.deploy/, which every deploy replaces, before deleting it", async () => {
    const { dir } = await layout({}, {});
    const kept = join(dir, "fastagent.deploy");
    await write(kept, {
      "fastagent.json": JSON.stringify({ skills: ["./extra"] }),
      "extra/audit/SKILL.md": skill("audit"),
    });
    const run = await runInProcess(["deploy", "docker", dir, "--config", join(kept, "fastagent.json")]);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/is inside .*fastagent\.deploy, which every deploy replaces/);
    expect(await exists(join(kept, "extra/audit/SKILL.md"))).toBe(true);
  });

  it("delivers what a symlink points at, not the link, which would dangle in the image", async () => {
    const { dir, configDir, config } = await layout({ skills: ["./sk"] }, {});
    const outside = realpathSync(await mkdtemp(join(tmpdir(), "fa-text-link-")));
    await write(outside, { "audit/SKILL.md": skill("audit") });
    await mkdir(join(configDir, "sk"));
    await symlink(join(outside, "audit"), join(configDir, "sk/audit"));
    const run = await runInProcess(["deploy", "docker", dir, "--config", config]);
    expect(run.code, run.stderr).toBe(0);
    const delivered = join(dir, "fastagent.deploy/sk/audit");
    expect((await lstat(delivered)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(delivered, "SKILL.md"), "utf8")).toContain("name: audit");
    // A link to nothing stops the deploy instead of shipping a skill the box would silently skip.
    await symlink(join(outside, "gone"), join(configDir, "sk/ghost"));
    const dangling = await runInProcess(["deploy", "docker", dir, "--config", config, "--run"]);
    expect(dangling.code, dangling.stderr).toBe(1);
    // Found by the pre-flight, before a person's steps and before anything is built.
    expect(dangling.stderr).toMatch(/deploy stopped: .*holds a symbolic link to nothing: .*sk\/ghost/);
  });

  it("refuses a path that contains the agent directory, which it could not copy into itself", async () => {
    const configDir = realpathSync(await mkdtemp(join(tmpdir(), "fa-contains-")));
    const agentDir = join(configDir, "agent");
    await mkdir(agentDir);
    const source = { values: { skills: ["./agent"] }, label: join(configDir, "fastagent.json"), directory: configDir };
    expect(deliveredTextProblem(agentDir, source)).toMatch(/contains the agent directory/);
  });
});
