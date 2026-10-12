/**
 * Content (src/content/): what an author declares an agent works on or knows in `context.json`, what this machine binds
 * in `context.local.json`, what a command's `<source>` adds, and where each entry is for this instance. Each refusal is
 * tested once, here, where its rule lives; callers test only their wiring.
 */
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ContentDeclaration, declareBindings, declareCheckouts, declareContent } from "../src/content/declare.ts";
import {
  contextFileText,
  loadContent,
  loadEnvironment,
  parseContextFile,
  readContextFile,
} from "../src/content/file.ts";
import { readContentSource } from "../src/content/source.ts";
import {
  checkBinding,
  contentAbsentHere,
  resolveContent,
  staleCheckoutNotice,
  staleCheckouts,
} from "../src/content/resolve.ts";

describe("content: the declaration", () => {
  it("reads each repository by name", () => {
    expect(
      declareContent({
        handbook: { github: "acme/handbook", readonly: true, description: "The team's rules." },
        app: { github: "acme/app", ref: "main" },
      }),
    ).toEqual([
      { name: "handbook", repo: "acme/handbook", readonly: true, description: "The team's rules." },
      { name: "app", repo: "acme/app", ref: "main", readonly: false },
    ]);
    expect(declareContent(undefined)).toEqual([]);
  });

  it.each([
    ["not a map", [{ github: "a/b" }], /"content" must be an object of entries by name/],
    ["an entry that is not an object", { app: "a/b" }, /content "app" must be an object/],
    ["an unknown key", { app: { github: "a/b", readonnly: true } }, /content "app": unknown key "readonnly"/],
    // A machine's path is never declared in the shared file: context.local.json binds it on that machine.
    ["a path", { app: { github: "a/b", path: "/x" } }, /content "app": unknown key "path"/],
    [
      "an entry no instance but this one reaches",
      { notes: { readonly: true } },
      /content "notes" needs "github": context\.json is shared, .* bind a directory of this machine in context\.local\.json/,
    ],
    ["a repository not owner/repo", { app: { github: "acme" } }, /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", { app: { github: "a/b", ref: "--upload-pack=x" } }, /"ref" must name/],
    ["a non-boolean flag", { app: { github: "a/b", readonly: "yes" } }, /"readonly" must be a boolean/],
    ["an empty description", { app: { github: "a/b", description: "" } }, /"description" must be a non-empty/],
    ["a name that is not one path segment", { "my notes": { github: "a/b" } }, /a name is one path segment/],
    [
      "two names equal ignoring case",
      { App: { github: "a/b" }, app: { github: "a/c" } },
      /two content entries are named "App" and "app"/,
    ],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContent(raw)).toThrow(message);
  });
});

describe("content: this machine's bindings", () => {
  it("reads this machine's own checkouts, by name, from `checkouts`", () => {
    expect(declareCheckouts({ app: "/code/app", notes: "~/notes", drafts: "../drafts" }, "/agents/me")).toEqual([
      { name: "app", path: "/code/app", kind: "checkout" },
      { name: "notes", path: join(homedir(), "notes"), kind: "checkout" },
      { name: "drafts", path: "/agents/drafts", kind: "checkout" },
    ]);
    expect(declareCheckouts(undefined, "/agents/me")).toEqual([]);
  });

  it.each([
    [
      "a checkout that is not a directory",
      { app: { path: "/code/app" } },
      /checkouts "app": the directory must be a non-empty string/,
    ],
    ["an empty one", { app: "" }, /checkouts "app": the directory must be a non-empty string/],
    ["a name that is not one path segment", { "my app": "/x" }, /checkouts "my app": a name is one path segment/],
    ["two names equal ignoring case", { App: "/x", app: "/y" }, /two checkouts entries are named "App" and "app"/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareCheckouts(raw, "/agents/me")).toThrow(message);
  });

  it("reads a directory of this machine alone, with how the agent treats it", () => {
    expect(
      declareBindings(
        { notes: { path: "~/notes", readonly: true, description: "My notes." }, drafts: { path: "../drafts" } },
        "/agents/me",
      ),
    ).toEqual([
      { name: "notes", path: join(homedir(), "notes"), kind: "local", readonly: true, description: "My notes." },
      { name: "drafts", path: "/agents/drafts", kind: "local", readonly: false },
    ]);
  });

  it.each([
    ["a binding without a path", { notes: { readonly: true } }, /content "notes": "path" must be a non-empty string/],
    ["an unknown key", { notes: { path: "/x", github: "a/b" } }, /content "notes": unknown key "github"/],
    ["a non-boolean flag", { notes: { path: "/x", readonly: "yes" } }, /content "notes": "readonly" must be a boolean/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareBindings(raw, "/agents/me")).toThrow(message);
  });
});

