/**
 * Creating an agent and editing its content as an API (what `init` and `content` wrap). The rules themselves (names,
 * nesting, what can be bound) are tested where they live and through the CLI; this file owns what only the API
 * promises: an agent it creates runs as created, an edit writes the shared declaration and this machine's binding
 * each where it belongs, and its refusals are thrown, a name problem as its own class.
 */
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitIdentity, withGitIdentity } from "./git-env.ts";
import { git, githubStandIn } from "./github-standin.ts";
import { ContentNameError, addContent, createAgent, listContent, removeContent } from "../src/authoring.ts";
import { type SourceOptions, readContentSource } from "../src/content/source.ts";

/** What `content add <dir>` adds. */
const directory = (dir: string, options: SourceOptions = {}) => readContentSource(dir, "/", options).addition;

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Create an agent and open it in a plain Node process. vitest aliases `@fastagent-sh/fastagent` to this checkout's
 * source, which would make every import resolve; a child process run from a temp directory resolves it the way an
 * app that never ran `npm install` there does: not at all.
 */
function createAndOpen(dir: string): Promise<string> {
  const script = `
    import { createAgent } from ${JSON.stringify(join(SRC, "authoring.ts"))};
    import { openServing } from ${JSON.stringify(join(SRC, "harnesses/pi-durable/serve.ts"))};
    await createAgent(${JSON.stringify(dir)});
    await openServing(${JSON.stringify(dir)}, { locking: "memory" }).then(
      async (opened) => {
        await opened.agent.close();
        console.log("opened");
      },
      (e) => console.log(e.message),
    );
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      env: withGitIdentity,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    // The script reports the open's outcome on stdout and exits 0; anything else failed before it got there.
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}:\n${err}`)),
    );
  });
}

