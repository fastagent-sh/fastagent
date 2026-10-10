/**
 * Creating an agent and editing its content as an API (what `init` and `content` wrap). The rules themselves (names,
 * nesting, what can be linked) are tested where they live and through the CLI; this file owns what only the API
 * promises: an agent it creates runs as created, an edit writes `context.json` and the link together or neither, and
 * its refusals are thrown, a name problem as its own class.
 */
import { execFileSync, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitIdentity, withGitIdentity } from "./git-env.ts";
import {
  ContentNameError,
  addContent,
  createAgent,
  listContent,
  removeContent,
} from "../src/harnesses/pi/authoring.ts";
import { type SourceOptions, readContentSource } from "../src/content/source.ts";

/** What `content add <dir>` adds. */
const directory = (dir: string, options: SourceOptions = {}) => readContentSource(dir, "/", options).addition;

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Create an agent and open it in a plain Node process. vitest aliases `@fastagent-sh/fastagent` to this checkout's
 * source, which would make every import resolve; a child process run from a temp directory resolves it the way an
 * app that never ran `npm install` there does: not at all.
 */
function createAndOpen(dir: string, webAccess: boolean): Promise<string> {
  const script = `
    import { createAgent } from ${JSON.stringify(join(SRC, "harnesses/pi/authoring.ts"))};
    import { createPiAgentFromDir } from ${JSON.stringify(join(SRC, "index.ts"))};
    await createAgent(${JSON.stringify(dir)}, { webAccess: ${webAccess} });
    await createPiAgentFromDir(${JSON.stringify(dir)}).then(() => console.log("opened"), (e) => console.log(e.message));
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

  it("an agent createAgent makes opens without npm install, web access or not", async () => {
    // An extension loads when a session starts, so an uninstalled @fastagent-sh/pi-web-access costs the web tools on the first
    // turn (warned, left out: extensions' own tests), never the open.
    const base = await mkdtemp(join(tmpdir(), "fa-authoring-"));
    expect(await createAndOpen(join(base, "plain"), false)).toBe("opened");
    expect(await createAndOpen(join(base, "web"), true)).toBe("opened");
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
    expect(created.content.map((c) => [c.name, c.linkedTo])).toEqual([["app", app]]);
    expect(await readFile(join(agentDir, "context.json"), "utf8")).toBe(`{\n  "content": {\n    "app": {}\n  }\n}\n`);

    const added = await addContent(agentDir, directory(docs, { readonly: true }));
    expect(added.name).toBe("docs");
    expect(added.content.map((c) => [c.name, c.readonly])).toEqual([
      ["app", false],
      ["docs", true],
    ]);
    await expect(addContent(agentDir, directory(other))).rejects.toThrow(ContentNameError);
    await expect(addContent(agentDir, directory(other, { name: "a b" }))).rejects.toThrow(ContentNameError);
    await expect(removeContent(agentDir, "nope")).rejects.toThrow(ContentNameError);
    // Not a name problem: a plain Error, as the CLI reports it. Nothing is written or linked.
    const before = await readFile(join(agentDir, "context.json"), "utf8");
    const around: unknown = await addContent(agentDir, directory(base, { name: "around" })).catch((e: unknown) => e);
    expect(around).not.toBeInstanceOf(ContentNameError);
    expect((around as Error).message).toMatch(/contains the agent directory/);
    await expect(lstat(join(agentDir, "content", "around"))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(agentDir, "context.json"), "utf8")).toBe(before);

    // Concurrent edits apply one after the other: neither is lost, neither is refused.
    const [x, y] = [join(base, "x"), join(base, "y")];
    for (const dir of [x, y]) await mkdir(dir);
    await Promise.all([addContent(agentDir, directory(x)), addContent(agentDir, directory(y))]);
    expect((await listContent(agentDir)).map((c) => c.name).sort()).toEqual(["app", "docs", "x", "y"]);
    await Promise.all([removeContent(agentDir, "x"), removeContent(agentDir, "y")]);

    const removed = await removeContent(agentDir, "APP");
    expect(removed).toEqual({ name: "app", content: await listContent(agentDir), notes: [] });
    expect(removed.content.map((c) => c.name)).toEqual(["docs"]);
    await expect(lstat(join(agentDir, "content", "app"))).rejects.toThrow(/ENOENT/);
    await access(app);
  });

  it("a clone in content/ outlives its entry, and is said to; nothing there is added over", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-clone-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    await addContent(agentDir, readContentSource("github:acme/app", base).addition);
    // What the first start makes there; the agent may have worked in it since.
    await mkdir(join(agentDir, "content", "app"), { recursive: true });
    await writeFile(join(agentDir, "content", "app", "work.md"), "unpushed\n");
    const removed = await removeContent(agentDir, "app");
    expect(removed.notes).toEqual([
      "content/app is left as it is: it may hold the agent's work — delete it once nothing in it is needed",
    ]);
    expect(await readFile(join(agentDir, "content", "app", "work.md"), "utf8")).toBe("unpushed\n");
    // Added again while it is there: refused, rather than linked or cloned over.
    await mkdir(join(base, "app"));
    await expect(addContent(agentDir, directory(join(base, "app")))).rejects.toThrow(
      `content/app already exists in ${agentDir}: move it away first`,
    );
  });

  it("an entry that no longer resolves refuses an edit before it is made; removing that entry mends it", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-broken-")));
    const agentDir = join(base, "agent");
    for (const dir of ["moved", "b", "c"]) await mkdir(join(base, dir));
    await createAgent(agentDir, { content: [directory(join(base, "moved")), directory(join(base, "c"))] });
    await rm(join(base, "moved"), { recursive: true });
    const before = await readFile(join(agentDir, "context.json"), "utf8");
    // The refusal is the broken entry's, and nothing of the edit is left: not the entry, not its link.
    await expect(addContent(agentDir, directory(join(base, "b")))).rejects.toThrow(
      /content "moved": .* does not exist/,
    );
    await expect(lstat(join(agentDir, "content", "b"))).rejects.toThrow(/ENOENT/);
    await expect(removeContent(agentDir, "c")).rejects.toThrow(/content "moved": .* does not exist/);
    expect(await readFile(join(agentDir, "context.json"), "utf8")).toBe(before);
    expect(await realpath(join(agentDir, "content", "c"))).toBe(join(base, "c"));
    const mended = await removeContent(agentDir, "moved");
    expect(mended.content.map((c) => c.name)).toEqual(["c"]);
  });

  it("a link goes with a declaration that could not be written", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-unwritten-")));
    const agentDir = join(base, "agent");
    await mkdir(join(base, "app"));
    await createAgent(agentDir);
    // The temp the write renames into place is taken by a directory, so the write fails after the link was made.
    await mkdir(join(agentDir, "context.json.tmp"));
    await expect(addContent(agentDir, directory(join(base, "app")))).rejects.toThrow(/context\.json\.tmp/);
    await expect(lstat(join(agentDir, "content", "app"))).rejects.toThrow(/ENOENT/);
  });

  it("a refused edit on an agent without context.json leaves none", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-none-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    await expect(removeContent(agentDir, "app")).rejects.toThrow('no content named "app" (this agent has: none)');
    await expect(addContent(agentDir, directory(join(base, "missing")))).rejects.toThrow(/does not exist/);
    await expect(access(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);
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
