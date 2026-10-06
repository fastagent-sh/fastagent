/**
 * GitHub contexts against a local stand-in for GitHub (github-standin.ts): a checkout of the user's is used as it is,
 * and a repository with no checkout here is cloned afresh each time the agent starts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneContext, resolveContexts } from "../src/contexts/resolve.ts";
import { declarationFor } from "../src/contexts/source.ts";
import { githubRepoOf } from "../src/contexts/git.ts";
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

/** The one resolved github context of `declaration`, narrowed. */
function resolveOne(agentDir: string, declaration: object) {
  const [context] = resolveContexts(agentDir, [declaration], "local");
  if (context?.kind !== "github") throw new Error("not a github context");
  return context;
}

describe("github contexts: resolved, without touching the network or the disk", () => {
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
    const clone = join(agentDir, ".state", "contexts", "app");

    const bare = resolveOne(agentDir, { github: "acme/app" });
    expect(bare).toMatchObject({ location: clone, clone: true });
    expect(bare.notices).toEqual(["not cloned yet: it is cloned afresh each time the agent starts"]);
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
    expect(() => resolveContexts(agentDir, [{ github: "acme/app", local: join(root, "app") }], "local")).toThrow(
      "git is not installed: a github context needs it on this machine",
    );
  });
});

describe("github contexts: a clone is made afresh each time", () => {
  it("replaces the last clone whole: new commits arrive, and what was not pushed is gone", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    app.commit({ "README.md": "one\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });

    await cloneContext(context);
    expect(readFileSync(join(context.location, "README.md"), "utf8")).toBe("one\n");
    writeFileSync(join(context.location, "unpushed.md"), "the agent's\n");
    app.commit({ "README.md": "two\n" });
    await cloneContext(context);
    expect(readFileSync(join(context.location, "README.md"), "utf8")).toBe("two\n");
    expect(existsSync(join(context.location, "unpushed.md"))).toBe(false);
    // Nothing is left beside it: no half-built clone, no replaced one.
    expect(readdirSync(join(agentDir, ".state", "contexts")).filter((entry) => !entry.endsWith(".lock"))).toEqual([
      "app",
    ]);
  });

  it("keeps a clone identical to a fresh one; any change in it, or on the remote, means a new clone", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    app.commit({ "README.md": "one\n", ".gitignore": "build/\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });
    const inode = () => statSync(context.location).ino;

    expect(await cloneContext(context)).toEqual({ cloned: true });
    let before = inode();
    expect(await cloneContext(context)).toEqual({ cloned: false });
    expect(inode()).toBe(before);
    for (const change of [
      () => writeFileSync(join(context.location, "README.md"), "edited\n"),
      () => {
        mkdirSync(join(context.location, "build"));
        writeFileSync(join(context.location, "build", "out"), "ignored, still a change\n");
      },
      () => git(context.location, "checkout", "-q", "-b", "elsewhere"),
      () => app.commit({ "README.md": "two\n" }),
    ]) {
      before = inode();
      change();
      expect(await cloneContext(context)).toEqual({ cloned: true });
      expect(inode()).not.toBe(before);
      expect(git(context.location, "status", "--porcelain", "--ignored")).toBe("");
    }
    expect(readFileSync(join(context.location, "README.md"), "utf8")).toBe("two\n");
  });

  it("offline, an untouched clone is used and said to be; a changed one stops the start", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    const first = app.commit({ "README.md": "one\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });
    const pinned = resolveOne(agentDir, { github: "acme/app", ref: first, name: "pinned" });
    await cloneContext(context);
    await cloneContext(pinned);
    github.offline();

    const kept = await cloneContext(context);
    expect(kept.cloned).toBe(false);
    expect(kept.warning).toMatch(/^could not reach github acme\/app \(.+\); using the clone made at \d{4}-/);
    // A clone pinned to a commit needs no remote to know it is what a fresh one would be.
    expect(await cloneContext(pinned)).toEqual({ cloned: false });
    writeFileSync(join(context.location, "notes.md"), "the agent's\n");
    await expect(cloneContext(context)).rejects.toThrow(/context "app": could not clone github acme\/app/);
    expect(readFileSync(join(context.location, "notes.md"), "utf8")).toBe("the agent's\n");
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
    for (const [ref, expected] of [
      ["feat", feat],
      ["v1", first],
      [first, first],
    ] as const) {
      const context = resolveOne(agentDir, { github: "acme/app", ref, name: "app" });
      await cloneContext(context);
      expect(git(context.location, "rev-parse", "HEAD")).toBe(expected);
    }
  });

  it("two processes starting together leave one whole clone", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });
    await Promise.all([cloneContext(context), cloneContext(context)]);
    expect(git(context.location, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(context.location, "README.md"), "utf8")).toBe("app\n");
  });

  it("processes replacing one clone take turns: each swap is whole", async () => {
    // Two renames per swap; a process that runs between another's two finds the clone gone or taken. In one process
    // they cannot interleave, so two processes do it many times over.
    const parent = await realpath(await mkdtemp(join(tmpdir(), "fa-swap-")));
    const gitModule = new URL("../src/contexts/git.ts", import.meta.url).href;
    const script = `
      import { mkdirSync, rmSync } from "node:fs";
      import { join } from "node:path";
      const { replaceDirectory } = await import(${JSON.stringify(gitModule)});
      const parent = ${JSON.stringify(parent)};
      for (let i = 0; i < 150; i++) {
        const next = join(parent, ".clone.next-" + process.pid + "-" + i);
        const old = join(parent, ".clone.old-" + process.pid + "-" + i);
        mkdirSync(next);
        await replaceDirectory(next, join(parent, "clone"), old);
        rmSync(old, { recursive: true, force: true });
      }`;
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stderr }));
      });
    const results = await Promise.all([run(), run(), run()]);
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(parent, "clone"))).toBe(true);
  });

  it("a clone that fails says why and keeps the last one, leaving nothing half-built", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });
    await cloneContext(context);
    await expect(cloneContext({ ...context, ref: "no-such-branch" })).rejects.toThrow(
      /context "app": could not clone github acme\/app at no-such-branch: .*no-such-branch.* git's own credentials/s,
    );
    expect(readFileSync(join(context.location, "README.md"), "utf8")).toBe("app\n");
    expect(readdirSync(join(agentDir, ".state", "contexts")).filter((entry) => !entry.endsWith(".lock"))).toEqual([
      "app",
    ]);
  });

  it("a ref that git would read as an option is refused before git runs", async () => {
    githubStandIn().repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const context = resolveOne(agentDir, { github: "acme/app" });
    await expect(cloneContext({ ...context, ref: "--upload-pack=touch pwned" })).rejects.toThrow(
      /would reach git as an option/,
    );
    expect(existsSync(context.location)).toBe(false);
  });

  it("the user's checkout is never cloned over", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);
    await expect(cloneContext(resolveOne(agentDir, { github: "acme/app", local: checkout }))).rejects.toThrow(
      /is the checkout at .*, not a clone/,
    );
  });
});