describe("authoring API", () => {
  // createAgent commits the scaffold.
  beforeEach(() => {
    useGitIdentity(vi.stubEnv);
    return () => vi.unstubAllEnvs();
  });

  it("an agent createAgent makes opens without npm install", async () => {
    // Its configuration imports only a type, which Node strips: nothing of the package is loaded until code needs it.
    const base = await mkdtemp(join(tmpdir(), "fa-authoring-"));
    expect(await createAndOpen(join(base, "plain"))).toBe("opened");
  });

  it("install runs before the first commit; a rejected install removes the scaffold", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-install-")));
    // What an install writes (a lockfile) is in the first commit, so the history starts from what runs.
    const installed = join(base, "installed");
    await createAgent(installed, { install: async (dir) => writeFile(join(dir, "package-lock.json"), "{}\n") });
    const tracked = execFileSync("git", ["ls-files"], { cwd: installed, env: withGitIdentity, encoding: "utf8" });
    expect(tracked.split("\n")).toContain("package-lock.json");

    // A rejection is a failed create, like a content write that fails: nothing is left, its content included, and a
    // retry starts clean.
    const failed = join(base, "failed");
    await mkdir(join(base, "app"));
    await expect(
      createAgent(failed, {
        content: [directory(join(base, "app"))],
        install: async () => {
          throw new Error("registry unreachable");
        },
      }),
    ).rejects.toThrow("registry unreachable");
    expect(await readdir(failed).catch(() => [])).toEqual([]);
    await expect(createAgent(failed)).resolves.toMatchObject({ dir: failed });
  });

  it("creates with content, edits it, and throws a name refusal as ContentNameError", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-")));
    const [app, docs, other] = [join(base, "app"), join(base, "docs"), join(base, "elsewhere", "app")];
    for (const dir of [app, docs, other]) await mkdir(dir, { recursive: true });
    const agentDir = join(base, "agent");

    const created = await createAgent(agentDir, { content: [directory(app)] });
    expect(created.created).not.toContain(join("extensions", "web-access.ts"));
    // A created agent is a repository of its own, whatever created it: the CLI's tests cover the cases it is not.
    expect(created.repository).toBe("created a git repository, with the scaffold as its first commit");
    await access(join(agentDir, ".git"));
    // A directory of this machine is bound in this machine's file; the shared one is not written for it.
    expect(created.content.map((c) => [c.name, c.location])).toEqual([["app", app]]);
    const bindings = () => readFile(join(agentDir, "context.local.json"), "utf8");
    expect(await bindings()).toBe(`{\n  "content": {\n    "app": {\n      "path": "${app}"\n    }\n  }\n}\n`);
    await expect(access(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);

    const added = await addContent(agentDir, directory(docs, { readonly: true }));
    expect(added.name).toBe("docs");
    expect(added.content.map((c) => [c.name, c.readonly])).toEqual([
      ["app", false],
      ["docs", true],
    ]);
    await expect(addContent(agentDir, directory(other))).rejects.toThrow(ContentNameError);
    await expect(addContent(agentDir, directory(other, { name: "a b" }))).rejects.toThrow(ContentNameError);
    await expect(removeContent(agentDir, "nope")).rejects.toThrow(ContentNameError);
    // Not a name problem: a plain Error, as the CLI reports it. Nothing is written.
    const before = await bindings();
    const around: unknown = await addContent(agentDir, directory(base, { name: "around" })).catch((e: unknown) => e);
    expect(around).not.toBeInstanceOf(ContentNameError);
    expect((around as Error).message).toMatch(/contains the agent directory/);
    expect(await bindings()).toBe(before);

    // Concurrent edits apply one after the other: neither is lost, neither is refused.
    const [x, y] = [join(base, "x"), join(base, "y")];
    for (const dir of [x, y]) await mkdir(dir);
    await Promise.all([addContent(agentDir, directory(x)), addContent(agentDir, directory(y))]);
    expect((await listContent(agentDir)).content.map((c) => c.name).sort()).toEqual(["app", "docs", "x", "y"]);
    await Promise.all([removeContent(agentDir, "x"), removeContent(agentDir, "y")]);

    const removed = await removeContent(agentDir, "APP");
    expect(removed).toEqual({ name: "app", content: (await listContent(agentDir)).content, notes: [] });
    expect(removed.content.map((c) => c.name)).toEqual(["docs"]);
    await access(app);
  });

  it("a checkout is its repository, declared for every instance and bound here; removing it removes both", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-checkout-")));
    const checkout = join(base, "app");
    git(base, "clone", "-q", "https://github.com/acme/app.git", checkout);
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    const added = await addContent(agentDir, readContentSource(checkout, base, { readonly: true }).addition);
    expect(added.content).toEqual([
      expect.objectContaining({ name: "app", kind: "github", clone: false, location: checkout, readonly: true }),
    ]);
    expect(JSON.parse(await readFile(join(agentDir, "context.json"), "utf8"))).toEqual({
      content: { app: { github: "acme/app", readonly: true } },
    });
    expect(JSON.parse(await readFile(join(agentDir, "context.local.json"), "utf8"))).toEqual({
      content: { app: { path: checkout } },
    });
    await removeContent(agentDir, "app");
    for (const file of ["context.json", "context.local.json"]) {
      expect(JSON.parse(await readFile(join(agentDir, file), "utf8"))).toEqual({ content: {} });
    }
  });

  it("two edits of one name that write different files queue: one is added, the other refused", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-race-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    await mkdir(join(base, "notes"));
    const results = await Promise.allSettled([
      addContent(agentDir, readContentSource("github:me/notes", base).addition),
      addContent(agentDir, directory(join(base, "notes"))),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ContentNameError);
    expect((await listContent(agentDir)).content.map((entry) => entry.name)).toEqual(["notes"]);
  });

  it("says when git would commit this machine's bindings", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-ignored-")));
    const agentDir = join(base, "agent");
    for (const dir of ["a", "b"]) await mkdir(join(base, dir));
    await createAgent(agentDir);
    // init's .gitignore keeps it out; an agent made before it was there does not.
    expect((await addContent(agentDir, directory(join(base, "a")))).notes).toEqual([]);
    const ignore = join(agentDir, ".gitignore");
    await writeFile(ignore, (await readFile(ignore, "utf8")).replace("/context.local.json\n", ""));
    expect((await addContent(agentDir, directory(join(base, "b")))).notes).toEqual([
      "context.local.json holds directories of this machine and git does not ignore it: add it to .gitignore",
    ]);
  });

  it("a clone in content/ outlives its entry, and is said to; nothing is cloned over it", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-clone-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    const repository = readContentSource("github:acme/app", base).addition;
    await addContent(agentDir, repository);
    // What the first start makes there; the agent may have worked in it since.
    await mkdir(join(agentDir, "content", "app"), { recursive: true });
    await writeFile(join(agentDir, "content", "app", "work.md"), "unpushed\n");
    const removed = await removeContent(agentDir, "app");
    expect(removed.notes).toEqual([
      "content/app is left as it is: it may hold the agent's work — delete it once nothing in it is needed",
    ]);
    expect(await readFile(join(agentDir, "content", "app", "work.md"), "utf8")).toBe("unpushed\n");
    // Added again while it is there: refused, rather than cloned over.
    await expect(addContent(agentDir, repository)).rejects.toThrow(
      `content/app already exists in ${agentDir}: move it away first`,
    );
  });

  it("a directory bound here that is gone is left out; an entry that does not resolve refuses an edit until removed", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-broken-")));
    const agentDir = join(base, "agent");
    for (const dir of ["moved", "b", "c"]) await mkdir(join(base, dir));
    await createAgent(agentDir, { content: [directory(join(base, "moved")), directory(join(base, "c"))] });
    await rm(join(base, "moved"), { recursive: true });
    // Gone: this machine's own binding, so nothing is refused, and it is named as absent.
    await addContent(agentDir, directory(join(base, "b")));
    expect(await listContent(agentDir)).toEqual({
      content: [expect.objectContaining({ name: "c" }), expect.objectContaining({ name: "b" })],
      absent: [expect.objectContaining({ name: "moved", path: join(base, "moved") })],
    });
    // Something else in its place does not resolve: an edit is refused with that entry's reason, and nothing written.
    await writeFile(join(base, "moved"), "");
    const before = await readFile(join(agentDir, "context.local.json"), "utf8");
    await expect(removeContent(agentDir, "c")).rejects.toThrow(/content "moved": .* is not a directory/);
    expect(await readFile(join(agentDir, "context.local.json"), "utf8")).toBe(before);
    const mended = await removeContent(agentDir, "moved");
    expect(mended.content.map((c) => c.name)).toEqual(["c", "b"]);
  });

  it("a refused edit on an agent without context files leaves none", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-none-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    await expect(removeContent(agentDir, "app")).rejects.toThrow('no content named "app" (this agent has: none)');
    await expect(addContent(agentDir, directory(join(base, "missing")))).rejects.toThrow(/does not exist/);
    for (const file of ["context.json", "context.local.json"]) {
      await expect(access(join(agentDir, file))).rejects.toThrow(/ENOENT/);
    }
  });

  it("createAgent refuses a name problem as ContentNameError, before it writes anything", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-")));
    const [one, two, spaced] = [join(base, "a", "app"), join(base, "b", "App"), join(base, "my app")];
    for (const dir of [one, two, spaced]) await mkdir(dir, { recursive: true });
    const agentDir = join(base, "agent");
    const taken: unknown = await createAgent(agentDir, { content: [directory(one), directory(two)] }).catch((e) => e);
    expect(taken).toBeInstanceOf(ContentNameError);
    expect((taken as Error).message).toBe('this agent already has content named "app"');
    await expect(createAgent(agentDir, { content: [directory(spaced)] })).rejects.toBeInstanceOf(ContentNameError);
    await expect(access(agentDir)).rejects.toThrow(/ENOENT/);
    // Named apart, the same directories are fine.
    await createAgent(agentDir, { content: [directory(one), directory(two, { name: "app2" })] });
  });
});
