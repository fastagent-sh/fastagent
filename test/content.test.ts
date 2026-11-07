/**
 * Content (src/content/): what the program declares an agent works on in `context.json`, what an instance's
 * configuration adds, what a command's `<source>` adds, and where each entry is for this instance. Each refusal is
 * tested once, here, where its rule lives; callers test only their wiring.
 */
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DeclaredContent, declareContent, joinContent } from "../src/content/declare.ts";
import {
  contextFileText,
  instanceContent,
  loadContent,
  loadEnvironment,
  parseContextFile,
  readContextFile,
} from "../src/content/file.ts";
import { readContentSource } from "../src/content/source.ts";
import { checkDirectory, resolveContent } from "../src/content/resolve.ts";

const PROGRAM = { origin: "program", file: "context.json" } as const;
const INSTANCE = { origin: "instance", file: "fastagent.json", base: "/agents/me" } as const;

describe("content: the program's declaration", () => {
  it("reads each repository by name", () => {
    expect(
      declareContent(
        {
          handbook: { github: "acme/handbook", description: "The team's rules." },
          app: { github: "acme/app", ref: "main" },
        },
        PROGRAM,
      ),
    ).toEqual([
      { name: "handbook", origin: "program", kind: "github", repo: "acme/handbook", description: "The team's rules." },
      { name: "app", origin: "program", kind: "github", repo: "acme/app", ref: "main" },
    ]);
    expect(declareContent(undefined, PROGRAM)).toEqual([]);
  });

  it.each([
    ["not a map", [{ github: "a/b" }], /"content" must be an object of entries by name/],
    ["an entry that is not an object", { app: "a/b" }, /content "app" must be an object/],
    ["an unknown key", { app: { github: "a/b", readonnly: true } }, /content "app": unknown key "readonnly"/],
    // Content the agent only reads was once a flag; it is not a thing the declaration says.
    ["a flag that is gone", { app: { github: "a/b", readonly: true } }, /content "app": unknown key "readonly"/],
    [
      "a directory, since the file is shared",
      { app: { path: "/x" } },
      /content "app": context\.json is shared, so it declares only the repositories every instance reaches/,
    ],
    ["an entry that says nothing of where", { notes: { description: "Notes." } }, /content "notes" needs "github"$/],
    ["a repository not owner/repo", { app: { github: "acme" } }, /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", { app: { github: "a/b", ref: "--upload-pack=x" } }, /"ref" must name/],
    ["an empty description", { app: { github: "a/b", description: "" } }, /"description" must be a non-empty/],
    ["a name that is not one path segment", { "my notes": { github: "a/b" } }, /a name is one path segment/],
    [
      "two names equal ignoring case",
      { App: { github: "a/b" }, app: { github: "a/c" } },
      /two content entries are named "App" and "app"/,
    ],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContent(raw, PROGRAM)).toThrow(message);
  });
});

describe("content: an instance's declaration", () => {
  it("reads repositories and directories, a directory's path resolved against the configuration's directory", () => {
    expect(
      declareContent(
        {
          app: { github: "acme/app", ref: "main" },
          data: { path: "/srv/data" },
          notes: { path: "~/notes", description: "My notes." },
          drafts: { path: "../drafts" },
        },
        INSTANCE,
      ),
    ).toEqual([
      { name: "app", origin: "instance", kind: "github", repo: "acme/app", ref: "main" },
      { name: "data", origin: "instance", kind: "local", path: "/srv/data" },
      { name: "notes", origin: "instance", kind: "local", path: join(homedir(), "notes"), description: "My notes." },
      { name: "drafts", origin: "instance", kind: "local", path: "/agents/drafts" },
    ]);
  });

  it.each([
    [
      "an entry that says nothing of where",
      { notes: { description: "Notes." } },
      /content "notes" needs "github" or "path"/,
    ],
    ["both a repository and a directory", { x: { github: "a/b", path: "/x" } }, /names both "github" and "path"/],
    ["a ref on a directory", { x: { path: "/x", ref: "main" } }, /"ref" applies to a repository/],
    ["an empty path", { x: { path: "" } }, /content "x": "path" must be a non-empty string/],
    ["an unknown key", { x: { path: "/x", mode: "ro" } }, /content "x": unknown key "mode"/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContent(raw, INSTANCE)).toThrow(message);
  });

  it("refuses a relative path where there is no file to anchor it", () => {
    expect(() => declareContent({ x: { path: "data" } }, { origin: "instance", file: "the config object" })).toThrow(
      /content "x": "path" must be absolute here, since the config object is not a file/,
    );
  });

  it("only adds: a name the program declares is refused, ignoring case, naming both", () => {
    const program = declareContent({ app: { github: "acme/app" } }, PROGRAM);
    const added = declareContent({ other: { path: "/x" } }, INSTANCE);
    expect(joinContent(program, added).map((entry) => entry.name)).toEqual(["app", "other"]);
    for (const name of ["app", "APP"]) {
      expect(() => joinContent(program, declareContent({ [name]: { path: "/x" } }, INSTANCE))).toThrow(
        /content "(app|APP)" is declared by the program \(context\.json names "app"\) and by the instance/,
      );
    }
  });
});