describe("content: context.json and context.local.json", () => {
  it("is read whole, every refusal naming the file; an agent without one declares nothing", async () => {
    const path = "/a/context.json";
    const file = parseContextFile(`{ "$schema": "x", "content": { "app": { "github": "acme/app" } } }`, path);
    expect(file.declared).toEqual([{ name: "app", repo: "acme/app", readonly: false }]);
    expect(parseContextFile(contextFileText(file), path)).toEqual(file);
    expect(() => parseContextFile("{ content: {} }", path)).toThrow(/^\/a\/context\.json is not valid JSON/);
    expect(() => parseContextFile("[]", path)).toThrow("/a/context.json must hold a JSON object");
    expect(() => parseContextFile(`{ "contents": {} }`, path)).toThrow(
      '/a/context.json: unknown key "contents" (valid keys: $schema, contexts, content, environment)',
    );
    // What only a context's own context.json holds is refused with why.
    expect(() => parseContextFile(`{ "description": "x" }`, path)).toThrow(
      `/a/context.json: "description" says what a context is for, and this is an agent's`,
    );
    expect(() => parseContextFile(`{ "content": { "a": { "github": "a/b", "ref": "" } } }`, path)).toThrow(
      /^\/a\/context\.json: content "a": "ref" must be/,
    );
    expect(readContextFile(await mkdtemp(join(tmpdir(), "fa-context-file-")))).toEqual({
      contexts: {},
      declaredContexts: [],
      content: {},
      declared: [],
    });
  });

  it("a reader declares the part it uses, so a refused part stops only what uses it; the file itself stops both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-context-parts-"));
    const path = join(dir, "context.json");
    await writeFile(
      path,
      `{ "content": { "app": { "github": "acme/app" } }, "environment": { "packages": { "cargo:x": "1" } } }`,
    );
    expect(loadContent(dir)).toEqual({ declared: [{ name: "app", repo: "acme/app", readonly: false }], bound: [] });
    expect(() => loadEnvironment(dir)).toThrow(`${path}: environment: package "cargo:x" installs with cargo:`);
    // An edit writes the whole, so it reads the whole.
    expect(() => readContextFile(dir)).toThrow(`${path}: environment: package "cargo:x"`);
    await writeFile(path, `{ "content": { "a": {} }, "environment": { "packages": { "gh": "2" } } }`);
    expect(loadEnvironment(dir)).toEqual({ packages: { gh: "2" }, aptPackages: [], variables: {} });
    expect(() => loadContent(dir)).toThrow(`${path}: content "a" needs "github"`);
    await writeFile(path, `{ "contents": {} }`);
    for (const read of [loadContent, loadEnvironment])
      expect(() => read(dir)).toThrow(`${path}: unknown key "contents"`);
  });

  it("content is read from all three, and a refused binding names this machine's file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-context-local-"));
    await writeFile(join(dir, "context.json"), `{ "content": { "app": { "github": "acme/app" } } }`);
    const local = join(dir, "context.local.json");
    await writeFile(local, `{ "checkouts": { "app": "code/app" }, "content": { "notes": { "path": "notes" } } }`);
    expect(loadContent(dir)).toEqual({
      declared: [{ name: "app", repo: "acme/app", readonly: false }],
      bound: [
        { name: "app", path: join(dir, "code", "app"), kind: "checkout" },
        { name: "notes", path: join(dir, "notes"), kind: "local", readonly: false },
      ],
    });
    // The environment is the shared file's alone, and a checkout of one machine is not a shared declaration.
    await writeFile(local, `{ "environment": {} }`);
    expect(() => loadContent(dir)).toThrow(`${local}: unknown key "environment" (valid keys: checkouts, content)`);
    expect(loadEnvironment(dir)).toBeUndefined();
    await writeFile(join(dir, "context.json"), `{ "checkouts": { "app": "/code/app" } }`);
    expect(() => loadContent(dir)).toThrow(
      `${join(dir, "context.json")}: "checkouts" are the checkouts of one machine: bind them in context.local.json`,
    );
  });

  it("refuses one name in both maps of this machine's file: neither of them is the one meant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-context-both-"));
    const local = join(dir, "context.local.json");
    await writeFile(local, `{ "checkouts": { "app": "/code/app" }, "content": { "App": { "path": "/x" } } }`);
    expect(() => loadContent(dir)).toThrow(
      `${local}: content "App" is bound in both "checkouts" and "content": pick one`,
    );
  });
});

