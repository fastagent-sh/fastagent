/**
 * GitHub content against a local stand-in for GitHub (github-standin.ts): a checkout of the user's is used as it is,
 * and a repository with no checkout here is cloned, and brought up to date at each start while that loses nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneContent, resolveContent } from "../src/content/resolve.ts";
import { declarationFor } from "../src/content/source.ts";
import { githubRepoOf } from "../src/content/git.ts";
import { collect, createPiAgentFromDefinition, createPiAgentFromDir } from "../src/index.ts";
import { git, githubStandIn } from "./github-standin.ts";
import { log } from "../src/log.ts";
import { makeFaux, sentPrompt } from "./faux.ts";

afterEach(() => vi.unstubAllEnvs());

async function agent(): Promise<{ root: string; agentDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fa-ghctx-")));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  return { root, agentDir };
}

/** The one resolved github entry of `declaration`, narrowed. */
function resolveOne(agentDir: string, declaration: object) {
  const [entry] = resolveContent(agentDir, [declaration], "local");
  if (entry?.kind !== "github") throw new Error("not github content");
  return entry;
}

describe("github content: resolved, without touching the network or the disk", () => {
  it("uses the user's checkout as it is, and says when it is off the declared ref", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);

    expect(resolveOne(agentDir, { github: "acme/app", local: checkout })).toEqual({
      name: "app",
      readonly: false,
      location: checkout,
      notices: [],
      kind: "github",
      repo: "acme/app",
      clone: false,
    });
    // On another branch, at another commit: on the same commit it would hold what `main` declares.
    git(checkout, "checkout", "-q", "-b", "feat");
    writeFileSync(join(checkout, "feat.md"), "feat\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "feat");
    expect(resolveOne(agentDir, { github: "acme/app", local: checkout, ref: "main" }).notices).toEqual([
      "the checkout is on feat, declared main; it is left as it is",
    ]);
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
  });

  it("clones when there is no checkout of that repository here, and says why", async () => {
    const github = githubStandIn();
    github.repo("acme/other").commit({ "README.md": "other\n" });
    const { root, agentDir } = await agent();
    const elsewhere = join(root, "other");
    git(root, "clone", "-q", "https://github.com/acme/other.git", elsewhere);
    const clone = join(agentDir, ".contexts", "app");

    const bare = resolveOne(agentDir, { github: "acme/app" });
    expect(bare).toMatchObject({ location: clone, clone: true });
    expect(bare.notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(resolveOne(agentDir, { github: "acme/app", local: elsewhere }).notices[0]).toBe(
      `${elsewhere} is a checkout of https://github.com/acme/other.git, not of github acme/app, so github acme/app is cloned instead`,
    );
    expect(resolveOne(agentDir, { github: "acme/app", local: join(root, "gone") }).notices[0]).toMatch(
      /gone does not exist, so github acme\/app is cloned instead/,
    );
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
  });

  it("refuses, naming it, when git is not installed", async () => {
    const { root, agentDir } = await agent();
    await mkdir(join(root, "app"));
    vi.stubEnv("PATH", await mkdtemp(join(tmpdir(), "fa-nogit-")));
    expect(() => resolveContent(agentDir, [{ github: "acme/app", local: join(root, "app") }], "local")).toThrow(
      "git is not installed: github content needs it on this machine",
    );
  });
});