describe("content: context.json and the instance configuration", () => {
  it("is read whole, every refusal naming the file; an agent without one declares nothing", async () => {
    const path = "/a/context.json";
    const file = parseContextFile(`{ "$schema": "x", "content": { "app": { "github": "acme/app" } } }`, path);
    expect(file.declared).toEqual([{ name: "app", origin: "program", kind: "github", repo: "acme/app" }]);
    expect(parseContextFile(contextFileText(file), path)).toEqual(file);
    expect(() => parseContextFile("{ content: {} }", path)).toThrow(/^\/a\/context\.json is not valid JSON/);
    expect(() => parseContextFile("[]", path)).toThrow("/a/context.json must hold a JSON object");
    // Shared contexts are not built yet, so their key is refused like any other.
    expect(() => parseContextFile(`{ "contexts": {} }`, path)).toThrow(
      '/a/context.json: unknown key "contexts" (valid keys: $schema, content, environment, mcpServers)',
    );
    expect(() => parseContextFile(`{ "content": { "a": { "github": "a/b", "ref": "" } } }`, path)).toThrow(
      /^\/a\/context\.json: content "a": "ref" must be/,
    );
    expect(readContextFile(await mkdtemp(join(tmpdir(), "fa-context-file-")))).toEqual({ content: {}, declared: [] });
  });

  it("a reader declares the part it uses, so a refused part stops only what uses it; the file itself stops both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-context-parts-"));
    const path = join(dir, "context.json");
    await writeFile(
      path,
      `{ "content": { "app": { "github": "acme/app" } }, "environment": { "packages": { "cargo:x": "1" } } }`,
    );
    expect(loadContent(dir)).toEqual([{ name: "app", origin: "program", kind: "github", repo: "acme/app" }]);
    expect(() => loadEnvironment(dir)).toThrow(`${path}: environment: package "cargo:x" installs with cargo:`);
    // An edit writes the whole, so it reads the whole.
    expect(() => readContextFile(dir)).toThrow(`${path}: environment: package "cargo:x"`);
    await writeFile(path, `{ "content": { "a": {} }, "environment": { "packages": { "gh": "2" } } }`);
    expect(loadEnvironment(dir)).toEqual({ packages: { gh: "2" }, aptPackages: [], variables: {} });
    expect(() => loadContent(dir)).toThrow(`${path}: content "a" needs "github"`);
    await writeFile(path, `{ "contexts": {} }`);
    for (const read of [loadContent, loadEnvironment])
      expect(() => read(dir)).toThrow(`${path}: unknown key "contexts"`);
  });

  it("content is the program's and what the instance adds, a refusal naming the file it is in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-context-instance-"));
    await writeFile(join(dir, "context.json"), `{ "content": { "app": { "github": "acme/app" } } }`);
    const instance = {
      values: { content: { notes: { path: "notes" }, extra: { github: "acme/extra" } } },
      label: "/etc/me/fastagent.json",
      directory: "/etc/me",
    };
    expect(loadContent(dir, instance)).toEqual([
      { name: "app", origin: "program", kind: "github", repo: "acme/app" },
      { name: "notes", origin: "instance", kind: "local", path: "/etc/me/notes" },
      { name: "extra", origin: "instance", kind: "github", repo: "acme/extra" },
    ]);
    expect(() => instanceContent({ ...instance, values: { content: { x: {} } } })).toThrow(
      '/etc/me/fastagent.json: content "x" needs "github" or "path"',
    );
    expect(() => loadContent(dir, { ...instance, values: { content: { APP: { path: "/x" } } } })).toThrow(
      /content "APP" is declared by the program/,
    );
    // The environment is the program's alone.
    expect(instanceContent({ values: {}, label: "x" })).toEqual([]);
  });
});