describe("github contexts: what runs the agent clones, what reports on it does not", () => {
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
      `export default {\n  contexts: [{ github: "acme/handbook", readonly: true }],\n};\n`,
    );
    const info = await cli(["info", "--json"], agentDir);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).contexts[0].notices).toEqual([
      "not cloned yet: it is cloned afresh each time the agent starts",
    ]);
    expect(existsSync(join(agentDir, ".state", "contexts"))).toBe(false);

    const opened = await createPiAgentFromDir(agentDir);
    expect(opened.contexts).toEqual([
      expect.objectContaining({ name: "handbook", location: join(agentDir, ".state", "contexts", "handbook") }),
    ]);
    expect(opened.contexts[0]?.notices).toEqual([]);
    expect(opened.definition.contextFiles.map((file) => file.content)).toContain("HANDBOOK: be brief.\n");

    // Offline, the next start runs on that clone and says so.
    github.offline();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await createPiAgentFromDir(agentDir);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[fastagent\] context "handbook": could not reach github acme\/handbook \(/),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the agent is told a clone does not outlast a start, and a checkout is the user's", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    github.repo("acme/docs").commit({ "README.md": "docs\n" });
    const { root, agentDir } = await agent();
    const checkout = join(root, "docs");
    git(root, "clone", "-q", "https://github.com/acme/docs.git", checkout);
    const contexts = resolveContexts(
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
      contexts,
    });
    await collect(running.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain(
      `- app: ${join(agentDir, ".state", "contexts", "app")} (a shallow clone of github acme/app at main, made afresh each time you start: commit and push what should last)`,
    );
    expect(prompt).toContain(`- docs: ${checkout} (a checkout of github acme/docs on this machine)`);
  });
});

describe("github contexts: what a command's <source> declares", () => {
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

  it("a directory in a GitHub checkout is the whole repository, with the checkout as its local", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "src/index.ts": "x\n" });
    const { root } = await agent();
    const checkout = join(root, "app");
    git(root, "clone", "-q", "https://github.com/acme/app.git", checkout);

    expect(declarationFor(checkout, root)).toEqual({
      declaration: { github: "acme/app", local: checkout },
      notes: [],
    });
    expect(declarationFor(join(checkout, "src"), root, { copy: true, ref: "main" })).toEqual({
      declaration: { github: "acme/app", local: checkout, ref: "main" },
      notes: [
        `${join(checkout, "src")} is inside the checkout ${checkout}: the context is the whole repository, github acme/app`,
        "github acme/app is cloned on a host, so --copy does not apply",
      ],
    });
    expect(declarationFor("github:acme/docs", root, { ref: "v1", local: "docs", readonly: true })).toEqual({
      declaration: { github: "acme/docs", local: join(root, "docs"), ref: "v1", readonly: true },
      notes: [],
    });
    expect(() => declarationFor(root, root, { ref: "main" })).toThrow(/--ref applies to a github context/);
    expect(() => declarationFor(checkout, root, { local: "x" })).toThrow(/--local applies to a github:owner\/repo/);
  });
});
