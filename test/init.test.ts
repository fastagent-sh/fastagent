import { describe, expect, it, vi } from "vitest";
import ignore from "ignore";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { readSkills } from "../src/harnesses/pi-durable/text.ts";
import { programText } from "../src/harnesses/pi-durable/text-sources.ts";
import { scaffoldAgent } from "../src/scaffold/init.ts";

import { vendorSkill } from "../src/scaffold/vendor-skill.ts";
import { freshDir, exists, cliInit } from "./init-fixtures.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

describe("init: scaffoldAgent", () => {
  it("scaffolds a COMPLETE agent INTO the directory it names", async () => {
    const dir = join(await freshDir(), "reviewer");
    const { created } = await scaffoldAgent(dir);
    expect(created.sort()).toEqual(
      [
        "SYSTEM.md",
        join("skills", "writing-great-skills", "SKILL.md"),
        join("skills", "writing-great-skills", "GLOSSARY.md"),
        join("skills", "writing-great-skills", "LICENSE"),
        "fastagent.config.ts",
        "package.json",
        ".gitignore",
        join(".secrets", ".env.example"),
        join(".secrets", ".gitignore"),
      ].sort(),
    );

    // The agent-root .gitignore covers the .env habit puts there (fastagent reads .secrets/.env, but
    // an unignored root .env is the plausible mistake this layout invites). `.env.example` lives under
    // `.secrets/`, whose own ignore file un-ignores it — so no negation is needed (or wanted) here.
    const rootIgnore = await readFile(join(dir, ".gitignore"), "utf8");
    const ig = ignore({ ignorecase: false }).add(rootIgnore);
    expect(ig.ignores(".env")).toBe(true);
    expect(ig.ignores(".env.local")).toBe(true);
    // The development instance's configuration is personal (its app is one person's); a team shares `defaults`.
    expect(ig.ignores("fastagent.json")).toBe(true);
    expect(ig.ignores("prod.json")).toBe(false);
    const secretsIgnore = ignore({ ignorecase: false }).add(
      await readFile(join(dir, ".secrets", ".gitignore"), "utf8"),
    );
    expect(secretsIgnore.ignores(".env")).toBe(true);
    expect(secretsIgnore.ignores(".env.example")).toBe(false); // the template travels

    // Both ignore files travel with the directory; `.secrets/` protects itself independently of the
    // root one, which is the file the author is expected to edit.
    // No trailing slash: `node_modules/` would miss a SYMLINKED one (this repo's own .gitignore
    // carries the same fix, for the same reason).
    expect(rootIgnore).toMatch(/^node_modules$/m);
    expect(ig.ignores(".fastagent/dist/index.js")).toBe(true); // generated, never committed
    expect(await readFile(join(dir, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);

    // .env.example documents env knobs without misleading: all-commented (sets nothing), and it
    // frames auth as a choice (`fastagent login` OR a provider API key), never implying a key is required.
    const envExample = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    expect(envExample).toMatch(/fastagent login/);
    expect(envExample).toMatch(/set a provider API key/);
    expect(envExample).not.toMatch(/FASTAGENT_AGENT/);
    for (const line of envExample.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true); // every non-blank line is a comment
    }

    // package.json is ESM with what the agent imports, named after the agent's directory.
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("reviewer");
    expect(pkg.scripts).toEqual({
      dev: "fastagent dev",
      build: "fastagent build",
      start: "fastagent build && fastagent start",
    });
    // The fastagent dep tracks this build's version (not a stale hard-coded range), so a fresh
    // agent installs a version that has the API/exports it was scaffolded against. Oracle is the
    // package's real version read DIRECTLY (not fastagentVersion's output) so a corrupt read is caught.
    const real = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Its code is pi-durable code, its providers pi-ai's, its tool schemas pi-schema's: at the versions this build runs.
    expect(pkg.dependencies).toEqual({
      "@fastagent-sh/fastagent": `^${real.version}`,
      "@earendil-works/pi-durable": real.dependencies["@earendil-works/pi-durable"],
      "@earendil-works/pi-ai": real.dependencies["@earendil-works/pi-ai"],
      "@earendil-works/pi-schema": real.dependencies["@earendil-works/pi-schema"],
    });
    // `fastagent build` compiles with the agent's own TypeScript, the one FastAgent develops with.
    expect(pkg.devDependencies).toEqual({ typescript: real.devDependencies.typescript });
    const standing = await readFile(join(dir, "SYSTEM.md"), "utf8");
    expect(standing).toContain("Use only the tools actually listed in your system prompt");
    expect(standing).not.toMatch(/workspace/i);

    // The scaffolded agent builds, from the directory itself.
    const definition = await loadSourceDefinition(dir);
    expect(definition.name).toBe("reviewer");
    expect(buildDefinition(definition, {})).toMatchObject({ tools: [], channels: new Map(), schedules: [] });
    expect(readSkills(programText(dir).skills).map((s) => s.name)).toEqual(["writing-great-skills"]);
  });

  it("refuses a directory that is not empty, naming what is there; an empty or new one is fine", async () => {
    const project = await freshDir();
    await writeFile(join(project, "tsconfig.json"), "{}");
    await expect(scaffoldAgent(project)).rejects.toThrow(/is not empty \(it holds tsconfig\.json\).*fastagent init/);
    expect(await exists(join(project, "SYSTEM.md"))).toBe(false); // side-effect-free refusal

    const agent = await freshDir();
    await writeFile(join(agent, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldAgent(agent)).rejects.toThrow(/already a fastagent agent/);

    // Finder noise and the standard commit-an-empty-dir placeholders are not someone's content.
    const noisy = await freshDir();
    for (const noise of [".DS_Store", ".gitkeep"]) await writeFile(join(noisy, noise), "");
    expect((await scaffoldAgent(noisy)).created).toContain("SYSTEM.md");

    // A path that does not exist yet is created, every level of it.
    const deep = join(await freshDir(), "some", "agent");
    await scaffoldAgent(deep);
    expect(await exists(join(deep, "SYSTEM.md"))).toBe(true);
  });
});

describe("add: fastagent add <channel>", () => {
  it("routes into the agent it names: channel + companion tool + secrets all land in that directory", async () => {
    const dir = await freshDir();
    const root = join(dir, "fastagent");
    await mkdir(join(root, ".secrets"), { recursive: true });
    await writeFile(join(root, "fastagent.config.ts"), "export default {};\n");
    await writeFile(join(root, ".secrets", ".env.example"), "# env\n");
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );

    const out = await cliInit(["add", "telegram", "fastagent"], dir);
    expect(out).toContain(join("fastagent", "src", "channels", "telegram.ts")); // reported relative to where it ran
    expect(await exists(join(root, "src", "channels", "telegram.ts"))).toBe(true); // in the agent dir…
    expect(await exists(join(root, "src", "tools", "telegram-send.ts"))).toBe(true); // …with its companion tool
    expect(await exists(join(dir, "src"))).toBe(false); // NOT where the command ran
    expect(await readFile(join(root, ".secrets", ".env.example"), "utf8")).toContain("TELEGRAM_BOT_TOKEN");
    // The program only: no value is written, whatever the app will need.
    expect(await exists(join(root, ".secrets", ".env"))).toBe(false);
  });
});

describe("add: fastagent add skill (vendor)", () => {
  it("vendors a local Agent Skills skill into skills/<name>/ (copy, validated, scripts flagged, refuse-overwrite)", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter", "scripts"), { recursive: true });
    await writeFile(
      join(srcRoot, "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Greet the user warmly and by name.\n---\nSay hello.\n",
    );
    await writeFile(join(srcRoot, "greeter", "scripts", "hi.sh"), "echo hi\n");

    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(ws, "AGENTS.md"), "# Bot\n");

    const r = await vendorSkill(ws, join(srcRoot, "greeter"));
    expect(r.name).toBe("greeter"); // from SKILL.md frontmatter
    expect(r.description).toContain("Greet");
    expect(r.dest).toBe("skills/greeter");
    expect(r.hasScripts).toBe(true); // scripts/ → trust-warning path
    expect(await exists(join(ws, "skills", "greeter", "SKILL.md"))).toBe(true);
    expect(await exists(join(ws, "skills", "greeter", "scripts", "hi.sh"))).toBe(true);
    expect(readSkills(programText(ws).skills).map((s) => s.name)).toContain("greeter"); // really read by the agent's loader

    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/already exists/); // refuse overwrite
  });
});