describe("content: what a command's <source> adds", () => {
  it("a directory is bound on this machine, named after it; github:owner/repo is declared, and cloned", () => {
    expect(readContentSource("notes", "/home/me")).toEqual({
      addition: { name: "notes", binding: { path: "/home/me/notes" } },
      notes: [],
    });
    expect(readContentSource("/x", "/", { readonly: true, name: "n", description: "Notes." }).addition).toEqual({
      name: "n",
      binding: { path: "/x", readonly: true, description: "Notes." },
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
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "content"), { recursive: true });
    await mkdir(join(root, "notes"));
    return { root, agentDir };
  }
  const local = (agentDir: string, bindings: Record<string, unknown>): ContentDeclaration => ({
    declared: [],
    bound: declareBindings(bindings, agentDir),
  });

  it("a directory this machine binds is where it is; one that is gone is left out, and said to be", async () => {
    const { root, agentDir } = await layout();
    const declaration = local(agentDir, {
      notes: { path: "../notes", readonly: true, description: "My notes." },
      gone: { path: join(root, "gone") },
    });
    expect(resolveContent(agentDir, declaration)).toEqual([
      {
        name: "notes",
        kind: "local",
        readonly: true,
        description: "My notes.",
        location: join(root, "notes"),
        notices: [],
      },
    ]);
    expect(contentAbsentHere(declaration)).toEqual([expect.objectContaining({ name: "gone" })]);
  });

  it("a repository is a clone fastagent makes at content/<name>, also where the checkout bound here is gone", async () => {
    const { root, agentDir } = await layout();
    const declared = declareContent({ app: { github: "acme/app" } });
    expect(resolveContent(agentDir, { declared, bound: [] })).toEqual([
      expect.objectContaining({
        kind: "github",
        clone: true,
        location: join(agentDir, "content", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
    const bound = declareCheckouts({ app: join(root, "gone") }, agentDir);
    expect(resolveContent(agentDir, { declared, bound })).toEqual([
      expect.objectContaining({
        clone: true,
        notices: [
          `bound in context.local.json to ${join(root, "gone")}, which does not exist here: the clone is used`,
          expect.stringMatching(/^not cloned yet/),
        ],
      }),
    ]);
    expect(contentAbsentHere({ declared, bound })).toEqual([]);
  });

  it("says a checkout nothing declares is one, and never reads it as local content", async () => {
    const { root, agentDir } = await layout();
    const bound = declareCheckouts({ notes: "../notes" }, agentDir);
    const declaration = { declared: [], bound };
    expect(resolveContent(agentDir, declaration)).toEqual([]);
    expect(staleCheckouts(declaration)).toEqual(bound);
    for (const one of bound) {
      expect(staleCheckoutNotice(one)).toBe(
        `notes: bound in context.local.json to ${join(root, "notes")} as this machine's checkout, which no ` +
          `content entry declares: the agent is not told of it (fastagent content remove notes)`,
      );
    }
  });

  it("refuses a directory of this machine under a declared entry's name: two things, one name", async () => {
    const { root, agentDir } = await layout();
    const declared = declareContent({ app: { github: "acme/app" } });
    const bound = declareBindings({ app: { path: join(root, "notes") } }, agentDir);
    expect(() => resolveContent(agentDir, { declared, bound })).toThrow(
      /content "app" is declared in context\.json and bound as a directory of this machine in context\.local\.json/,
    );
  });

  it("refuses a link where a clone belongs, a file in its place, and a binding to a file", async () => {
    const { root, agentDir } = await layout();
    await writeFile(join(root, "file"), "");
    await symlink(join(root, "notes"), join(agentDir, "content", "linked"));
    await writeFile(join(agentDir, "content", "plain"), "");
    const repository = (name: string) => () =>
      resolveContent(agentDir, { declared: declareContent({ [name]: { github: "a/b" } }), bound: [] });
    expect(repository("linked")).toThrow(
      `content "linked": content/linked is a link, and content/ holds only the clones fastagent makes`,
    );
    expect(repository("plain")).toThrow(`content "plain": ${join(agentDir, "content", "plain")} is not a directory`);
    expect(() => resolveContent(agentDir, local(agentDir, { file: { path: join(root, "file") } }))).toThrow(
      `content "file": ${join(root, "file")} is not a directory`,
    );
  });

  it("refuses a binding to a directory around the agent or inside it, asked of the real paths", async () => {
    const { root, agentDir } = await layout();
    // As written, `link` is beside the agent; really, it is the directory around it.
    await symlink(root, `${root}-link`);
    expect(() => resolveContent(agentDir, local(agentDir, { around: { path: `${root}-link` } }))).toThrow(
      /content "around" .* contains the agent directory/,
    );
    await mkdir(join(agentDir, "notes"));
    expect(() => resolveContent(agentDir, local(agentDir, { inside: { path: "notes" } }))).toThrow(
      /content "inside" .* is inside the agent directory/,
    );
  });

  it("asks it of an agent directory that does not exist yet, through a symlinked ancestor", async () => {
    // What `init <link>/agent --content <real>` checks before it creates anything: the agent will really be inside
    // the content, though neither path says so as written.
    const { root } = await layout();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    expect(() => checkBinding(join(root, "link", "agent", "deeper"), "real", join(root, "real"))).toThrow(
      /content "real" .* contains the agent directory/,
    );
  });
});