describe("github content: a clone is brought up to date in place, never over the agent's work", () => {
  it("fetches and fast-forwards; what git would have to overwrite keeps the clone as it is", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    app.commit({ "README.md": "one\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    const at = (path: string) => join(entry.location, path);
    const inode = statSync.bind(null);

    expect(await cloneContent(entry)).toEqual({ outcome: "cloned" });
    const ino = inode(entry.location).ino;
    expect(await cloneContent(entry)).toEqual({ outcome: "current" });
    app.commit({ "README.md": "two\n" });
    expect(await cloneContent(entry)).toEqual({ outcome: "updated" });
    expect(readFileSync(at("README.md"), "utf8")).toBe("two\n");
    // In place: the directory is the one the agent has been working in.
    expect(inode(entry.location).ino).toBe(ino);

    // A file of the agent's the update does not touch stays, and the update happens.
    writeFileSync(at("notes.md"), "the agent's\n");
    app.commit({ "CHANGELOG.md": "three\n" });
    expect(await cloneContent(entry)).toEqual({ outcome: "updated" });
    expect(readFileSync(at("notes.md"), "utf8")).toBe("the agent's\n");

    // One the update would overwrite: git refuses, and the clone is kept as it is.
    writeFileSync(at("README.md"), "edited by the agent\n");
    app.commit({ "README.md": "four\n" });
    expect(await cloneContent(entry)).toEqual({
      outcome: "kept",
      reason: expect.stringMatching(/^git would not update it: .*would be overwritten by merge/),
    });
    expect(readFileSync(at("README.md"), "utf8")).toBe("edited by the agent\n");
    git(entry.location, "checkout", "-q", "--", "README.md");
    expect(await cloneContent(entry)).toEqual({ outcome: "updated" });

    // A commit of the agent's the remote does not have: no fast-forward, kept.
    git(entry.location, "add", "notes.md");
    git(entry.location, "commit", "-q", "-m", "notes");
    app.commit({ "README.md": "five\n" });
    expect(await cloneContent(entry)).toEqual({
      outcome: "kept",
      reason: expect.stringMatching(/^git would not update it: .*fast-forward/),
    });
    expect(git(entry.location, "log", "-1", "--format=%s")).toBe("notes");

    // On a branch of its own: kept there, and said.
    git(entry.location, "switch", "-q", "-c", "fix");
    expect(await cloneContent(entry)).toEqual({
      outcome: "kept",
      reason: "it is on branch fix, declared the default branch, main",
    });
    expect(readdirSync(join(agentDir, ".contexts"))).toEqual(["app"]);
  });

  it("a clone pinned to a commit moves to the declared one, unless it holds commits nothing else does", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    const first = app.commit({ "v.txt": "1" });
    const second = app.commit({ "v.txt": "2" });
    const third = app.commit({ "v.txt": "3" });
    const { agentDir } = await agent();
    const pinned = (ref: string) => resolveOne(agentDir, { github: "acme/app", ref, name: "app" });

    expect(await cloneContent(pinned(first))).toEqual({ outcome: "cloned" });
    expect(await cloneContent(pinned(second))).toEqual({ outcome: "updated" });
    expect(git(pinned(second).location, "rev-parse", "HEAD")).toBe(second);
    writeFileSync(join(pinned(second).location, "w.txt"), "the agent's\n");
    git(pinned(second).location, "add", "-A");
    git(pinned(second).location, "commit", "-q", "-m", "detached work");
    expect(await cloneContent(pinned(third))).toEqual({
      outcome: "kept",
      reason: "it has commits no branch or tag holds",
    });
  });

  it("a declared ref the clone is not on keeps it, and says both", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    app.commit({ "README.md": "app\n" });
    app.branch("feat");
    app.commit({ "README.md": "feat\n" });
    const { agentDir } = await agent();
    await cloneContent(resolveOne(agentDir, { github: "acme/app", ref: "main" }));
    expect(await cloneContent(resolveOne(agentDir, { github: "acme/app", ref: "feat" }))).toEqual({
      outcome: "kept",
      reason: "it is on branch main, declared feat",
    });
  });

  it("a file the agent writes while another process updates the clone stays", async () => {
    // `invoke` started beside a running `dev`: nothing replaces the directory, so a write during the update lands in
    // the clone the agent works in, and git leaves a file it does not track alone.
    const github = githubStandIn();
    const app = github.repo("acme/app");
    app.commit({ "README.md": "one\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    await cloneContent(entry);
    app.commit({ "README.md": "two\n" });
    const updating = cloneContent(entry);
    writeFileSync(join(entry.location, "late.md"), "written mid-update\n");
    expect(await updating).toEqual({ outcome: "updated" });
    expect(readFileSync(join(entry.location, "late.md"), "utf8")).toBe("written mid-update\n");
    expect(readFileSync(join(entry.location, "README.md"), "utf8")).toBe("two\n");
  });

  it("a clone of another repository under the entry's name is refused, never removed", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const old = resolveOne(agentDir, { github: "acme/app", name: "work" });
    await cloneContent(old);
    await expect(cloneContent(resolveOne(agentDir, { github: "acme/other", name: "work" }))).rejects.toThrow(
      /content "work": .* is a clone of https:\/\/github\.com\/acme\/app\.git, not of github acme\/other: move it away/,
    );
    expect(readFileSync(join(old.location, "README.md"), "utf8")).toBe("app\n");
  });

  it("offline, or when the fetch fails, the clone there is kept and said to be", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    const first = app.commit({ "README.md": "one\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    const pinned = resolveOne(agentDir, { github: "acme/app", ref: first, name: "pinned" });
    await cloneContent(entry);
    await cloneContent(pinned);
    github.offline();

    expect(await cloneContent(entry)).toEqual({
      outcome: "kept",
      reason: expect.stringMatching(/^could not reach github acme\/app: /),
    });
    // A clone pinned to a commit and on it needs no remote.
    expect(await cloneContent(pinned)).toEqual({ outcome: "current" });
  });

  it("clones at the declared ref: a branch, a tag or a commit", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    const first = app.commit({ "v.txt": "1" });
    app.tag("v1");
    app.commit({ "v.txt": "2" });
    app.branch("feat");
    const feat = app.commit({ "v.txt": "feat" });
    const { agentDir } = await agent();
    for (const [ref, expected, name] of [
      ["feat", feat, "a"],
      ["v1", first, "b"],
      [first, first, "c"],
    ] as const) {
      const entry = resolveOne(agentDir, { github: "acme/app", ref, name });
      expect(await cloneContent(entry)).toEqual({ outcome: "cloned" });
      expect(git(entry.location, "rev-parse", "HEAD")).toBe(expected);
    }
  });

  it("two processes making the first clone together leave one whole clone", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    const outcomes = await Promise.all([cloneContent(entry), cloneContent(entry)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["cloned", "current"]);
    expect(git(entry.location, "status", "--porcelain")).toBe("");
    expect(readdirSync(join(agentDir, ".contexts"))).toEqual(["app"]);
  });

  it("a first clone that fails says why and leaves nothing behind", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app", ref: "no-such-branch" });
    await expect(cloneContent(entry)).rejects.toThrow(
      /content "app": could not clone github acme\/app at no-such-branch: .*no-such-branch.* git's own credentials/s,
    );
    expect(readdirSync(join(agentDir, ".contexts"))).toEqual([]);
  });

  it("a clone reaches GitHub with GITHUB_TOKEN when git has no credential of its own, without storing it", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    await cloneContent(entry);
    const fill = (token: string | undefined) =>
      execFileSync("git", ["credential", "fill"], {
        cwd: entry.location,
        input: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GITHUB_TOKEN: token ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    // What the agent's own `git push` there would be given: the token as it is now in the environment.
    expect(fill("ghp_one")).toContain("password=ghp_one");
    expect(fill("ghp_two")).toContain("password=ghp_two");
    expect(() => fill(undefined)).toThrow();
    // A clone whose config lost it (made before it existed, or edited) gets it back at the next start.
    git(entry.location, "config", "--unset", "credential.https://github.com.helper");
    expect(() => fill("ghp_one")).toThrow();
    await cloneContent(entry);
    expect(fill("ghp_one")).toContain("password=ghp_one");
    expect(readFileSync(join(entry.location, ".git", "config"), "utf8")).not.toContain("ghp_");
  });

  it("a ref that git would read as an option is refused before git runs", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app" });
    await expect(cloneContent({ ...entry, ref: "--upload-pack=touch pwned" })).rejects.toThrow(
      /would reach git as an option/,
    );
    expect(existsSync(entry.location)).toBe(false);
  });

  it("the user's checkout is never cloned over", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);
    await expect(cloneContent(resolveOne(agentDir, { github: "acme/app", local: checkout }))).rejects.toThrow(
      /is the checkout at .*, not a clone/,
    );
  });
});

