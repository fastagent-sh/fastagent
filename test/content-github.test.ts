import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { runInProcess } from "./cli-run.ts";
/**
 * GitHub content against a local stand-in for GitHub (github-standin.ts): a repository is cloned into the instance's
 * working directory, and brought up to date at each start while that loses nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneContent, resolveContent } from "../src/content/resolve.ts";
import { readContentSource } from "../src/content/source.ts";
import { declareContent } from "../src/content/declare.ts";
import { githubRepoOf } from "../src/content/git.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  assembleAgent,
  buildDefinition,
  loadDevProject,
  loadSourceDefinition,
} from "../src/harnesses/pi-durable/open.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";

/** The agent in `dir` as a serve opens it, with no storage of its own: what its content resolves to. */
async function openedContent(dir: string, secrets: Record<string, string> = {}) {
  const { definition, instance } = await loadDevProject(dir);
  const opened = await openServing(definition, {
    secrets,
    env: {},
    ownEnv: process.env,
    storage: "memory",
    ...(instance === undefined ? {} : { config: instance }),
  });
  await opened.agent.close();
  return opened.content;
}
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
function resolveOne(agentDir: string, { name, ...entry }: { github: string; ref?: string; name?: string }) {
  const key = name ?? (entry.github.split("/")[1] as string);
  const declared = declareContent({ [key]: entry }, { origin: "program", file: "context.json" });
  const [resolved] = resolveContent(declared, { dir: agentDir, workdir: agentDir });
  if (resolved?.kind !== "github") throw new Error("not github content");
  return resolved;
}

describe("github content: resolved, without touching the network or the disk", () => {
  it("is a clone fastagent makes at content/<name> in the working directory", async () => {
    const { agentDir } = await agent();
    const bare = resolveOne(agentDir, { github: "acme/app" });
    expect(bare).toMatchObject({ location: join(agentDir, "content", "app"), kind: "github", repo: "acme/app" });
    expect(bare.notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
    expect(existsSync(join(agentDir, "content"))).toBe(false);
  });

  it("refuses, naming it, when git is not installed", async () => {
    const { root } = await agent();
    await mkdir(join(root, "app"));
    vi.stubEnv("PATH", await mkdtemp(join(tmpdir(), "fa-nogit-")));
    expect(() => readContentSource(join(root, "app"), root)).toThrow(
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
});

describe("github content: what runs the agent clones, what reports on it does not", () => {
  const cli = (args: string[], cwd: string) => runInProcess(args, cwd);

  it("`info` reports a clone not made yet and creates nothing; the opener clones it", async () => {
    const github = githubStandIn();
    github.repo("acme/handbook").commit({ "AGENTS.md": "HANDBOOK: be brief.\n" });
    const { agentDir } = await agent();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await writeFile(join(agentDir, "context.json"), `{ "content": { "handbook": { "github": "acme/handbook" } } }`);
    const info = await cli(["info", "--json"], agentDir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).content[0].notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(existsSync(join(agentDir, "content"))).toBe(false);

    const opened = await openedContent(agentDir);
    expect(opened).toEqual([
      expect.objectContaining({ name: "handbook", location: join(agentDir, "content", "handbook") }),
    ]);
    expect(opened[0]?.notices).toEqual([]);
    expect(readFileSync(join(agentDir, "content", "handbook", "AGENTS.md"), "utf8")).toBe("HANDBOOK: be brief.\n");

    // Offline, the next start runs on that clone and says so.
    github.offline();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await openedContent(agentDir);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[fastagent\] content "handbook": the clone in .* is kept as it is, could not reach github acme\/handbook: /,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the opener clones in the agent's own environment, where the git settings and token it is given are", async () => {
    const github = githubStandIn();
    github.repo("acme/site").commit({ "README.md": "site\n" });
    const { agentDir } = await agent();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await writeFile(join(agentDir, "context.json"), `{ "content": { "site": { "github": "acme/site" } } }`);
    // The way to GitHub is the agent's alone, and this process may reach nothing but files: a clone made in this
    // process's environment fails, and one made in the agent's succeeds.
    const mapping = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const own = Object.fromEntries(mapping.map((name) => [name, process.env[name] as string]));
    for (const name of mapping) vi.stubEnv(name, undefined);
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

    await openedContent(agentDir, own);
    expect(readFileSync(join(agentDir, "content", "site", "README.md"), "utf8")).toBe("site\n");
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("a repository is cloned; a directory the instance names that is gone refuses the open, naming it", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "AGENTS.md": "APP: ship it.\n" });
    const { root, agentDir } = await agent();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await writeFile(join(agentDir, "context.json"), `{ "content": { "app": { "github": "acme/app" } } }`);
    const gone = join(root, "notes");
    await writeFile(join(agentDir, "fastagent.json"), JSON.stringify({ content: { notes: { path: gone } } }));
    await expect(openedContent(agentDir)).rejects.toThrow(`content "notes": ${gone} does not exist`);
    await writeFile(join(agentDir, "fastagent.json"), "{}");
    const opened = await openedContent(agentDir);
    const clone = join(agentDir, "content", "app");
    expect(opened).toEqual([expect.objectContaining({ location: clone, kind: "github", notices: [] })]);
    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe("APP: ship it.\n");
    // What fastagent puts in content/ stays out of the agent's own repository.
    expect(readFileSync(join(agentDir, "content", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("the agent is told what it changes in a clone stays, and that a directory is the user's", async () => {
    const { root, agentDir } = await agent();
    const docs = join(root, "docs");
    await mkdir(docs);
    const content = resolveContent(
      [
        ...declareContent(
          { app: { github: "acme/app", ref: "main", description: "The product. Open pull requests against main." } },
          { origin: "program", file: "context.json" },
        ),
        ...declareContent({ docs: { path: docs } }, { origin: "instance", file: "fastagent.json", base: root }),
      ],
      { dir: agentDir, workdir: agentDir },
    );
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const definition = await loadSourceDefinition(agentDir);
    const running = await assembleAgent(definition, {
      storage: new MemoryStorage(),
      ownEnv: process.env,
      processEnv: {},
      code: { ...buildDefinition(definition, {}), providers: [faux.provider] },
      config: resolveConfig(definition),
      models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
      model: "faux/faux-1",
      content,
    });
    await running.messages.send({ sessionId: (await running.sessions.create()).id, content: "hi" }, { wait: 30 });
    await running.close();
    expect(prompt).toContain(
      `- app: ${join(agentDir, "content", "app")} (a shallow clone of github acme/app (declared main) in your own storage: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change) The product. Open pull requests against main.`,
    );
    expect(prompt).toContain(`- docs: ${docs} (a directory on this machine)`);
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

  it("a directory is itself, a checkout's root included, and a checkout is said", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "src/index.ts": "x\n" });
    const { root } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);

    expect(readContentSource(checkout, root)).toEqual({
      addition: { name: "app", entry: { path: checkout } },
      notes: [`${checkout} is in a checkout of github acme/app: add github:acme/app to have it cloned`],
    });
    expect(readContentSource(join(checkout, "src"), root)).toEqual({
      addition: { name: "src", entry: { path: join(checkout, "src") } },
      notes: [`${join(checkout, "src")} is in a checkout of github acme/app: add github:acme/app to have it cloned`],
    });
    expect(() => readContentSource(join(checkout, "src"), root, { ref: "main" })).toThrow(
      /--ref applies to a repository, and .* is a directory/,
    );
    expect(() => readContentSource("github:https://github.com/acme/app", root)).toThrow(
      "github:https://github.com/acme/app names no repository: write github:owner/repo",
    );
  });
});
