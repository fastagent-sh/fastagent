import { describe, expect, it } from "vitest";
import ignore from "ignore";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgentFromDir } from "../src/index.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
import { scaffoldAgent } from "../src/scaffold/init.ts";

/** A path inside the scaffolded agent dir, as scaffoldAgent reports it (relative to the workspace). */
const agentPath = (...parts: string[]) => join("fastagent", ...parts);
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

describe("init: scaffoldAgent", () => {
  it("scaffolds a COMPLETE agent into ./fastagent/ with ZERO writes to the workspace around it", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "# Project spec\n"); // ② context, must survive untouched
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const before = (await readdir(dir)).sort();
    const { complete, created } = await scaffoldAgent(dir);
    expect(complete).toBe(true);
    expect(created.sort()).toEqual(
      [
        agentPath("persona.md"),
        agentPath("skills", "writing-great-skills", "SKILL.md"),
        agentPath("skills", "writing-great-skills", "GLOSSARY.md"),
        agentPath("skills", "writing-great-skills", "LICENSE"),
        agentPath("tools", "fetch-url.ts"),
        agentPath("fastagent.config.mjs"),
        agentPath("package.json"),
        agentPath(".gitignore"),
        agentPath(".secrets", ".env.example"),
        agentPath(".secrets", ".gitignore"),
      ].sort(),
    );
    // THE point of the placement: the workspace gained exactly one entry — `fastagent/` — and nothing else.
    expect((await readdir(dir)).sort()).toEqual([...before, "fastagent"].sort());
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# Project spec\n"); // ②, untouched

    // The agent-root .gitignore covers the .env habit puts there (fastagent reads .secrets/.env, but
    // an unignored root .env is the plausible mistake this layout invites). `.env.example` lives under
    // `.secrets/`, whose own ignore file un-ignores it — so no negation is needed (or wanted) here.
    const rootIgnore = await readFile(join(dir, "fastagent", ".gitignore"), "utf8");
    const ig = ignore({ ignorecase: false }).add(rootIgnore);
    expect(ig.ignores(".env")).toBe(true);
    expect(ig.ignores(".env.local")).toBe(true);
    const secretsIgnore = ignore({ ignorecase: false }).add(
      await readFile(join(dir, "fastagent", ".secrets", ".gitignore"), "utf8"),
    );
    expect(secretsIgnore.ignores(".env")).toBe(true);
    expect(secretsIgnore.ignores(".env.example")).toBe(false); // the template travels

    // Both ignore files travel with the directory; `.secrets/` protects itself independently of the
    // root one, which is the file the author is expected to edit.
    // No trailing slash: `node_modules/` would miss a SYMLINKED one (this repo's own .gitignore
    // carries the same fix, for the same reason).
    expect(await readFile(join(dir, "fastagent", ".gitignore"), "utf8")).toMatch(/^node_modules$/m);
    expect(await readFile(join(dir, "fastagent", ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);

    // .env.example documents env knobs without misleading: all-commented (sets nothing), and it
    // frames auth as a choice (`fastagent login` OR a provider API key), never implying a key is required.
    const envExample = await readFile(join(dir, "fastagent", ".secrets", ".env.example"), "utf8");
    expect(envExample).toMatch(/fastagent login/);
    expect(envExample).toMatch(/set a provider API key/);
    for (const line of envExample.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true); // every non-blank line is a comment
    }

    // package.json is ESM with the tool's deps; the tool imports the package + names from its file.
    const pkg = JSON.parse(await readFile(join(dir, "fastagent", "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    // The fastagent dep tracks this build's version (not a stale hard-coded range), so a fresh
    // agent installs a version that has the API/exports it was scaffolded against. Oracle is the
    // package's real version read DIRECTLY (not fastagentVersion's output) so a corrupt read is caught.
    const realVersion = (
      JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
        version: string;
      }
    ).version;
    expect(pkg.dependencies).toEqual({ "@fastagent-sh/fastagent": `^${realVersion}` });
    expect(await readFile(join(dir, "fastagent", "tools", "fetch-url.ts"), "utf8")).toContain(
      'from "@fastagent-sh/fastagent"',
    );
    const persona = await readFile(join(dir, "fastagent", "persona.md"), "utf8");
    expect(persona).toContain("Use only the tools actually listed in your system prompt");
    expect(persona).not.toContain("where your `read` / `write` / `edit` / `bash` tools operate");
    const configTemplate = await readFile(join(dir, "fastagent", "fastagent.config.mjs"), "utf8");
    // The scaffold documents the OPT-IN, not the default: a new agent already reads, greps, finds and
    // lists; what it does not do is run commands or change files, and that is the line worth showing.
    expect(configTemplate).toContain("codingTools: true");
    expect(configTemplate).toContain("read, grep, find, ls");

    // The scaffolded agent ASSEMBLES: ① persona + tools from fastagent/, ② context walked from the workspace.
    const a = await createPiAgentFromDir(dir, { model: "openai-codex/gpt-5.5" });
    expect(a.agentDir).toBe(join(dir, "fastagent"));
    expect(a.workspace).toBe(dir);
    expect(a.definition.persona).toContain("Persona");
    expect(a.definition.skills.map((s) => s.name)).toEqual(["writing-great-skills"]);
    expect(a.definition.contextFiles.map((f) => f.content).join("\n")).toContain("Project spec");
  });

  it("--minimal keeps persona.md + the example skill + config (no package.json/tool) and assembles fully offline", async () => {
    const dir = await freshDir();
    const { complete, created } = await scaffoldAgent(dir, { minimal: true });
    expect(complete).toBe(false);
    expect(created.sort()).toEqual(
      [
        agentPath("persona.md"),
        agentPath("skills", "writing-great-skills", "SKILL.md"),
        agentPath("skills", "writing-great-skills", "GLOSSARY.md"),
        agentPath("skills", "writing-great-skills", "LICENSE"),
        agentPath(".gitignore"),
        agentPath(".secrets", ".env.example"),
        agentPath(".secrets", ".gitignore"),
        agentPath("fastagent.config.mjs"),
      ].sort(),
    );
    expect(await exists(join(dir, "fastagent", "package.json"))).toBe(false);
    expect(await exists(join(dir, "fastagent", "tools"))).toBe(false);
    // the bundled skill still mounts in the minimal unit
    const def = await loadAgentDefinition(join(dir, "fastagent"));
    expect(def.skills.map((s) => s.name)).toEqual(["writing-great-skills"]);

    // No tool to import → dev assembles with zero edits and zero network. The scaffold presets no
    // model (first-run pick writes it back), so assembly is exercised with an explicit spec.
    const { agent, modelSpec } = await createPiAgentFromDir(dir, { model: "openai-codex/gpt-5.5" });
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");
  });

  it("creates a non-existent target dir (both levels)", async () => {
    const base = await freshDir();
    const target = join(base, "some", "project");
    await scaffoldAgent(target);
    expect(await exists(join(target, "fastagent", "persona.md"))).toBe(true);
  });

  it("preflights a blocking `fastagent` path: a FILE or symlink there fails before any write (retryable)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "fastagent"), "i am a file, not a dir\n");
    await expect(scaffoldAgent(dir)).rejects.toThrow(/"fastagent" exists and is not a directory/);

    // A symlink is rejected, not followed — it would write the agent outside the workspace entirely.
    const external = await freshDir();
    const dir2 = await freshDir();
    await symlink(external, join(dir2, "fastagent"));
    await expect(scaffoldAgent(dir2)).rejects.toThrow(/"fastagent" exists and is not a directory/);
    expect(await readdir(external)).toEqual([]); // nothing escaped into the symlink target
  });

  it("rolls back a mid-write failure to a clean slate, keeping a fastagent/ this run did not create", async () => {
    // Fault injection: a read-only agent dir makes the writes inside it fail after the root exists.
    // Leaving OUR debris would make the next init report the user's directory as occupied; deleting a
    // root THEY pre-created would destroy a directory this run never made. Rollback must do neither.
    const dir = await freshDir();
    const agent = join(dir, "fastagent");
    await mkdir(agent);
    await chmod(agent, 0o500); // r-x: writes inside fail
    await expect(scaffoldAgent(dir)).rejects.toThrow();
    await chmod(agent, 0o700);
    expect(await exists(agent)).toBe(true); // theirs, not ours — preserved
    expect(await readdir(agent)).toEqual([]); // …and empty, so the retry is a fresh scaffold
    expect((await scaffoldAgent(dir)).created).toContain(agentPath("persona.md"));
  });

  it("refuses an occupied ./fastagent/: a config means already-an-agent, anything else means don't mix", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "fastagent"), { recursive: true });
    await writeFile(join(dir, "fastagent", "fastagent.config.mjs"), "export default {};\n");
    await expect(scaffoldAgent(dir)).rejects.toThrow(/already a fastagent agent/);

    const dir2 = await freshDir();
    await mkdir(join(dir2, "fastagent"), { recursive: true });
    await writeFile(join(dir2, "fastagent", "auth.json"), "{}\n"); // an unfinished agent, or something unrelated
    await expect(scaffoldAgent(dir2)).rejects.toThrow(/already holds auth\.json/); // names what blocks it
    expect(await exists(join(dir2, "fastagent", "persona.md"))).toBe(false); // side-effect-free refusal

    // Finder noise and the standard commit-an-empty-dir placeholders are not someone's content.
    const dir3 = await freshDir();
    await mkdir(join(dir3, "fastagent"), { recursive: true });
    for (const noise of [".DS_Store", ".gitkeep"]) await writeFile(join(dir3, "fastagent", noise), "");
    expect((await scaffoldAgent(dir3)).created).toContain(agentPath("persona.md"));

    // A config AT the dir wins over anything inside it, so nesting one under it would be HIDDEN, never
    // served. Refused in both directions, since either unreachable agent is a silent no-op.
    const flatAlready = await freshDir();
    await writeFile(join(flatAlready, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldAgent(flatAlready)).rejects.toThrow(/already resolves to .*never served/s);

    const nestedAlready = await freshDir();
    await mkdir(join(nestedAlready, "fastagent"), { recursive: true });
    await writeFile(join(nestedAlready, "fastagent", "fastagent.config.mjs"), "export default {};\n");
    await expect(scaffoldAgent(nestedAlready, { agentDir: "." })).rejects.toThrow(/never served/);

    // …but a SIBLING is a supported shape, not a collision: several agents on ONE workspace is how
    // different roles drive the same repository, and the lookup selects between them.
    expect((await scaffoldAgent(nestedAlready, { agentDir: "releaser", minimal: true })).agentDir).toBe("releaser");
  });

  it("refuses init inside an agent's own LOADED surface — the outer agent would load it as content", async () => {
    const inside = join(await freshDir(), "fastagent");
    await mkdir(inside);
    await writeFile(join(inside, "fastagent.config.mjs"), "export default {};\n"); // a real agent
    // Its skills/tools/channels/schedules are what it LOADS: an agent scaffolded there becomes part of
    // that definition rather than an agent of its own. Every other command refuses this position too.
    const surface = join(inside, "skills");
    await mkdir(surface);
    await expect(scaffoldAgent(surface)).rejects.toThrow(/is inside the definition of the agent at .*fastagent/);
    expect(await exists(join(surface, "persona.md"))).toBe(false); // side-effect-free refusal

    // The rest of an agent's directory is the AUTHOR's tree — a second agent there is legitimate (the
    // monorepo case), so ownership stops at the loaded surface instead of claiming the whole subtree.
    expect((await scaffoldAgent(join(inside, "packages", "sub"), { minimal: true })).created).toContain(
      agentPath("persona.md"),
    );
  });

  it("--agentDir names the agent directory — the name is never a rule, the config is the marker", async () => {
    const host = await freshDir();
    const { agentDir, created } = await scaffoldAgent(host, { agentDir: "bot", minimal: true });
    expect(agentDir).toBe("bot");
    expect(created).toContain(join("bot", "persona.md"));
    // …and it resolves under that name, with the surrounding tree as its workspace.
    const a = await createPiAgentFromDir(host, { model: "openai-codex/gpt-5.5" });
    expect([a.agentDir, a.workspace]).toEqual([join(host, "bot"), host]);

    // One SEGMENT only: a path would put the agent where the one-level lookup could never find it.
    for (const bad of [join("nested", "bot"), "..", ""]) {
      await expect(scaffoldAgent(await freshDir(), { agentDir: bad })).rejects.toThrow(/single directory name/);
    }
    // …but `./bot` is not a path in any meaningful sense — basename already says it means `bot`, so
    // refusing the spelling would be pedantry rather than a guard.
    expect((await scaffoldAgent(await freshDir(), { agentDir: "./bot", minimal: true })).agentDir).toBe("bot");
  });

  it("`init` nests by DEFAULT — no detection, no prompt; the choice is a flag or nothing", async () => {
    // An existing toolchain changes NOTHING: there is no jurisdiction heuristic, and no prompt.
    const host = await freshDir();
    await writeFile(join(host, "tsconfig.json"), "{}");
    const out = await cliInit(["init", "--no-install"], host);
    expect(out).toMatch(/agent in \.\/fastagent\//);
    expect(out).not.toMatch(/found tsconfig/); // no detection chatter
    expect(await exists(join(host, "fastagent", "persona.md"))).toBe(true);
    expect(await exists(join(host, "fastagent.config.mjs"))).toBe(false); // zero writes around the agent

    // --embedded stayed deleted: "embedded" means using fastagent as a library, nothing else.
    const gone = await freshDir();
    expect(await cliInit(["init", "--embedded"], gone)).toMatch(/unknown option/);
    expect(await exists(join(gone, "fastagent"))).toBe(false);

    // An agent already here → refuse.
    const done = await freshDir();
    await mkdir(join(done, "fastagent"), { recursive: true });
    await writeFile(join(done, "fastagent", "fastagent.config.mjs"), "export default {};\n");
    expect(await cliInit(["init"], done)).toMatch(/already a fastagent agent/);
  });

  it("--flat: the directory IS the agent, existing files are KEPT, and it resolves end to end", async () => {
    // Case this exists for: a standalone agent repo, or a monorepo package. Agent and workspace are the
    // same directory, so the agent's tools operate on its own definition — the point of the mode.
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "dist\n"); // the author's file: adopted, never rewritten
    await writeFile(join(dir, "AGENTS.md"), "# House rules\n");
    const { created, kept, agentDir } = await scaffoldAgent(dir, { agentDir: "." });
    expect(agentDir).toBe(".");
    expect(created).toContain("persona.md"); // at the root, no fastagent/ level
    expect(created).toContain(join(".secrets", ".gitignore")); // credentials still self-protected
    expect(kept).toEqual([".gitignore"]); // theirs wins
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("dist\n"); // …verbatim
    expect(await exists(join(dir, "fastagent"))).toBe(false); // no nested level anywhere

    // Resolution: agent === workspace, and the definition + ② context load from the same directory.
    const a = await createPiAgentFromDir(dir, { model: "openai-codex/gpt-5.5" });
    expect([a.agentDir, a.workspace]).toEqual([dir, dir]);
    expect(a.definition.persona).toContain("Persona");
    expect(a.definition.contextFiles.map((f) => f.content).join("\n")).toContain("House rules");
  });

  it("a package inside an agent's own repository is a legitimate init target", async () => {
    // The monorepo shape: the repo root is an agent, and a package inside it wants its own. An agent's
    // definition is its loaded surface only, so `packages/foo/` is the author's tree — refusing there
    // would make "an agent inside an agent's repository" unreachable.
    const root = await freshDir();
    await scaffoldAgent(root, { agentDir: ".", minimal: true });
    const pkg = join(root, "packages", "reviewer");
    await mkdir(pkg, { recursive: true });
    expect((await scaffoldAgent(pkg, { minimal: true })).created).toContain(agentPath("persona.md"));

    // …but the flat agent's OWN surfaces are still off limits: it would load the new agent as content.
    await expect(scaffoldAgent(join(root, "skills", "mine"), { minimal: true })).rejects.toThrow(
      /is inside the definition of the agent at/,
    );
  });

  it("the name `fastagent` is no longer reserved — nothing about it resolves specially", async () => {
    // It used to be a trap (the NAME was the nested marker, so a flat agent there served with the
    // parent as its workspace). With the config as the only marker there is nothing to trap.
    const named = join(await freshDir(), "fastagent");
    await mkdir(named);
    expect((await scaffoldAgent(named, { agentDir: ".", minimal: true })).agentDir).toBe(".");
    const a = await createPiAgentFromDir(named, { model: "openai-codex/gpt-5.5" });
    expect([a.agentDir, a.workspace]).toEqual([named, named]);

    // Already an agent → refuse rather than double-initialize.
    await expect(scaffoldAgent(named, { agentDir: "." })).rejects.toThrow(/already a fastagent agent/);
  });

  it("createPiAgentFromDir wires the placement end-to-end: persona/tools from the agent dir, ② context from the workspace", async () => {
    const host = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(host, "AGENTS.md"), "# Host repo context\n"); // ② at the workspace
    const root = join(host, "fastagent");
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
    await writeFile(join(root, "persona.md"), "You are the Repo Bot.\n"); // ① in the agent dir
    await writeFile(
      join(root, "tools", "foo.mjs"),
      `export default { description: "d", parameters: { type: "object" }, async execute() { return { content: [], details: "" }; } };`,
    );

    const a = await createPiAgentFromDir(host); // model from config; no invoke, so no auth/network
    expect(a.agentDir).toBe(root);
    expect(a.workspace).toBe(host);
    expect(a.definition.persona).toContain("Repo Bot"); // ① from the agent dir
    expect(a.definition.contextFiles.map((f) => f.content).join("\n")).toContain("Host repo context"); // ② walked from the workspace
    expect(a.toolNames).toContain("foo"); // discovered from the agent dir, not the workspace

    // Pointing AT the agent makes it work on ITSELF — the workspace is what you aim at, deliberately:
    // a deployed box may hold nothing but the agent dir, and there the parent is the container root.
    const b = await createPiAgentFromDir(root);
    expect([b.agentDir, b.workspace]).toEqual([root, root]);
    // What that costs is the WORKSPACE (the agent's cwd, its coding tools' root, deploy's build
    // context) — not ② context, which the ancestor walk still reaches from inside the agent dir.
    expect(b.definition.contextFiles.map((f) => f.content).join("\n")).toContain("Host repo context");
  });

  it("prints a `cd <dir>` step for a named target so the dev/.env/config steps are correct", async () => {
    const base = await freshDir();
    // init into a subdir from `base` as cwd: the next steps must lead with `cd my-agent`.
    const named = await cliInit(["init", "my-agent", "--no-install"], base);
    expect(named).toMatch(/^ {4}cd my-agent$/m);
    // init into cwd (default .): no cd step, bare `fastagent dev` is already correct.
    const cwd = await cliInit(["init", "--no-install"], await freshDir());
    expect(cwd).not.toMatch(/^ {4}cd /m); // the parenthesized install hint is not a cd step
    expect(cwd).toMatch(/fastagent dev/);
  });
});