describe("github content: what runs the agent clones, what reports on it does not", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cli = (args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("`info` reports a clone not made yet and creates nothing; the opener clones it", async () => {
    const github = githubStandIn();
    github.repo("acme/handbook").commit({ "AGENTS.md": "HANDBOOK: be brief.\n" });
    const { agentDir } = await agent();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  content: [{ github: "acme/handbook", readonly: true }],\n};\n`,
    );
    const info = await cli(["info", "--json"], agentDir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).content[0].notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(existsSync(join(agentDir, ".contexts"))).toBe(false);

    const opened = await createPiAgentFromDir(agentDir);
    expect(opened.content).toEqual([
      expect.objectContaining({ name: "handbook", location: join(agentDir, ".contexts", "handbook") }),
    ]);
    expect(opened.content[0]?.notices).toEqual([]);
    expect(opened.definition.contextFiles.map((file) => file.content)).toContain("HANDBOOK: be brief.\n");

    // Offline, the next start runs on that clone and says so.
    github.offline();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await createPiAgentFromDir(agentDir);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[fastagent\] content "handbook": the clone in .* is kept as it is, could not reach github acme\/handbook: /,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a deployed start clones a repository, whatever checkout its author named, and goes without a directory", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "AGENTS.md": "APP: ship it.\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  content: [{ github: "acme/app", local: ${JSON.stringify(checkout)} }, { local: "/Users/me/notes" }],\n};\n`,
    );
    // What marks a process as the deployed one (paths.ts isDeployedWorkspace).
    vi.stubEnv("FASTAGENT_RELEASE_FILE", join(agentDir, "fastagent.release.json"));
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const opened = await createPiAgentFromDir(agentDir);
    const said = info.mock.calls.map(([line]) => line);
    info.mockRestore();
    const clone = join(agentDir, ".contexts", "app");
    // The author's directory is not on the host: absent from what the agent is given, and said at start.
    expect(opened.content).toEqual([expect.objectContaining({ location: clone, clone: true, notices: [] })]);
    expect(said).toContain(
      `[fastagent] content "notes" is a directory of the author's machine (/Users/me/notes): not on this host, and the agent is not told of it`,
    );
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe("APP: ship it.\n");
  });

  it("the agent is told what it changes in a clone stays, and that a checkout is the user's", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    github.repo("acme/docs").commit({ "README.md": "docs\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "docs");
    git(root, "clone", "-q", "https://github.com/acme/docs.git", checkout);
    const content = resolveContent(
      agentDir,
      [
        { github: "acme/app", ref: "main" },
        { github: "acme/docs", local: checkout, readonly: true },
      ],
      "local",
    );
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent: running } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      content,
    });
    await collect(running.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain(
      `- app: ${join(agentDir, ".contexts", "app")} (a shallow clone of github acme/app (declared main) in your own storage: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change)`,
    );
    expect(prompt).toContain(`- docs: ${checkout} (a checkout of github acme/docs on this machine)`);
  });
});

