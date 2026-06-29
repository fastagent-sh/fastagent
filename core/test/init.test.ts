import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgentFromWorkspace, loadAgentDefinition, scaffoldWorkspace } from "../src/index.ts";
import { nextStepCd } from "../src/engines/pi/scaffold/init.ts";
import { vendorSkill } from "../src/engines/pi/scaffold/vendor-skill.ts";

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

  it("default scaffolds a COMPLETE agent (instructions + skill + a code tool + package.json)", async () => {
    const dir = await freshDir();
    const { complete, created, warnings } = await scaffoldWorkspace(dir);
    expect(complete).toBe(true);
    expect(created).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        join("skills", "house-style", "SKILL.md"),
        join("tools", "word-count.ts"),
        "fastagent.config.mjs",
        "package.json",
        ".gitignore",
        ".env.example",
      ]),
    );
    expect(warnings).toEqual([]);

    // .env.example documents env knobs without misleading: all-commented (sets nothing), and it
    // states the default model uses OAuth (`fastagent login`), never implying an API key is required.
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toMatch(/fastagent login/);
    expect(envExample).toMatch(/OAuth, not an API key/);
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
    expect(pkg.dependencies["@kid7st/fastagent"]).toBe(`^${realVersion}`);
    expect(pkg.dependencies.zod).toBeDefined();
    expect(await readFile(join(dir, "tools", "word-count.ts"), "utf8")).toContain('from "@kid7st/fastagent"');

    // AGENTS.md + skill load as a definition offline (loadAgentDefinition does not touch tools/).
    const def = await loadAgentDefinition(dir);
    expect(def.skills.map((s) => s.name)).toEqual(["house-style"]);
    expect(def.collisions).toEqual([]);
  });

  it("--minimal scaffolds the markdown-only unit (no package.json/tool) and assembles fully offline", async () => {
    const dir = await freshDir();
    const { complete, created } = await scaffoldWorkspace(dir, { minimal: true });
    expect(complete).toBe(false);
    expect(created.sort()).toEqual(
      [
        "AGENTS.md",
        ".gitignore",
        ".env.example",
        "fastagent.config.mjs",
        join("skills", "house-style", "SKILL.md"),
      ].sort(),
    );
    expect(await exists(join(dir, "package.json"))).toBe(false);
    expect(await exists(join(dir, "tools"))).toBe(false);

    // No tool to import → dev assembles with zero edits and zero network.
    const { agent, modelSpec } = await createPiAgentFromWorkspace(dir);
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");
  });

  it("creates a non-existent target dir (counts as empty, no non-empty note)", async () => {
    const base = await freshDir();
    const target = join(base, "nested", "agent");
    const { intoNonEmpty } = await scaffoldWorkspace(target);
    expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    expect(intoNonEmpty).toBe(false);
  });

  it("preflights blocking parent paths: a file named `skills` fails BEFORE writing AGENTS.md (retryable)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "skills"), "i am a file, not a dir\n"); // blocks skills/house-style/
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"skills" exists and is not a directory/);
    // no half-scaffold: AGENTS.md was never written, so a retry is not blocked by the guard
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("rejects a symlinked scaffold parent (does not follow it and write outside the workspace)", async () => {
    const external = await freshDir(); // a dir OUTSIDE the workspace
    const dir = await freshDir();
    await symlink(external, join(dir, "skills")); // `skills` is a symlink → must be rejected, not followed
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"skills" exists and is not a directory/);
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false); // nothing written in the workspace
    expect(await readdir(external)).toEqual([]); // and nothing escaped into the symlink target
  });

  it("rolls back the scaffold when the .env advisory read throws (unreadable ignore file), keeping retry clean", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, ".fastagentignore")); // a dir where a file is expected → loadRootIgnore throws
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/cannot read .*\.fastagentignore/);
    // the advisory read sits inside the rollback scope → the scaffolded AGENTS.md was removed,
    // so a retry is not blocked by the overwrite guard
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("refuses to overwrite an existing workspace (AGENTS.md or a config), leaving it intact", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "# My real agent\n");
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/already has AGENTS\.md .* refuses to overwrite/);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# My real agent\n"); // untouched

    const dir2 = await freshDir();
    await writeFile(join(dir2, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldWorkspace(dir2)).rejects.toThrow(/already has fastagent\.config\.ts/);
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

  it("keeps a pre-existing .gitignore; warns when it does not ignore .env (a deploy could ship secrets)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "custom\n"); // no .env rule
    const { created, skipped, intoNonEmpty, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(created).toContain("AGENTS.md");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("custom\n"); // kept, NOT mutated
    expect(intoNonEmpty).toBe(true); // the dir already had the .gitignore
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("does not warn when a kept .gitignore already covers .env", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "node_modules/\n*.env\n"); // *.env covers .env
    const { skipped, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(warnings).toEqual([]);
  });

  // The advisory must mirror build's matcher (loadRootIgnore: .gitignore + .fastagentignore,
  // fa last, case-SENSITIVE), or it gives false assurance in the dangerous direction.
  it("warns on a case-mismatched rule (.ENV does not exclude .env under build's case-sensitive matcher)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), ".ENV\n"); // wrong case → build (ignorecase:false) ships .env
    const { warnings } = await scaffoldWorkspace(dir);
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("warns when .fastagentignore re-includes .env (applied last, authoritative — build ships it)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), ".env\n"); // git excludes it …
    await writeFile(join(dir, ".fastagentignore"), "!.env\n"); // … but fa un-excludes it (last wins)
    const { warnings } = await scaffoldWorkspace(dir);
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("does not warn when .fastagentignore excludes .env though the kept .gitignore does not (combined matcher)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "node_modules/\n"); // kept, NO .env rule
    await writeFile(join(dir, ".fastagentignore"), ".env\n"); // fa covers it → build excludes
    const { skipped, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(warnings).toEqual([]);
  });
});

describe("add: fastagent add <channel> (github / telegram)", () => {
  // A fastagent-ready workspace, as `fastagent init` produces it: an ESM package declaring the dep.
  // `add` scaffolds INTO this; it never bootstraps it (that is init's job).
  async function readyWorkspace(): Promise<string> {
    const dir = await freshDir();
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@kid7st/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );
    return dir;
  }

  it("scaffolds channels/github.ts into a ready workspace, mutates nothing else, and refuses to clobber", async () => {
    const dir = await readyWorkspace();
    const out = await cliInit(["add", "github"], dir);
    expect(out).toContain("channels/github.ts");

    const src = await readFile(join(dir, "channels", "github.ts"), "utf8");
    expect(src).toContain('from "@kid7st/fastagent/github"'); // the third-party adapter
    expect(src).toContain("POST /webhook");
    expect(src).toContain("on:"); // the app glue stub the user edits

    // add does NOT bootstrap: package.json is untouched and no .npmrc/.gitignore is written.
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      type: "module",
      dependencies: { "@kid7st/fastagent": "^0.4.0" },
    });
    expect(await exists(join(dir, ".npmrc"))).toBe(false);

    // A second add must not overwrite authored glue.
    const out2 = await cliInit(["add", "github"], dir);
    expect(out2).toMatch(/already exists/);
    expect(await readFile(join(dir, "channels", "github.ts"), "utf8")).toBe(src);
  });

  it("scaffolds channels/telegram.ts (a second channel kind) and coexists with github", async () => {
    const dir = await readyWorkspace();
    await writeFile(join(dir, ".env.example"), "# env\n"); // add injects channel env vars here
    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain("channels/telegram.ts");
    const src = await readFile(join(dir, "channels", "telegram.ts"), "utf8");
    expect(src).toContain('from "@kid7st/fastagent/telegram"'); // the adapter
    expect(src).toContain("POST /telegram");
    expect(src).toContain("on:"); // the app glue stub
    // next steps carry this channel's env vars (with hints), not github's
    expect(out).toContain("TELEGRAM_BOT_TOKEN");
    expect(out).toContain("@BotFather");
    expect(out).toContain("--tunnel");
    expect(out).not.toContain("GITHUB_WEBHOOK_SECRET");

    // env vars are injected into .env.example so a copy-to-.env finds them
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toContain("telegram channel");
    expect(envExample).toContain("TELEGRAM_SECRET_TOKEN");

    // two channels coexist in one workspace (the discovery/merge mechanism handles many)
    await cliInit(["add", "github"], dir);
    expect(await exists(join(dir, "channels", "github.ts"))).toBe(true);
    expect(await exists(join(dir, "channels", "telegram.ts"))).toBe(true);
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
        /@kid7st\/fastagent.*dependencies/, // ESM but missing the dep
      ],
    ];
    for (const [make, msg] of cases) {
      const dir = await make();
      const out = await cliInit(["add", "github"], dir);
      expect(out).toMatch(msg);
      expect(await exists(join(dir, "channels", "github.ts"))).toBe(false); // nothing scaffolded
    }
  });

  it("warns (but does not refuse) when .env is not gitignored; stays quiet when it is", async () => {
    // readyWorkspace has no .gitignore — a secret in .env would be shipped by the build.
    const exposed = await readyWorkspace();
    const out = await cliInit(["add", "github"], exposed);
    expect(out).toMatch(/\.env is not gitignored/);
    expect(await exists(join(exposed, "channels", "github.ts"))).toBe(true); // warned, not refused

    const safe = await readyWorkspace();
    await writeFile(join(safe, ".gitignore"), ".env\n");
    const out2 = await cliInit(["add", "github"], safe);
    expect(out2).not.toMatch(/not gitignored/);
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