describe("add: fastagent add <channel> (github / telegram)", () => {
  // A fastagent-ready AGENT DIR, as `fastagent init` produces it: an ESM package declaring the dep.
  // `add` scaffolds INTO this; it never bootstraps it (that is init's job). The tests run the CLI
  // from the agent dir itself — a supported entry point that resolves to the same placement.
  async function readyWorkspace(): Promise<string> {
    const dir = join(await freshDir(), "fastagent");
    await mkdir(dir);
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), "export default {};\n"); // THE marker
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );
    return dir;
  }

  it("routes into the agent dir: channel + companion tool + secrets all land under fastagent/", async () => {
    const dir = await freshDir();
    const root = join(dir, "fastagent");
    await mkdir(join(root, ".secrets"), { recursive: true });
    await writeFile(join(root, "fastagent.config.mjs"), "export default {};\n");
    await writeFile(join(root, ".secrets", ".env.example"), "# env\n");
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );

    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toContain(join("channels", "telegram.ts")); // reported relative to the workspace root
    expect(await exists(join(root, "channels", "telegram.ts"))).toBe(true); // in the agent dir…
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

  it("refuses (writing nothing) when the agent dir is not channel-ready, with an actionable message", async () => {
    /** An agent dir carrying `pkg` as its package.json (undefined = none at all). */
    const agentWith = async (pkg?: object): Promise<string> => {
      const d = join(await freshDir(), "fastagent");
      await mkdir(d);
      await writeFile(join(d, "persona.md"), "You are terse.\n");
      await writeFile(join(d, "fastagent.config.mjs"), "export default {};\n"); // THE marker
      if (pkg) await writeFile(join(d, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      return d;
    };
    const cases: Array<[() => Promise<string>, RegExp]> = [
      [() => agentWith(), /no package\.json|fastagent init/], // no package.json
      [() => agentWith({ type: "commonjs" }), /"type": "module"/], // present but not ESM
      // ESM but missing the dep (node → npm hint)
      [() => agentWith({ type: "module" }), /@fastagent-sh\/fastagent is not a dependency.*npm install/],
    ];
    for (const [make, msg] of cases) {
      const dir = await make();
      const out = await cliInit(["add", "github"], dir);
      expect(out).toMatch(msg);
      expect(await exists(join(dir, "channels", "github.ts"))).toBe(false); // nothing scaffolded
    }
  });

  it("writes the generated secret without any gitignore ceremony — that is the scaffold's job, once", async () => {
    // `add` says nothing about git: an agent's .gitignore was written at init and is the author's from
    // then on. readyWorkspace deliberately has none, and the secret still lands — visibly, in the
    // reported path — instead of the command refusing or lecturing about ignore rules.
    const exposed = await readyWorkspace();
    const out = await cliInit(["add", "github"], exposed);
    expect(out).not.toMatch(/gitignore|committed/i);
    expect(await exists(join(exposed, "channels", "github.ts"))).toBe(true);
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
    expect(out2).toMatch(/outside the agent dir/);
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

  it("`add skill` routes into the nested workspace (symmetric with `add <channel>`) — a host skills/ is never scanned", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(
      join(srcRoot, "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Greet the user warmly and by name.\n---\nSay hello.\n",
    );
    const dir = await freshDir();
    await mkdir(join(dir, "fastagent"), { recursive: true });
    await writeFile(join(dir, "fastagent", "fastagent.config.mjs"), "export default {};\n");

    const out = await cliInit(["add", "skill", join(srcRoot, "greeter")], dir);
    expect(out).toMatch(/vendored skill "greeter"/);
    expect(await exists(join(dir, "fastagent", "skills", "greeter", "SKILL.md"))).toBe(true); // in the agent dir…
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

  it("rejects a skills/ symlink that escapes the agent dir (mkdir would follow it and write outside)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const external = await freshDir();
    await symlink(external, join(ws, "skills")); // skills → outside the workspace
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"));
    await writeFile(join(srcRoot, "greeter", "SKILL.md"), "---\nname: greeter\ndescription: Hi.\n---\nHi.\n");
    await expect(vendorSkill(ws, join(srcRoot, "greeter"))).rejects.toThrow(/outside the agent dir/);
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
