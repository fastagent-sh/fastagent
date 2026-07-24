import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgentFromWorkspace } from "../src/index.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
import { detectHostSignals, scaffoldWorkspace } from "../src/scaffold/init.ts";
import { nextStepCd } from "../src/scaffold/init.ts";
import { vendorSkill } from "../src/scaffold/vendor-skill.ts";

const freshDir = () => mkdtemp(join(tmpdir(), "fa-init-"));
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** Run `fastagent <args>` from `cwd` to completion; return stderr (the [fastagent] report stream). */
function cliInit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", () => resolve(stderr));
  });
}

describe("init: scaffoldWorkspace", () => {
  it("nextStepCd: relative inside cwd, absolute when the target climbs out, nothing for cwd itself", () => {
    expect(nextStepCd("/a/b", "/a/b/x")).toBe("x"); // inside cwd → relative
    expect(nextStepCd("/a/b", "/a/b/..agent")).toBe("..agent"); // a dir literally named "..agent" is INSIDE cwd
    expect(nextStepCd("/a/b", "/a/b")).toBeUndefined(); // already in cwd → no cd step
    expect(nextStepCd("/a/b", "/tmp/x")).toBe("/tmp/x"); // outside → absolute, not ../../tmp/x noise
  });

  it("default scaffolds a COMPLETE agent (persona + the example skill + a code tool + package.json)", async () => {
    const dir = await freshDir();
    const { complete, created, patched, warnings, root } = await scaffoldWorkspace(dir);
    expect(complete).toBe(true);
    expect(root).toBe("."); // flat
    expect(patched).toEqual([]); // fresh .gitignore is ours — nothing to patch
    expect(created).toEqual(
      expect.arrayContaining([
        "persona.md",
        join("skills", "writing-great-skills", "SKILL.md"),
        join("skills", "writing-great-skills", "GLOSSARY.md"),
        join("skills", "writing-great-skills", "LICENSE"),
        join("tools", "fetch-url.ts"),
        "fastagent.config.mjs",
        "package.json",
        ".gitignore",
        join(".secrets", ".env.example"),
        join(".secrets", ".gitignore"),
      ]),
    );
    expect(warnings).toEqual([]);

    // `.secrets/` self-ignores: everything but the template + the protection itself stays local.
    const secretsIgnore = await readFile(join(dir, ".secrets", ".gitignore"), "utf8");
    expect(secretsIgnore).toMatch(/^\*$/m);
    expect(secretsIgnore).toMatch(/^!\.gitignore$/m);
    expect(secretsIgnore).toMatch(/^!\.env\.example$/m);

    // .env.example documents env knobs without misleading: all-commented (sets nothing), and it
    // frames auth as a choice (`fastagent login` OR a provider API key), never implying a key is required.
    const envExample = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    expect(envExample).toMatch(/fastagent login/);
    expect(envExample).toMatch(/set a provider API key/);
    for (const line of envExample.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true); // every non-blank line is a comment
    }

    // package.json is ESM with the tool's deps; the tool imports the package + names from its file.
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    // The fastagent dep tracks this build's version (not a stale hard-coded range), so a fresh
    // workspace installs a version that has the API/exports it was scaffolded against. Oracle is the
    // package's real version read DIRECTLY (not fastagentVersion's output) so a corrupt read is caught.
    const realVersion = (
      JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
        version: string;
      }
    ).version;
    expect(pkg.dependencies).toEqual({ "@fastagent-sh/fastagent": `^${realVersion}` });
    expect(await readFile(join(dir, "tools", "fetch-url.ts"), "utf8")).toContain('from "@fastagent-sh/fastagent"');

    // persona.md + the bundled skill load as a definition offline (loadAgentDefinition does not touch
    // tools/). No AGENTS.md is scaffolded — a fresh agent has no project context (② empty).
    const def = await loadAgentDefinition(dir);
    expect(def.persona).toContain("Persona");
    expect(def.contextFiles).toEqual([]);
    expect(def.skills.map((s) => s.name)).toEqual(["writing-great-skills"]);
    expect(def.collisions).toEqual([]);
  });

  it("--minimal keeps persona.md + the example skill + config (no package.json/tool) and assembles fully offline", async () => {
    const dir = await freshDir();
    const { complete, created } = await scaffoldWorkspace(dir, { minimal: true });
    expect(complete).toBe(false);
    expect(created.sort()).toEqual(
      [
        "persona.md",
        join("skills", "writing-great-skills", "SKILL.md"),
        join("skills", "writing-great-skills", "GLOSSARY.md"),
        join("skills", "writing-great-skills", "LICENSE"),
        ".gitignore",
        join(".secrets", ".env.example"),
        join(".secrets", ".gitignore"),
        "fastagent.config.mjs",
      ].sort(),
    );
    expect(await exists(join(dir, "package.json"))).toBe(false);
    expect(await exists(join(dir, "tools"))).toBe(false);
    // the bundled skill still mounts in the minimal unit
    const def = await loadAgentDefinition(dir);
    expect(def.skills.map((s) => s.name)).toEqual(["writing-great-skills"]);

    // No tool to import → dev assembles with zero edits and zero network. The scaffold presets no
    // model (first-run pick writes it back), so assembly is exercised with an explicit spec.
    const { agent, modelSpec } = await createPiAgentFromWorkspace(dir, { model: "openai-codex/gpt-5.5" });
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");
  });

  it("creates a non-existent target dir (counts as empty, no non-empty note)", async () => {
    const base = await freshDir();
    const target = join(base, "nested", "agent");
    const { intoNonEmpty } = await scaffoldWorkspace(target);
    expect(await exists(join(target, "persona.md"))).toBe(true);
    expect(intoNonEmpty).toBe(false);
  });

  it("preflights blocking parent paths: a file named `tools` or `skills` fails BEFORE writing persona.md (retryable)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "tools"), "i am a file, not a dir\n"); // blocks tools/
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"tools" exists and is not a directory/);
    // no half-scaffold: persona.md was never written, so a retry starts clean
    expect(await exists(join(dir, "persona.md"))).toBe(false);

    // `skills` blocks too — the scaffold writes the example skill there, in default AND --minimal.
    const dir2 = await freshDir();
    await writeFile(join(dir2, "skills"), "i am a file, not a dir\n");
    await expect(scaffoldWorkspace(dir2)).rejects.toThrow(/"skills" exists and is not a directory/);
    expect(await exists(join(dir2, "persona.md"))).toBe(false);
    await expect(scaffoldWorkspace(dir2, { minimal: true })).rejects.toThrow(/"skills" exists and is not a directory/);
  });

  it("rejects a symlinked scaffold parent (does not follow it and write outside the workspace)", async () => {
    const external = await freshDir(); // a dir OUTSIDE the workspace
    const dir = await freshDir();
    await symlink(external, join(dir, "tools")); // `tools` is a symlink → must be rejected, not followed
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"tools" exists and is not a directory/);
    expect(await exists(join(dir, "persona.md"))).toBe(false); // nothing written in the workspace
    expect(await readdir(external)).toEqual([]); // and nothing escaped into the symlink target
  });

  it("rolls back the scaffold when the ignore-patch read throws (unreadable ignore file), keeping retry clean", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "custom\n"); // kept → the patch path reads the ignore matcher
    await mkdir(join(dir, ".fastagentignore")); // a dir where a file is expected → loadRootIgnore throws
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/cannot read .*\.fastagentignore/);
    // the hygiene read sits inside the rollback scope → the scaffolded persona.md was removed,
    // so a retry starts clean
    expect(await exists(join(dir, "persona.md"))).toBe(false);
  });

  it("keeps an existing AGENTS.md (project context, not an ownership marker); refuses only an existing config", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "# My real agent\n");
    const { created } = await scaffoldWorkspace(dir);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# My real agent\n"); // untouched, adopted as ②
    expect(created).toContain("persona.md"); // identity added around it
    expect(created).not.toContain("AGENTS.md"); // never scaffolded

    const dir2 = await freshDir();
    await writeFile(join(dir2, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldWorkspace(dir2)).rejects.toThrow(/already has fastagent\.config\.ts/);

    // A config inside ./.fastagent/ is the SAME marker — an embedded workspace already lives here.
    const dir3 = await freshDir();
    await mkdir(join(dir3, ".fastagent"), { recursive: true });
    await writeFile(join(dir3, ".fastagent", "fastagent.config.mjs"), "export default {};\n");
    await expect(scaffoldWorkspace(dir3)).rejects.toThrow(/already a fastagent workspace/);
  });

  it("detectHostSignals: toolchain/deploy configs and occupied convention dirs signal; md + loose files don't", async () => {
    // A markdown-and-scripts directory: nothing claims it → no signals → flat.
    const notes = await freshDir();
    await writeFile(join(notes, "AGENTS.md"), "# notes\n");
    await writeFile(join(notes, "README.md"), "# readme\n");
    await writeFile(join(notes, "package.json"), `{"name":"x"}`); // a manifest alone is NOT a claim
    await writeFile(join(notes, "helper.js"), "// loose script\n");
    expect(await detectHostSignals(notes)).toEqual([]);

    // A deployable host project: toolchain + deploy manifests claim the tree.
    const host = await freshDir();
    await writeFile(join(host, "tsconfig.json"), "{}");
    await writeFile(join(host, "next.config.ts"), "export default {};\n");
    await writeFile(join(host, "Dockerfile"), "FROM node\n");
    expect(await detectHostSignals(host)).toEqual(["Dockerfile", "next.config.ts", "tsconfig.json"]);

    // Non-JS ecosystems claim their tree the same way — an AGENTS.md-carrying Go/Python repo must not
    // get a flat kit (with a package.json) in its root.
    const goRepo = await freshDir();
    await writeFile(join(goRepo, "AGENTS.md"), "# conventions\n");
    await writeFile(join(goRepo, "go.mod"), "module x\n");
    expect(await detectHostSignals(goRepo)).toEqual(["go.mod"]);
    const pyRepo = await freshDir();
    await writeFile(join(pyRepo, "pyproject.toml"), "[project]\n");
    expect(await detectHostSignals(pyRepo)).toEqual(["pyproject.toml"]);

    // Occupied convention names count (fastagent would scan them as agent surface); empty dirs and
    // dotfile-only dirs (.DS_Store) don't.
    const occupied = await freshDir();
    await mkdir(join(occupied, "tools"), { recursive: true });
    await writeFile(join(occupied, "tools", "build.js"), "// the host's own script\n");
    await mkdir(join(occupied, "skills"), { recursive: true }); // empty → not a signal
    await mkdir(join(occupied, "channels"), { recursive: true });
    await writeFile(join(occupied, "channels", ".DS_Store"), ""); // dotfiles are not agent surface
    expect(await detectHostSignals(occupied)).toEqual(["tools/"]);
  });

  it("detectHostSignals surfaces real IO errors instead of silently deciding the layout (EACCES ≠ absent)", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "x.js"), "//\n");
    await chmod(join(dir, "tools"), 0o000); // unreadable — a REAL failure, not "nothing there"
    try {
      await expect(detectHostSignals(dir)).rejects.toThrow();
    } finally {
      await chmod(join(dir, "tools"), 0o755); // restore so tmp cleanup works
    }
  });

  it("refuses a non-empty ./.fastagent/ target (old state or something unrelated); refusal is side-effect-free", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, ".fastagent"), { recursive: true });
    await writeFile(join(dir, ".fastagent", "auth.json"), "{}\n"); // e.g. an older fastagent's state dir
    await expect(scaffoldWorkspace(dir, { embedded: true })).rejects.toThrow(/not empty.*--flat/s);
    expect(await exists(join(dir, ".fastagent", "persona.md"))).toBe(false); // nothing mixed in

    const dir2 = await freshDir();
    await mkdir(join(dir2, ".fastagent"), { recursive: true });
    await writeFile(join(dir2, ".fastagent", ".DS_Store"), ""); // Finder noise ≠ occupied
    const r = await scaffoldWorkspace(dir2, { embedded: true });
    expect(r.root).toBe(".fastagent");
  });

  it("embedded: the WHOLE workspace lands in ./.fastagent/, ZERO files at the host root", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "# Host repo spec\n");
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const before = (await readdir(dir)).sort();
    const { created, embedded, root } = await scaffoldWorkspace(dir, { embedded: true });
    expect(embedded).toBe(true);
    expect(root).toBe(".fastagent");
    expect(created).toEqual(
      expect.arrayContaining([
        join(".fastagent", "persona.md"),
        join(".fastagent", "skills", "writing-great-skills", "SKILL.md"),
        join(".fastagent", "tools", "fetch-url.ts"),
        join(".fastagent", "package.json"),
        join(".fastagent", ".gitignore"),
        join(".fastagent", "fastagent.config.mjs"),
        join(".fastagent", ".secrets", ".env.example"),
        join(".fastagent", ".secrets", ".gitignore"),
      ]),
    );
    // THE point of the layout: the host root gained exactly one entry — `.fastagent/` — and nothing else.
    expect((await readdir(dir)).sort()).toEqual([...before, ".fastagent"].sort());
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# Host repo spec\n"); // ②, untouched
    // The workspace self-contains its deps + ignores (they travel with the directory).
    expect(await exists(join(dir, "package.json"))).toBe(false);
    expect(await readFile(join(dir, ".fastagent", ".gitignore"), "utf8")).toMatch(/^node_modules\/$/m);
    // The scaffolded workspace ASSEMBLES: persona from .fastagent/, ② context walked from the host root.
    const a = await createPiAgentFromWorkspace(dir, { model: "openai-codex/gpt-5.5" });
    expect(a.root).toBe(join(dir, ".fastagent"));
    expect(a.workbench).toBe(dir);
    expect(a.layout).toBe("embedded");
    expect(a.definition.persona).toContain("Persona");
    expect(a.definition.contextFiles.map((f) => f.content).join("\n")).toContain("Host repo spec");
  });

  it("embedded: ONE workspace shape — the .fastagent/ interior equals a flat scaffold", async () => {
    const flat = await freshDir();
    const embedded = await freshDir();
    const a = await scaffoldWorkspace(flat);
    const b = await scaffoldWorkspace(embedded, { embedded: true });
    // Same files, same relative layout — embedded is the flat shape nested one level down.
    const stripped = b.created.map((p) => p.replace(/^\.fastagent[/\\]/, "")).sort();
    expect(stripped).toEqual(a.created.sort());
  });

  it("`init` decides the layout by jurisdiction signals and prints the reason (no prompt)", async () => {
    // A claimed tree (tsconfig) → the whole workspace into ./.fastagent/, reason printed.
    const host = await freshDir();
    await writeFile(join(host, "tsconfig.json"), "{}");
    const out = await cliInit(["init", "--no-install"], host);
    expect(out).toMatch(/found tsconfig\.json/);
    expect(out).toMatch(/workspace in \.\/\.fastagent\//);
    expect(await exists(join(host, ".fastagent", "persona.md"))).toBe(true);
    expect(await exists(join(host, "fastagent.config.mjs"))).toBe(false); // zero host-root writes

    // --flat overrides the detection.
    const flat = await freshDir();
    await writeFile(join(flat, "tsconfig.json"), "{}");
    const out2 = await cliInit(["init", "--no-install", "--flat"], flat);
    expect(out2).not.toMatch(/\(embedded\)/);
    expect(await exists(join(flat, "persona.md"))).toBe(true);

    // --embedded forces the layout without any signal.
    const forced = await freshDir();
    const out3 = await cliInit(["init", "--no-install", "--embedded"], forced);
    expect(out3).toMatch(/workspace in \.\/\.fastagent\//);
    expect(await exists(join(forced, ".fastagent", "persona.md"))).toBe(true);

    // Conflicting flags are refused (by the parser — a usage error, nothing written).
    const both = await freshDir();
    expect(await cliInit(["init", "--flat", "--embedded"], both)).toMatch(/cannot be used with/);
    expect(await exists(join(both, "persona.md"))).toBe(false);

    // A config → already a workspace → refuse.
    const done = await freshDir();
    await writeFile(join(done, "fastagent.config.mjs"), "export default {};\n");
    expect(await cliInit(["init"], done)).toMatch(/already a fastagent workspace/);
  });

  it("createPiAgentFromWorkspace wires the embedded layout end-to-end: persona/tools from the root, ② context from the workbench", async () => {
    const host = await mkdtemp(join(tmpdir(), "fa-embedded-ws-"));
    await writeFile(join(host, "AGENTS.md"), "# Host repo context\n"); // ② at the workbench
    const root = join(host, ".fastagent");
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
    await writeFile(join(root, "persona.md"), "You are the Repo Bot.\n"); // ① in the workspace root
    await writeFile(
      join(root, "tools", "foo.mjs"),
      `export default { description: "d", parameters: { type: "object" }, async execute() { return { content: [], details: "" }; } };`,
    );

    const a = await createPiAgentFromWorkspace(host); // model from config; no invoke, so no auth/network
    expect(a.root).toBe(root);
    expect(a.workbench).toBe(host);
    expect(a.definition.persona).toContain("Repo Bot"); // ① from the root
    expect(a.definition.contextFiles.map((f) => f.content).join("\n")).toContain("Host repo context"); // ② walked from the workbench
    expect(a.toolNames).toContain("foo"); // discovered from the root, not the workbench
  });

  it("prints a `cd <dir>` step for a named target so the dev/.env/config steps are correct", async () => {
    const base = await freshDir();
    // init into a subdir from `base` as cwd: the next steps must lead with `cd my-agent`.
    const named = await cliInit(["init", "my-agent", "--no-install"], base);
    expect(named).toMatch(/cd my-agent/);
    // init into cwd (default .): no cd step, bare `fastagent dev` is already correct.
    const cwd = await cliInit(["init", "--no-install"], await freshDir());
    expect(cwd).not.toMatch(/cd /);
    expect(cwd).toMatch(/fastagent dev/);
  });

  it("keeps a pre-existing .gitignore's content and APPENDS the missing dependency exclude", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "custom\n"); // no fastagent rules
    const { created, skipped, patched, intoNonEmpty, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(patched).toEqual([".gitignore"]);
    expect(created).toContain("persona.md");
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("custom"); // the host's own rules kept
    expect(gi).toMatch(/^node_modules\/$/m); // the generated npm install is not a 25k-file git flood
    // No .env/.state entries at the root: the machinery dirs carry their own self-ignoring .gitignore.
    expect(gi).not.toMatch(/^\.env$/m);
    expect(intoNonEmpty).toBe(true); // the dir already had the .gitignore
    expect(warnings).toEqual([]); // fixed, nothing left to warn about
  });

  it("appends only what's missing; a covered .gitignore is left alone (secrets need no root entry)", async () => {
    const covered = await freshDir();
    await writeFile(join(covered, ".gitignore"), "node_modules/\n");
    const r = await scaffoldWorkspace(covered);
    expect(r.patched).toEqual([]); // no duplicate lines
    expect((await readFile(join(covered, ".gitignore"), "utf8")).match(/^node_modules\/$/gm)).toHaveLength(1);
    // The secret hygiene lives WITH the secrets: git's nested-ignore precedence makes it authoritative.
    expect(await readFile(join(covered, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });
});

describe("add: fastagent add <channel> (github / telegram)", () => {
  // A fastagent-ready workspace, as `fastagent init` produces it: an ESM package declaring the dep.
  // `add` scaffolds INTO this; it never bootstraps it (that is init's job).
  async function readyWorkspace(): Promise<string> {
    const dir = await freshDir();
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );
    return dir;
  }

  it("routes into the embedded workspace: channel + companion tool + secrets all land under .fastagent/", async () => {
    const dir = await freshDir();
    const root = join(dir, ".fastagent");
    await mkdir(join(root, ".secrets"), { recursive: true });
    await writeFile(join(root, "fastagent.config.mjs"), "export default {};\n");
    await writeFile(join(root, ".secrets", ".env.example"), "# env\n");
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );

    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain(join("channels", "telegram.ts")); // reported relative to the workspace root
    expect(await exists(join(root, "channels", "telegram.ts"))).toBe(true); // in the workspace…
    expect(await exists(join(root, "tools", "telegram-send.ts"))).toBe(true); // …with its companion tool
    expect(await exists(join(dir, "channels"))).toBe(false); // NOT at the host root
    expect(await readFile(join(root, ".secrets", ".env.example"), "utf8")).toContain("TELEGRAM_BOT_TOKEN");
    expect(await readFile(join(root, ".secrets", ".env"), "utf8")).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);
  });

  it("scaffolds channels/github.ts into a ready workspace, mutates nothing else, and refuses to clobber", async () => {
    const dir = await readyWorkspace();
    const out = await cliInit(["add", "github"], dir);
    expect(out).toContain("channels/github.ts");

    const src = await readFile(join(dir, "channels", "github.ts"), "utf8");
    expect(src).toContain('from "@fastagent-sh/fastagent/github"'); // the third-party adapter
    expect(src).toContain("POST /webhook");
    expect(src).toContain("on:"); // the app glue stub the user edits

    // add does NOT bootstrap: package.json is untouched and no .npmrc/.gitignore is written.
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      type: "module",
      dependencies: { "@fastagent-sh/fastagent": "^0.4.0" },
    });
    expect(await exists(join(dir, ".npmrc"))).toBe(false);

    // A second add must not overwrite authored glue.
    const out2 = await cliInit(["add", "github"], dir);
    expect(out2).toMatch(/already exists/);
    expect(await readFile(join(dir, "channels", "github.ts"), "utf8")).toBe(src);
  });

  it("scaffolds channels/telegram.ts (a second channel kind) and coexists with github", async () => {
    const dir = await readyWorkspace();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env.example"), "# env\n"); // add injects channel env vars here
    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain("channels/telegram.ts");
    const src = await readFile(join(dir, "channels", "telegram.ts"), "utf8");
    expect(src).toContain('from "@fastagent-sh/fastagent/telegram"'); // the adapter
    expect(src).toContain("POST /telegram");
    expect(src).toContain("telegramChannel({"); // policy-only glue (agent/stateDir arrive via ctx)
    expect(src).not.toContain("sendDocument"); // the channel file is the channel, NOT the send-tool (no misroute)
    // the companion tool lands in tools/ by the bundle convention (so the agent can send files back)
    const sendTool = await readFile(join(dir, "tools", "telegram-send.ts"), "utf8");
    expect(sendTool).toContain('from "@fastagent-sh/fastagent"');
    expect(sendTool).toContain("sendDocument");
    expect(sendTool).toContain("sendMessage"); // text mode too — the delivery path for scheduled/woken turns
    // next steps carry this channel's env vars (with hints), not github's
    expect(out).toContain("TELEGRAM_BOT_TOKEN");
    expect(out).toContain("@BotFather");
    expect(out).toContain("--tunnel");
    expect(out).not.toContain("GITHUB_WEBHOOK_SECRET");

    // env vars are injected into .secrets/.env.example so a copy-to-.env finds them; the generated
    // secret itself is materialized into .secrets/.env (self-gitignored by construction).
    const envExample = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    expect(envExample).toContain("telegram channel");
    expect(envExample).toContain("TELEGRAM_SECRET_TOKEN");
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);
    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");

    // two channels coexist in one workspace (the discovery/merge mechanism handles many)
    await cliInit(["add", "github"], dir);
    expect(await exists(join(dir, "channels", "github.ts"))).toBe(true);
    expect(await exists(join(dir, "channels", "telegram.ts"))).toBe(true);
  });

  it("writes generated telegram secret to .secrets/.env, leaving only the BotFather token as a manual step", async () => {
    const dir = await readyWorkspace();
    const out = await cliInit(["add", "telegram"], dir);

    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");
    expect(out).toContain("set TELEGRAM_BOT_TOKEN in .secrets/.env");
    expect(out).not.toMatch(/set TELEGRAM_SECRET_TOKEN=/);
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile).toContain("# --- telegram channel ---");
    expect(envFile).toContain("# TELEGRAM_BOT_TOKEN=");
    expect(envFile).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);
    // The secrets dir was made leak-safe BEFORE the secret landed (the self-ignore mechanism).
    expect(await readFile(join(dir, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });

  it("github's generated webhook secret gets the same treatment (kind-neutral), hint kept visible", async () => {
    const dir = await readyWorkspace();
    const out = await cliInit(["add", "github"], dir);

    expect(out).toContain("wrote GITHUB_WEBHOOK_SECRET to .secrets/.env");
    // The hint still prints — it carries an ACTION (paste the same value into the GitHub webhook UI),
    // so a written var is reported, not silently absorbed.
    expect(out).toMatch(/GITHUB_WEBHOOK_SECRET — generated and written to \.secrets\/\.env.*set the same value/);
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^GITHUB_WEBHOOK_SECRET=[0-9a-f]{48}$/m);
  });

  it("a .env copied from .env.example (marker present) gets the secret slotted UNDER the marker", async () => {
    const dir = await readyWorkspace();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    // What a user gets from `cp .env.example .env` after a previous add appended the block there.
    await writeFile(
      join(dir, ".secrets", ".env"),
      "# mine\nOPENAI_API_KEY=sk-x\n\n# --- telegram channel ---\n# from @BotFather → /newbot\n# TELEGRAM_BOT_TOKEN=\n",
    );
    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    // Slotted under the existing marker — not orphaned at the end of the file.
    expect(envFile).toMatch(/# --- telegram channel ---\nTELEGRAM_SECRET_TOKEN=[0-9a-f]{48}\n/);
    // The commented BOT_TOKEN placeholder is mentioned already — not duplicated.
    expect(envFile.match(/TELEGRAM_BOT_TOKEN/g)).toHaveLength(1);
    expect(envFile).toContain("OPENAI_API_KEY=sk-x"); // untouched
  });

  it("an ACTIVE but EMPTY assignment is replaced IN PLACE — never shadowed by a line elsewhere (last-wins)", async () => {
    const dir = await readyWorkspace();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    // The uncommented-but-unfilled placeholder: marker block present, `KEY=` active and empty, and a
    // LATER unrelated line — a slot-under-marker write would lose to last-wins here.
    await writeFile(
      join(dir, ".secrets", ".env"),
      "# --- telegram channel ---\nTELEGRAM_SECRET_TOKEN=\nOPENAI_API_KEY=sk-x\n",
    );
    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile.match(/^TELEGRAM_SECRET_TOKEN=/gm)).toHaveLength(1); // replaced, not duplicated
    expect(envFile).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m); // …with a real value in place
    expect(envFile).toContain("OPENAI_API_KEY=sk-x");
  });

  it("keeps an existing non-empty telegram secret in .secrets/.env", async () => {
    const dir = await readyWorkspace();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "TELEGRAM_SECRET_TOKEN=keep-me\n");
    const out = await cliInit(["add", "telegram"], dir);

    expect(out).not.toContain("wrote TELEGRAM_SECRET_TOKEN");
    expect(out).not.toMatch(/set TELEGRAM_SECRET_TOKEN=/);
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile.match(/^TELEGRAM_SECRET_TOKEN=/gm)).toHaveLength(1);
    expect(envFile).toContain("TELEGRAM_SECRET_TOKEN=keep-me");
  });

  it("never clobbers an author's companion tool when scaffolding the channel", async () => {
    const dir = await readyWorkspace();
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "telegram-send.ts"), "// mine\n"); // author already has this tool name
    await cliInit(["add", "telegram"], dir);
    expect(await exists(join(dir, "channels", "telegram.ts"))).toBe(true); // channel still scaffolded
    expect(await readFile(join(dir, "tools", "telegram-send.ts"), "utf8")).toBe("// mine\n"); // tool untouched
  });

  it("refuses (writing nothing) when the workspace is not channel-ready, with an actionable message", async () => {
    const cases: Array<[() => Promise<string>, RegExp]> = [
      [() => freshDir(), /no package\.json|fastagent init/], // no package.json
      [
        async () => {
          const d = await freshDir();
          await writeFile(join(d, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
          return d;
        },
        /"type": "module"/, // present but not ESM
      ],
      [
        async () => {
          const d = await freshDir();
          await writeFile(join(d, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
          return d;
        },
        /@fastagent-sh\/fastagent is not a dependency.*npm install/, // ESM but missing the dep (node → npm hint)
      ],
    ];
    for (const [make, msg] of cases) {
      const dir = await make();
      const out = await cliInit(["add", "github"], dir);
      expect(out).toMatch(msg);
      expect(await exists(join(dir, "channels", "github.ts"))).toBe(false); // nothing scaffolded
    }
  });

  it("makes .secrets/ leak-safe by construction — no gitignore precondition, no warning needed", async () => {
    // readyWorkspace has no .gitignore at all: the secret still lands safely, because the CLI
    // ensures the self-ignoring .secrets/.gitignore BEFORE writing (nested ignores are authoritative).
    const exposed = await readyWorkspace();
    const out = await cliInit(["add", "github"], exposed);
    expect(out).not.toMatch(/not gitignored/);
    expect(await exists(join(exposed, "channels", "github.ts"))).toBe(true);
    expect(await readFile(join(exposed, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(await readFile(join(exposed, ".secrets", ".env"), "utf8")).toMatch(/^GITHUB_WEBHOOK_SECRET=/m);
  });

  it("scaffolds through an IN-workspace symlinked channels/, but rejects one that ESCAPES (no outside write)", async () => {
    // in-workspace symlink (channels → ./real): followed, github.ts written inside the workspace
    const dir = await readyWorkspace();
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "channels"));
    const out = await cliInit(["add", "github"], dir);
    expect(out).toMatch(/created/);
    expect(await exists(join(dir, "real", "github.ts"))).toBe(true); // written through the in-workspace symlink

    // escaping symlink (channels → external dir): rejected, nothing written outside the workspace
    const esc = await readyWorkspace();
    const ext = await freshDir();
    await mkdir(join(ext, "ch"));
    await symlink(join(ext, "ch"), join(esc, "channels"));
    const out2 = await cliInit(["add", "github"], esc);
    expect(out2).toMatch(/outside the workspace/);
    expect(await exists(join(ext, "ch", "github.ts"))).toBe(false); // not written outside
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
    expect(r.diagnostics).toEqual([]); // spec-clean, no name/desc warnings
    expect(await exists(join(ws, "skills", "greeter", "SKILL.md"))).toBe(true);
    expect(await exists(join(ws, "skills", "greeter", "scripts", "hi.sh"))).toBe(true);
    const def = await loadAgentDefinition(ws);
    expect(def.skills.map((s) => s.name)).toContain("greeter"); // really mounted by the runtime loader

    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/already exists/); // refuse overwrite
  });

  it("`add skill` routes into the embedded workspace (symmetric with `add <channel>`) — a host skills/ is never scanned", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(
      join(srcRoot, "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Greet the user warmly and by name.\n---\nSay hello.\n",
    );
    const dir = await freshDir();
    await mkdir(join(dir, ".fastagent"), { recursive: true });
    await writeFile(join(dir, ".fastagent", "fastagent.config.mjs"), "export default {};\n");

    const out = await cliInit(["add", "skill", join(srcRoot, "greeter")], dir);
    expect(out).toMatch(/vendored skill "greeter"/);
    expect(await exists(join(dir, ".fastagent", "skills", "greeter", "SKILL.md"))).toBe(true); // in the workspace…
    expect(await exists(join(dir, "skills"))).toBe(false); // …NOT at the host root (it would never be scanned)
  });

  it("rejects a source with no SKILL.md (not an Agent Skills skill), leaving no half-vendor", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "notaskill"), { recursive: true });
    await writeFile(join(srcRoot, "notaskill", "readme.txt"), "x\n");
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await expect(vendorSkill(ws, join(srcRoot, "notaskill"))).rejects.toThrow(/SKILL\.md/);
    expect(await exists(join(ws, "skills", "notaskill"))).toBe(false); // no half-vendor left behind
  });

  it("vendors a bare name from a local global skill dir (~/.agents/skills) — add-time copy, not a runtime scan", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    await mkdir(join(home, ".agents", "skills", "greeter"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Greet the user warmly.\n---\nHi.\n",
    );
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await vendorSkill(ws, "greeter");
      expect(r.name).toBe("greeter");
      expect(r.dest).toBe("skills/greeter");
      expect(await exists(join(ws, "skills", "greeter", "SKILL.md"))).toBe(true); // copied in (git-tracked)
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("a bare name absent from every global skill dir fails with guidance (never treated as a github repo)", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(vendorSkill(ws, "nonesuch")).rejects.toThrow(/global skill dirs/);
      expect(await exists(join(ws, "skills", "nonesuch"))).toBe(false);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("--update overwrites an existing skill (git-tracked re-fetch); without it, refuses and leaves it untouched", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: v1.\n---\nOne.\n");
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));

    const first = await vendorSkill(ws, join(srcRoot, "greeter"));
    expect(first.overwritten).toBe(false);

    // upstream changes
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: v2 updated.\n---\nTwo.\n");

    // without --update: refuses, on-disk skill stays v1 (mutation-proof: a no-op overwrite would pass)
    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/--update/);
    expect(await readFile(join(ws, "skills", "greeter", "SKILL.md"), "utf8")).toContain("One.");

    // with --update: overwrites to v2
    const updated = await vendorSkill(ws, join(srcRoot, "greeter"), { update: true });
    expect(updated.overwritten).toBe(true);
    expect(updated.description).toContain("v2");
    expect(await readFile(join(ws, "skills", "greeter", "SKILL.md"), "utf8")).toContain("Two.");
    expect((await readdir(join(ws, "skills"))).some((entry) => entry.startsWith(".greeter.previous-"))).toBe(false);
  });

  it("stops on an interrupted --update backup without deleting or guessing how to recover it", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: old.\n---\nOld.\n");
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await vendorSkill(ws, join(srcRoot, "greeter"));
    const backup = join(ws, "skills", ".greeter.previous-00000000-0000-4000-8000-000000000000");
    await rename(join(ws, "skills", "greeter"), backup);

    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/interrupted skill update backup/);
    expect(await readFile(join(backup, "SKILL.md"), "utf8")).toContain("Old.");
    expect(await exists(join(ws, "skills", "greeter"))).toBe(false);
  });

  it("rejects a skills/ symlink that escapes the workspace (mkdir would follow it and write outside)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const external = await freshDir();
    await symlink(external, join(ws, "skills")); // skills → outside the workspace
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"));
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: Hi.\n---\nHi.\n");
    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/outside the workspace/);
    expect(await readdir(external)).toEqual([]); // nothing escaped into the symlink target
  });

  it("fails once with a clear message when `skills` is a plain file (not per-write EEXIST noise)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(ws, "skills"), "i am a file\n");
    await expect(vendorSkill(ws, "greeter")).rejects.toThrow(/exists and is not a directory/);
  });

  it("--update failure leaves the existing skill intact (validate-before-replace, not destructive-first)", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: v1.\n---\nOne.\n");
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await vendorSkill(ws, join(srcRoot, "greeter")); // vendor v1

    // --update from an INVALID source (no SKILL.md): under destructive-first the old skill would be
    // deleted before the failure; validate-before-replace must leave v1 fully intact.
    const bad = await mkdtemp(join(tmpdir(), "fa-bad-"));
    await mkdir(join(bad, "greeter"), { recursive: true });
    await writeFile(join(bad, "greeter", "readme.txt"), "x\n"); // no SKILL.md
    await expect(vendorSkill(ws, join(bad, "greeter"), { update: true })).rejects.toThrow(/SKILL\.md/);
    expect(await exists(join(ws, "skills", "greeter", "SKILL.md"))).toBe(true); // old skill survived
    expect(await readFile(join(ws, "skills", "greeter", "SKILL.md"), "utf8")).toContain("One.");
    expect(await exists(join(ws, "skills", ".greeter.vendoring"))).toBe(false); // no staging leftover
  });

  it("attributes diagnostics by exact skill dir, not a loose prefix (pdf must not absorb pdf-tools')", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    // pdf-tools: frontmatter name ≠ dir → a real spec diagnostic, at skills/pdf-tools/
    await mkdir(join(srcRoot, "pdf-tools"), { recursive: true });
    await writeFile(join(srcRoot, "pdf-tools", "SKILL.md"), "---\nname: wrongname\ndescription: tools.\n---\nx\n");
    // pdf: spec-clean
    await mkdir(join(srcRoot, "pdf"), { recursive: true });
    await writeFile(join(srcRoot, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: clean pdf skill.\n---\nx\n");

    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(ws, "AGENTS.md"), "# Bot\n");
    await vendorSkill(ws, join(srcRoot, "pdf-tools")); // carries a diagnostic
    const r = await vendorSkill(ws, join(srcRoot, "pdf")); // clean

    // `skills/pdf` ⊂ `skills/pdf-tools`: a loose-prefix filter would wrongly pull pdf-tools' diagnostic
    // into pdf's. Exact dir match → pdf is clean.
    expect(r.name).toBe("pdf");
    expect(r.description).toContain("clean");
    expect(r.diagnostics).toEqual([]);
  });
});
