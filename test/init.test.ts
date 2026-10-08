import { execFileSync } from "node:child_process";
import { hermeticGit, withGitIdentity } from "./git-env.ts";
import { describe, expect, it } from "vitest";
import ignore from "ignore";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collect, createPiAgentFromDefinition, createPiAgentFromDir } from "../src/index.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
import { scaffoldAgent } from "../src/scaffold/init.ts";
import { WEB_ACCESS_PACKAGE } from "../src/scaffold/templates.ts";

import { vendorSkill } from "../src/scaffold/vendor-skill.ts";

const freshDir = () => mkdtemp(join(tmpdir(), "fa-init-"));
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const withIdentity = withGitIdentity;

/** Run `fastagent <args>` from `cwd` to completion; return stderr (the [fastagent] report stream). */
function cliInit(args: string[], cwd: string, env: NodeJS.ProcessEnv = withIdentity): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", () => resolve(stderr));
  });
}

describe("init: scaffoldAgent", () => {
  it("scaffolds a COMPLETE agent INTO the directory it names", async () => {
    const dir = join(await freshDir(), "reviewer");
    const { created } = await scaffoldAgent(dir, { webAccess: true });
    expect(created.sort()).toEqual(
      [
        "APPEND_SYSTEM.md",
        join("skills", "writing-great-skills", "SKILL.md"),
        join("skills", "writing-great-skills", "GLOSSARY.md"),
        join("skills", "writing-great-skills", "LICENSE"),
        join("extensions", "web-access.ts"),
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
    // The fastagent dep tracks this build's version (not a stale hard-coded range), so a fresh
    // agent installs a version that has the API/exports it was scaffolded against. Oracle is the
    // package's real version read DIRECTLY (not fastagentVersion's output) so a corrupt read is caught.
    const realVersion = (
      JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
        version: string;
      }
    ).version;
    expect(pkg.dependencies).toEqual({
      "@fastagent-sh/fastagent": `^${realVersion}`,
      [WEB_ACCESS_PACKAGE.name]: WEB_ACCESS_PACKAGE.range, // what extensions/web-access.ts loads
    });
    expect(await readFile(join(dir, "extensions", "web-access.ts"), "utf8")).toContain(
      `from "${WEB_ACCESS_PACKAGE.name}"`,
    );
    const standing = await readFile(join(dir, "APPEND_SYSTEM.md"), "utf8");
    expect(standing).toContain("Use only the tools actually listed in your system prompt");
    expect(standing).not.toMatch(/workspace/i);
    // Added to pi's default prompt, which already says who the agent is: an identity here would give it two.
    expect(standing).not.toMatch(/^You are/m);
    const configTemplate = await readFile(join(dir, "fastagent.config.ts"), "utf8");
    expect(configTemplate).not.toContain("codingTools");

    // The scaffolded agent ASSEMBLES, from the directory itself.
    const a = await createPiAgentFromDir(dir, { model: "openai-codex/gpt-5.5" });
    expect(a.agentDir).toBe(dir);
    expect(a.definition.appendSystemPrompt?.content).toContain("Standing instructions");
    expect(a.definition.skills.map((s) => s.name)).toEqual(["writing-great-skills"]);
  });

  it("the skill APPEND_SYSTEM.md sends the agent to is listed in its prompt, with where it is", async () => {
    // Named, not given as a relative path: pi tells the model to resolve a relative path against a skill's own
    // directory, and a path to a skill the prompt does not list sent models guessing at another package's directory.
    const dir = join(await freshDir(), "agent");
    await scaffoldAgent(dir);
    expect(await readFile(join(dir, "APPEND_SYSTEM.md"), "utf8")).toContain("Read the `writing-great-skills` skill");
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain(
      `<name>writing-great-skills</name>\n    <description>Reference for writing and editing skills well`,
    );
    expect(prompt).toContain(`<location>${join(dir, "skills", "writing-great-skills", "SKILL.md")}</location>`);
  });

  it("refuses a directory that is not empty, naming what is there; an empty or new one is fine", async () => {
    const project = await freshDir();
    await writeFile(join(project, "tsconfig.json"), "{}");
    await expect(scaffoldAgent(project)).rejects.toThrow(/is not empty \(it holds tsconfig\.json\).*fastagent init/);
    expect(await exists(join(project, "APPEND_SYSTEM.md"))).toBe(false); // side-effect-free refusal

    const agent = await freshDir();
    await writeFile(join(agent, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldAgent(agent)).rejects.toThrow(/already a fastagent agent/);

    // Finder noise and the standard commit-an-empty-dir placeholders are not someone's content.
    const noisy = await freshDir();
    for (const noise of [".DS_Store", ".gitkeep"]) await writeFile(join(noisy, noise), "");
    expect((await scaffoldAgent(noisy)).created).toContain("APPEND_SYSTEM.md");

    // A path that does not exist yet is created, every level of it.
    const deep = join(await freshDir(), "some", "agent");
    await scaffoldAgent(deep);
    expect(await exists(join(deep, "APPEND_SYSTEM.md"))).toBe(true);
  });

  it("a FILE or symlink where the agent should go fails before any write", async () => {
    const base = await freshDir();
    await writeFile(join(base, "agent"), "i am a file, not a dir\n");
    await expect(scaffoldAgent(join(base, "agent"))).rejects.toThrow(/exists and is not a directory/);

    // A symlink is rejected, not followed — it would write the agent somewhere else entirely.
    const external = await freshDir();
    await symlink(external, join(base, "link"));
    await expect(scaffoldAgent(join(base, "link"))).rejects.toThrow(/exists and is not a directory/);
    expect(await readdir(external)).toEqual([]); // nothing escaped into the symlink target
  });

  it("undo removes what the scaffold created, and leaves a directory it was handed", async () => {
    // What `init` runs when declaring the contexts fails after the scaffold: a retry must not find an agent there.
    const created = join(await freshDir(), "new");
    await (await scaffoldAgent(created)).undo();
    expect(await exists(created)).toBe(false);
    const handed = await freshDir();
    await (await scaffoldAgent(handed)).undo();
    expect(await readdir(handed)).toEqual([]);
  });

  it("rolls back a mid-write failure to a clean slate, keeping a directory this run did not create", async () => {
    // Fault injection: a read-only agent dir makes the writes inside it fail after the root exists.
    // Leaving OUR debris would make the next init report the user's directory as occupied; deleting a
    // root THEY pre-created would destroy a directory this run never made. Rollback must do neither.
    const agent = await freshDir();
    await chmod(agent, 0o500); // r-x: writes inside fail
    await expect(scaffoldAgent(agent)).rejects.toThrow();
    await chmod(agent, 0o700);
    expect(await exists(agent)).toBe(true); // theirs, not ours — preserved
    expect(await readdir(agent)).toEqual([]); // …and empty, so the retry is a fresh scaffold
    expect((await scaffoldAgent(agent)).created).toContain("APPEND_SYSTEM.md");
  });

  it("refuses inside another agent, at any depth — that directory is the outer agent's own", async () => {
    const outer = await freshDir();
    await writeFile(join(outer, "fastagent.config.ts"), "export default {};\n");
    for (const inner of [join(outer, "skills", "mine"), join(outer, "packages", "reviewer")]) {
      await expect(scaffoldAgent(inner)).rejects.toThrow(new RegExp(`is inside the agent ${outer}`));
      expect(await exists(inner)).toBe(false); // side-effect-free refusal
    }
  });

  it("--context declares what the agent works on, in the literal list; a nested one is refused before any write", async () => {
    const base = await realpath(await freshDir());
    const app = join(base, "app");
    await mkdir(app);
    const out = await cliInit(["init", "reviewer", "--context", "app", "--no-install"], base);
    expect(out).toMatch(/created .*reviewer/);
    expect(out).toContain(`works on app  ${app} (local, this machine only)`);
    const config = await readFile(join(base, "reviewer", "fastagent.config.ts"), "utf8");
    expect(config).toContain(`  contexts: [\n    { local: ${JSON.stringify(app)} },\n  ],\n`);
    // There is no copy for a host: a directory stays on this machine.
    expect(await cliInit(["init", "nothing", "--context", "app", "--copy", "--no-install"], base)).toMatch(
      /unknown option '--copy'/,
    );
    expect(await exists(join(base, "nothing"))).toBe(false);

    // An agent inside what it works on: refused with the way out, and nothing created.
    const nested = await cliInit(["init", join(app, "agent"), "--context", app, "--no-install"], base);
    expect(nested).toMatch(/context "app" .* contains the agent directory .* move it out/);
    expect(await exists(join(app, "agent"))).toBe(false);
    // A symlinked ancestor does not hide the nesting: refused before the scaffold, not after it.
    await symlink(base, join(base, "..", `${basename(base)}-link`));
    const viaLink = await cliInit(
      ["init", join(`${base}-link`, "app", "agent2"), "--context", app, "--no-install"],
      base,
    );
    expect(viaLink).toMatch(/contains the agent directory/);
    expect(await exists(join(app, "agent2"))).toBe(false);
    // Run in a project, init says how to have an agent work on it.
    await writeFile(join(app, "README.md"), "the project\n");
    expect(await cliInit(["init", ".", "--no-install"], app)).toMatch(/fastagent init <new directory> --context \./);
  });

  it("makes the agent a git repository with the scaffold as its first commit, and says when it does not", async () => {
    const env = withIdentity;
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    const base = await realpath(await freshDir());

    expect(await cliInit(["init", "mine", "--no-install"], base, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    const mine = join(base, "mine");
    expect(git(["rev-parse", "--show-toplevel"], mine)).toBe(mine);
    expect(git(["log", "--format=%s"], mine)).toBe("Create the agent with fastagent");
    expect(git(["status", "--porcelain"], mine)).toBe(""); // all of it committed
    expect(git(["ls-files"], mine).split("\n")).toEqual(
      expect.arrayContaining(["fastagent.config.ts", "APPEND_SYSTEM.md", ".gitignore", ".secrets/.env.example"]),
    );

    // Inside a repository already: that one tracks the agent, and no second one hides its files from it.
    const outer = join(base, "agents");
    await mkdir(outer);
    git(["init", "--quiet"], outer);
    expect(await cliInit(["init", "inner", "--no-install"], outer, env)).toContain(
      `git: inside the git repository ${outer}: it tracks the agent, so none was created`,
    );
    expect(await exists(join(outer, "inner", ".git"))).toBe(false);
    // …unless it IGNORES the directory (a home directory kept in git with `*` ignored): then nothing tracks the
    // agent, so it gets its own.
    await writeFile(join(outer, ".gitignore"), "*\n");
    expect(await cliInit(["init", "ignored", "--no-install"], outer, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    expect(git(["rev-parse", "--show-toplevel"], join(outer, "ignored"))).toBe(join(outer, "ignored"));

    // No identity to commit with: the repository stays, and the author is told to commit.
    const noIdentity = {
      ...hermeticGit,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    };
    expect(await cliInit(["init", "anon", "--no-install"], base, noIdentity)).toMatch(
      /git: created a git repository, but its first commit failed \(.+\): commit the scaffold yourself/,
    );
    expect(await exists(join(base, "anon", ".git"))).toBe(true);

    // No git at all: said, and the agent is created anyway.
    const out = await cliInit(["init", "plain", "--no-install"], base, { ...env, PATH: "/nonexistent" });
    expect(out).toContain("git: git is not installed: no repository was created");
    expect(await exists(join(base, "plain", "fastagent.config.ts"))).toBe(true);
  });

  it("the CLI takes the directory, says what it created, and leads the next steps with `cd`", async () => {
    const base = await freshDir();
    const out = await cliInit(["init", "my-agent", "--no-install"], base);
    expect(out).toMatch(/created .*my-agent/);
    expect(out).toMatch(/^ {4}cd my-agent$/m);
    expect(out).toMatch(/fastagent dev/);
    expect(await exists(join(base, "my-agent", "APPEND_SYSTEM.md"))).toBe(true);
    // The CLI's scaffold carries web access (it installs the package that loads); the API's does not by default.
    expect(await exists(join(base, "my-agent", "extensions", "web-access.ts"))).toBe(true);

    // No directory is a usage error: an agent is a directory of its own, so there is no default to guess.
    expect(await cliInit(["init", "--no-install"], await freshDir())).toMatch(/missing required argument/);
    // --agent-dir is gone with the nested layout it named.
    expect(await cliInit(["init", "x", "--agent-dir", "bot"], base)).toMatch(/unknown option/);
  });
});

describe("add: fastagent add <channel>", () => {
  // A fastagent-ready AGENT DIR, as `fastagent init` produces it: an ESM package declaring the dep.
  // `add` scaffolds INTO this; it never bootstraps it (that is init's job). The tests run the CLI
  // from the agent dir itself — a supported entry point that resolves to the same placement.
  async function readyAgent(): Promise<string> {
    const dir = join(await freshDir(), "fastagent");
    await mkdir(dir);
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } }, null, 2)}\n`,
    );
    return dir;
  }

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
    expect(out).toContain(join("fastagent", "channels", "telegram.ts")); // reported relative to where it ran
    expect(await exists(join(root, "channels", "telegram.ts"))).toBe(true); // in the agent dir…
    expect(await exists(join(root, "tools", "telegram-send.ts"))).toBe(true); // …with its companion tool
    expect(await exists(join(dir, "channels"))).toBe(false); // NOT where the command ran
    expect(await readFile(join(root, ".secrets", ".env.example"), "utf8")).toContain("TELEGRAM_BOT_TOKEN");
    expect(await readFile(join(root, ".secrets", ".env"), "utf8")).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);
  });

  it("scaffolds channels/telegram.ts into a ready agent, mutates nothing else, and keeps authored glue", async () => {
    const dir = await readyAgent();
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
    // It rides the channel's transport, which is what records a sent message into the chat's discussion.
    expect(sendTool).toContain("telegramTransport(ctx.cwd)");
    // next steps carry this channel's env vars (with hints)
    expect(out).toContain("TELEGRAM_BOT_TOKEN");
    expect(out).toContain("@BotFather");
    expect(out).toContain("--tunnel");
    // add does NOT bootstrap: package.json is untouched and no .npmrc is written.
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      type: "module",
      dependencies: { "@fastagent-sh/fastagent": "^0.4.0" },
    });
    expect(await exists(join(dir, ".npmrc"))).toBe(false);

    // env vars are injected into .secrets/.env.example so a copy-to-.env finds them; the generated
    // secret itself is materialized into .secrets/.env (self-gitignored by construction).
    const envExample = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    expect(envExample).toContain("telegram channel");
    expect(envExample).toContain("TELEGRAM_SECRET_TOKEN");
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);
    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");

    // Re-running add on an existing channel keeps the authored glue and rewrites the package-owned
    // companion tool — the upgrade path for an agent scaffolded by an earlier release.
    await writeFile(join(dir, "channels", "telegram.ts"), `${src}// edited\n`);
    await writeFile(join(dir, "tools", "telegram-send.ts"), "// 0.20.0\n");
    const out3 = await cliInit(["add", "telegram"], dir);
    expect(out3).toContain("channels/telegram.ts already exists — keeping it");
    expect(await readFile(join(dir, "channels", "telegram.ts"), "utf8")).toBe(`${src}// edited\n`);
    expect(await readFile(join(dir, "tools", "telegram-send.ts"), "utf8")).toBe(sendTool);
  });

  it("writes a generated channel secret to .secrets/.env (kind-neutral), keeping any value already there", async () => {
    const dir = await readyAgent();
    const out = await cliInit(["add", "telegram"], dir);

    expect(out).toContain("wrote TELEGRAM_SECRET_TOKEN to .secrets/.env");
    expect(out).toContain("set TELEGRAM_BOT_TOKEN in .secrets/.env");
    expect(out).not.toMatch(/set TELEGRAM_SECRET_TOKEN=/);
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile).toContain("# --- telegram channel ---");
    expect(envFile).toContain("# TELEGRAM_BOT_TOKEN=");
    expect(envFile).toMatch(/^TELEGRAM_SECRET_TOKEN=[0-9a-f]{48}$/m);

    // `add` says nothing about git — the .gitignore was the scaffold's job at init, once.
    expect(out).not.toMatch(/gitignore|committed/i);

    // An existing non-empty value is KEPT, and not reported as written.
    const kept = await readyAgent();
    await mkdir(join(kept, ".secrets"), { recursive: true });
    await writeFile(join(kept, ".secrets", ".env"), "TELEGRAM_SECRET_TOKEN=keep-me\n");
    const keptOut = await cliInit(["add", "telegram"], kept);
    expect(keptOut).not.toContain("wrote TELEGRAM_SECRET_TOKEN");
    const keptEnv = await readFile(join(kept, ".secrets", ".env"), "utf8");
    expect(keptEnv.match(/^TELEGRAM_SECRET_TOKEN=/gm)).toHaveLength(1);
    expect(keptEnv).toContain("TELEGRAM_SECRET_TOKEN=keep-me");
  });

  it("a .env copied from .env.example (marker present) gets the secret slotted UNDER the marker", async () => {
    const dir = await readyAgent();
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
    const dir = await readyAgent();
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

  it("--no-onboard upgrades an existing Feishu or Lark agent's tools without touching its app", async () => {
    for (const kind of ["feishu", "lark"]) {
      const dir = await readyAgent();
      expect(await cliInit(["add", kind, "--no-onboard"], dir)).not.toMatch(/Error|creating the Feishu app/);
      // An agent from an earlier release: its channel edited, and no thread tool yet.
      const channel = join(dir, "channels", `${kind}.ts`);
      const authored = `${await readFile(channel, "utf8")}// edited\n`;
      await writeFile(channel, authored);
      await rm(join(dir, "tools", `${kind}-threads.ts`));
      const out = await cliInit(["add", kind, "--no-onboard"], dir);
      expect(out).not.toMatch(/Error|creating the Feishu app/);
      expect(await readFile(channel, "utf8")).toBe(authored);
      expect(await readFile(join(dir, "tools", `${kind}-threads.ts`), "utf8")).toContain("defineTool(");
    }
  });

  it("--ingress is the FEISHU_INGRESS setting, written for dev and deployments alike; without it nothing is", async () => {
    const plain = await readyAgent();
    await cliInit(["add", "feishu", "--no-onboard"], plain);
    expect(await readFile(join(plain, ".secrets", ".env"), "utf8").catch(() => "")).not.toMatch(/^FEISHU_INGRESS=/m);

    const chosen = await readyAgent();
    const out = await cliInit(["add", "feishu", "--no-onboard", "--ingress", "webhook"], chosen);
    expect(out).not.toMatch(/Error/);
    expect(await readFile(join(chosen, ".secrets", ".env"), "utf8")).toMatch(/^FEISHU_INGRESS=webhook$/m);
  });

  it("rewrites the companion tool on every add — it is the package's, so a re-add upgrades it", async () => {
    const dir = await readyAgent();
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "telegram-send.ts"), "// from an older package\n");
    await cliInit(["add", "telegram"], dir);
    expect(await exists(join(dir, "channels", "telegram.ts"))).toBe(true);
    expect(await readFile(join(dir, "tools", "telegram-send.ts"), "utf8")).toContain("defineTool(");
  });

  it("refuses (writing nothing) when the agent dir is not channel-ready, with an actionable message", async () => {
    /** An agent dir carrying `pkg` as its package.json (undefined = none at all). */
    const agentWith = async (pkg?: object): Promise<string> => {
      const d = join(await freshDir(), "fastagent");
      await mkdir(d);
      await writeFile(join(d, "SYSTEM.md"), "You are terse.\n");
      await writeFile(join(d, "fastagent.config.ts"), "export default {};\n"); // THE marker
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
      const out = await cliInit(["add", "telegram"], dir);
      expect(out).toMatch(msg);
      expect(await exists(join(dir, "channels", "telegram.ts"))).toBe(false); // nothing scaffolded
    }
  });

  it("scaffolds through an IN-agent symlinked channels/, but rejects one that ESCAPES (no outside write)", async () => {
    // in-agent symlink (channels → ./real): followed, telegram.ts written inside the agent
    const dir = await readyAgent();
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "channels"));
    const out = await cliInit(["add", "telegram"], dir);
    expect(out).toMatch(/created/);
    expect(await exists(join(dir, "real", "telegram.ts"))).toBe(true); // written through the in-agent symlink

    // escaping symlink (channels → external dir): rejected, nothing written outside the agent
    const esc = await readyAgent();
    const ext = await freshDir();
    await mkdir(join(ext, "ch"));
    await symlink(join(ext, "ch"), join(esc, "channels"));
    const out2 = await cliInit(["add", "telegram"], esc);
    expect(out2).toMatch(/outside the agent dir/);
    expect(await exists(join(ext, "ch", "telegram.ts"))).toBe(false); // not written outside
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

  it("`add skill` routes into the agent it names (symmetric with `add <channel>`)", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "fa-src-"));
    await mkdir(join(srcRoot, "greeter"), { recursive: true });
    await writeFile(
      join(srcRoot, "greeter", "SKILL.md"),
      "---\nname: greeter\ndescription: Greet the user warmly and by name.\n---\nSay hello.\n",
    );
    const dir = await freshDir();
    await mkdir(join(dir, "fastagent"), { recursive: true });
    await writeFile(join(dir, "fastagent", "fastagent.config.ts"), "export default {};\n");

    const out = await cliInit(["add", "skill", join(srcRoot, "greeter"), "fastagent"], dir);
    expect(out).toMatch(/vendored skill "greeter"/);
    expect(await exists(join(dir, "fastagent", "skills", "greeter", "SKILL.md"))).toBe(true); // in the agent dir…
    expect(await exists(join(dir, "skills"))).toBe(false); // …NOT where the command ran
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
    await symlink(external, join(ws, "skills")); // skills → outside the agent
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