describe("github content: what a command's <source> declares", () => {
  it("a remote names a GitHub repository in any of the spellings git takes", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://token@github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
    ]) {
      expect(githubRepoOf(url), url).toBe("acme/app");
    }
    for (const url of ["https://gitlab.com/acme/app.git", "git@github.example.com:acme/app.git", "/srv/app.git"]) {
      expect(githubRepoOf(url), url).toBeUndefined();
    }
  });

  it("a checkout's root is its repository; a directory in it is itself", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "src/index.ts": "x\n" });
    const { root } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);

    expect(declarationFor(checkout, root, { ref: "main" })).toEqual({
      declaration: { github: "acme/app", local: checkout, ref: "main" },
      notes: [],
    });
    // Never widened to the repository: an agent kept in that same checkout can still work on one directory of it.
    expect(declarationFor(join(checkout, "src"), root)).toEqual({
      declaration: { local: join(checkout, "src") },
      notes: [
        `${join(checkout, "src")} is in a checkout of github acme/app: declare github:acme/app for the whole repository`,
      ],
    });
    expect(declarationFor("github:acme/docs", root, { ref: "v1", local: "docs", readonly: true })).toEqual({
      declaration: { github: "acme/docs", local: join(root, "docs"), ref: "v1", readonly: true },
      notes: [],
    });
    expect(() => declarationFor(join(checkout, "src"), root, { ref: "main" })).toThrow(
      /--ref applies to a repository, and .* is declared as a directory/,
    );
    expect(() => declarationFor("github:https://github.com/acme/app", root)).toThrow(
      "github:https://github.com/acme/app names no repository: write github:owner/repo",
    );
    expect(() => declarationFor(checkout, root, { local: "x" })).toThrow(/--local applies to a github:owner\/repo/);
  });
});