describe("content: what a command's <source> adds", () => {
  it("a directory is used as it is, named after it; github:owner/repo is a repository, cloned", () => {
    expect(readContentSource("notes", "/home/me")).toEqual({
      addition: { name: "notes", entry: { path: "/home/me/notes" } },
      notes: [],
    });
    expect(readContentSource("/x", "/", { name: "n", description: "Notes." }).addition).toEqual({
      name: "n",
      entry: { path: "/x", description: "Notes." },
    });
    expect(readContentSource("github:acme/app", "/", { ref: "main" }).addition).toEqual({
      name: "app",
      entry: { github: "acme/app", ref: "main" },
    });
    expect(() => readContentSource("github:acme", "/")).toThrow(/names no repository/);
    expect(() => readContentSource("/x", "/", { ref: "main" })).toThrow(/--ref applies to a repository/);
  });
});

describe("content: resolved for this instance", () => {
  async function layout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fa-content-")));
    const dir = join(root, "agent");
    await mkdir(join(dir, "content"), { recursive: true });
    await mkdir(join(root, "notes"));
    return { root, dir, places: { dir, workdir: dir } };
  }
  const local = (base: string, entries: Record<string, unknown>): DeclaredContent[] =>
    declareContent(entries, { origin: "instance", file: "fastagent.json", base });

  it("a directory is where the configuration says; one that is gone is refused, naming it", async () => {
    const { root, dir, places } = await layout();
    expect(resolveContent(local(dir, { notes: { path: "../notes", description: "My notes." } }), places)).toEqual([
      { name: "notes", kind: "local", description: "My notes.", location: join(root, "notes"), notices: [] },
    ]);
    expect(() => resolveContent(local(dir, { gone: { path: join(root, "gone") } }), places)).toThrow(
      `content "gone": ${join(root, "gone")} does not exist`,
    );
  });

  it("a repository is a clone fastagent makes at content/<name> in the working directory", async () => {
    const { root, dir } = await layout();
    const declared = declareContent({ app: { github: "acme/app" } }, PROGRAM);
    const workdir = join(root, "instance");
    expect(resolveContent(declared, { dir, workdir })).toEqual([
      expect.objectContaining({
        kind: "github",
        location: join(workdir, "content", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
  });

  it("refuses a link where a clone belongs, a file in its place, and a directory that is a file", async () => {
    const { root, dir, places } = await layout();
    await writeFile(join(root, "file"), "");
    await symlink(join(root, "notes"), join(dir, "content", "linked"));
    await writeFile(join(dir, "content", "plain"), "");
    const repository = (name: string) => () =>
      resolveContent(declareContent({ [name]: { github: "a/b" } }, PROGRAM), places);
    expect(repository("linked")).toThrow(
      `content "linked": content/linked is a link, and content/ holds only the clones fastagent makes`,
    );
    expect(repository("plain")).toThrow(`content "plain": ${join(dir, "content", "plain")} is not a directory`);
    expect(() => resolveContent(local(dir, { file: { path: join(root, "file") } }), places)).toThrow(
      `content "file": ${join(root, "file")} is not a directory`,
    );
  });

  it("refuses a directory around the agent or inside it, asked of the real paths", async () => {
    const { root, dir, places } = await layout();
    // As written, `link` is beside the agent; really, it is the directory around it.
    await symlink(root, `${root}-link`);
    expect(() => resolveContent(local(dir, { around: { path: `${root}-link` } }), places)).toThrow(
      /content "around" .* contains the agent directory/,
    );
    await mkdir(join(dir, "notes"));
    expect(() => resolveContent(local(dir, { inside: { path: "notes" } }), places)).toThrow(
      /content "inside" .* is inside the agent directory/,
    );
  });

  it("asks it of the definition's directory only: the instance's working directory may hold content", async () => {
    const { root, dir } = await layout();
    const workdir = join(root, "instance");
    await mkdir(join(workdir, "data"), { recursive: true });
    const places = { dir, workdir };
    // The working directory is the instance's own writable place, which a definition's directory is not.
    expect(resolveContent(local(workdir, { data: { path: "data" } }), places)).toEqual([
      expect.objectContaining({ name: "data", location: join(workdir, "data") }),
    ]);
    expect(() => checkDirectory(places, "data", join(workdir, "data"))).not.toThrow();
    expect(() => checkDirectory(places, "root", root)).toThrow(/content "root" .* contains the agent directory/);
    expect(() => checkDirectory(places, "notes", join(root, "notes"))).not.toThrow();
  });

  it("asks it of an agent directory that does not exist yet, through a symlinked ancestor", async () => {
    // What `init <link>/agent --content <real>` checks before it creates anything: the agent will really be inside
    // the content, though neither path says so as written.
    const { root } = await layout();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    const dir = join(root, "link", "agent", "deeper");
    expect(() => checkDirectory({ dir }, "real", join(root, "real"))).toThrow(
      /content "real" .* contains the agent directory/,
    );
  });
});
