/**
 * GitHub content against a local stand-in for GitHub (github-standin.ts): a checkout of the user's is used as it is,
 * and a repository with no checkout here is cloned, and brought up to date at each start while that loses nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneContent, resolveContent } from "../src/content/resolve.ts";
import { readContentSource } from "../src/content/source.ts";
import { type ContentEntry, declareContent } from "../src/content/declare.ts";
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

/** The github entry `entry` declares, named after its repository or `name`, resolved and narrowed. */
function resolveOne(agentDir: string, { name, ...entry }: ContentEntry & { name?: string }) {
  const [resolved] = resolveContent(
    agentDir,
    declareContent({ [name ?? ((entry.github as string).split("/")[1] as string)]: entry }),
  );
  if (resolved?.kind !== "github") throw new Error("not github content");
  return resolved;
}

/** Link `content/<name>` of the agent in `agentDir` to `target`, as `content add` or the user would. */
function linkAt(agentDir: string, name: string, target: string): void {
  mkdirSync(join(agentDir, "content"), { recursive: true });
  symlinkSync(target, join(agentDir, "content", name));
}

describe("github content: resolved, without touching the network or the disk", () => {
  it("uses the user's checkout as it is, and says when it is off the declared ref", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);

    linkAt(agentDir, "app", checkout);
    expect(resolveOne(agentDir, { github: "acme/app" })).toEqual({
      name: "app",
      readonly: false,
      location: join(agentDir, "content", "app"),
      linkedTo: checkout,
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
    expect(resolveOne(agentDir, { github: "acme/app", ref: "main" }).notices).toEqual([
      "the checkout is on feat, declared main; it is left as it is",
    ]);
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
  });

  it("clones when nothing is linked here, and refuses a link to anything but a checkout of that repository", async () => {
    const github = githubStandIn();
    github.repo("acme/other").commit({ "README.md": "other\n" });
    const { root, agentDir } = await agent();
    const elsewhere = join(root, "other");
    git(root, "clone", "-q", "https://github.com/acme/other.git", elsewhere);

    const bare = resolveOne(agentDir, { github: "acme/app" });
    expect(bare).toMatchObject({ location: join(agentDir, "content", "app"), clone: true });
    expect(bare.notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    linkAt(agentDir, "app", elsewhere);
    expect(() => resolveOne(agentDir, { github: "acme/app" })).toThrow(
      `content "app": content/app links to ${elsewhere}, which is a checkout of https://github.com/acme/other.git, not of github acme/app`,
    );
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
  });

  it("refuses, naming it, when git is not installed", async () => {
    const { root, agentDir } = await agent();
    await mkdir(join(root, "app"));
    linkAt(agentDir, "app", join(root, "app"));
    vi.stubEnv("PATH", await mkdtemp(join(tmpdir(), "fa-nogit-")));
    expect(() => resolveOne(agentDir, { github: "acme/app" })).toThrow(
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
    expect(readdirSync(join(agentDir, "content"))).toEqual([".gitignore", "app"]);
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
    expect(readdirSync(join(agentDir, "content"))).toEqual([".gitignore", "app"]);
  });

  it("a first clone that fails says why and leaves nothing behind", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const entry = resolveOne(agentDir, { github: "acme/app", ref: "no-such-branch" });
    await expect(cloneContent(entry)).rejects.toThrow(
      /content "app": could not clone github acme\/app at no-such-branch: .*no-such-branch.* git's own credentials/s,
    );
    expect(readdirSync(join(agentDir, "content"))).toEqual([".gitignore"]);
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
    linkAt(agentDir, "app", checkout);
    await expect(cloneContent(resolveOne(agentDir, { github: "acme/app" }))).rejects.toThrow(
      /links to the checkout .*, not a clone/,
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
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await writeFile(
      join(agentDir, "context.json"),
      `{ "content": { "handbook": { "github": "acme/handbook", "readonly": true } } }`,
    );
    const info = await cli(["info", "--json"], agentDir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).content[0].notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(existsSync(join(agentDir, "content"))).toBe(false);

    const opened = await createPiAgentFromDir(agentDir);
    expect(opened.content).toEqual([
      expect.objectContaining({ name: "handbook", location: join(agentDir, "content", "handbook") }),
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

  it("where nothing is linked (a host), a repository is cloned and a directory is absent, and said to be", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "AGENTS.md": "APP: ship it.\n" });
    const { agentDir } = await agent();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await writeFile(join(agentDir, "context.json"), `{ "content": { "app": { "github": "acme/app" }, "notes": {} } }`);
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const opened = await createPiAgentFromDir(agentDir);
    const said = info.mock.calls.map(([line]) => line);
    info.mockRestore();
    const clone = join(agentDir, "content", "app");
    expect(opened.content).toEqual([expect.objectContaining({ location: clone, clone: true, notices: [] })]);
    expect(said).toContain(
      `[fastagent] content "notes" is a directory of the machines that link one, and none is linked at content/notes here: the agent is not told of it`,
    );
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe("APP: ship it.\n");
    // What fastagent puts in content/ stays out of the agent's own repository.
    expect(readFileSync(join(agentDir, "content", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("the agent is told what it changes in a clone stays, and that a checkout is the user's", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    github.repo("acme/docs").commit({ "README.md": "docs\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "docs");
    git(root, "clone", "-q", "https://github.com/acme/docs.git", checkout);
    linkAt(agentDir, "docs", checkout);
    const content = resolveContent(
      agentDir,
      declareContent({
        app: { github: "acme/app", ref: "main", description: "The product. Open pull requests against main." },
        docs: { github: "acme/docs", readonly: true },
      }),
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
      `- app: ${join(agentDir, "content", "app")} (a shallow clone of github acme/app (declared main) in your own storage: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change) The product. Open pull requests against main.`,
    );
    expect(prompt).toContain(
      `- docs: ${join(agentDir, "content", "docs")} (a checkout of github acme/docs on this machine)`,
    );
  });
});

describe("github content: what a command's <source> adds", () => {
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

    expect(readContentSource(checkout, root, { ref: "main" })).toEqual({
      addition: { name: "app", entry: { github: "acme/app", ref: "main" }, link: checkout },
      notes: [],
    });
    // Never widened to the repository: an agent kept in that same checkout can still work on one directory of it.
    expect(readContentSource(join(checkout, "src"), root)).toEqual({
      addition: { name: "src", entry: {}, link: join(checkout, "src") },
      notes: [
        `${join(checkout, "src")} is in a checkout of github acme/app: add github:acme/app for the whole repository`,
      ],
    });
    expect(() => readContentSource(join(checkout, "src"), root, { ref: "main" })).toThrow(
      /--ref applies to a repository, and .* is added as a directory/,
    );
    expect(() => readContentSource("github:https://github.com/acme/app", root)).toThrow(
      "github:https://github.com/acme/app names no repository: write github:owner/repo",
    );
  });
});
