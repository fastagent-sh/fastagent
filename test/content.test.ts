/**
 * Content (src/content/): what an author declares an agent works on or knows in `context.json`, what a command's
 * `<source>` adds, and where each entry is for this instance (`content/<name>`). Each refusal is tested once, here,
 * where its rule lives; callers test only their wiring.
 */
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DeclaredContent, declareContent } from "../src/content/declare.ts";
import { contextFileText, parseContextFile, readContextFile } from "../src/content/file.ts";
import { readContentSource } from "../src/content/source.ts";
import { checkLinkTarget, contentAbsentHere, resolveContent } from "../src/content/resolve.ts";

describe("content: the declaration", () => {
  it("reads each kind by name", () => {
    expect(
      declareContent({
        notes: {},
        handbook: { readonly: true, description: "The team's rules." },
        rules: { github: "acme/handbook", ref: "main" },
      }),
    ).toEqual([
      { name: "notes", readonly: false, kind: "local" },
      { name: "handbook", readonly: true, description: "The team's rules.", kind: "local" },
      { name: "rules", readonly: false, kind: "github", repo: "acme/handbook", ref: "main" },
    ]);
    expect(declareContent(undefined)).toEqual([]);
  });

  it.each([
    ["not a map", [{ github: "a/b" }], /"content" must be an object of entries by name/],
    ["an entry that is not an object", { app: "a/b" }, /content "app" must be an object/],
    ["an unknown key", { app: { readonnly: true } }, /content "app": unknown key "readonnly"/],
    // A machine's path is never declared: content/<name> links to it on that machine.
    ["a path", { app: { local: "/x" } }, /content "app": unknown key "local"/],
    ["ref on a directory", { app: { ref: "main" } }, /"ref" applies to a github entry/],
    ["a repository not owner/repo", { app: { github: "acme" } }, /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", { app: { github: "a/b", ref: "--upload-pack=x" } }, /"ref" must name/],
    ["a non-boolean flag", { app: { readonly: "yes" } }, /"readonly" must be a boolean/],
    ["an empty description", { app: { description: "" } }, /"description" must be a non-empty string/],
    ["a name that is not one path segment", { "my notes": {} }, /content "my notes": a name is one path segment/],
    ["two names equal ignoring case", { App: {}, app: {} }, /two content entries are named "App" and "app"/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContent(raw)).toThrow(message);
  });
});

describe("content: context.json", () => {
  it("is read whole, every refusal naming the file; an agent without one declares nothing", async () => {
    const path = "/a/context.json";
    const file = parseContextFile(`{ "$schema": "x", "content": { "app": { "github": "acme/app" } } }`, path);
    expect(file.declared).toEqual([{ name: "app", readonly: false, kind: "github", repo: "acme/app" }]);
    expect(parseContextFile(contextFileText(file), path)).toEqual(file);
    expect(() => parseContextFile("{ content: {} }", path)).toThrow(/^\/a\/context\.json is not valid JSON/);
    expect(() => parseContextFile("[]", path)).toThrow("/a/context.json must hold a JSON object");
    // Shared contexts are not built yet, so their key is refused like any other.
    expect(() => parseContextFile(`{ "contexts": {} }`, path)).toThrow(
      '/a/context.json: unknown key "contexts" (valid keys: $schema, content)',
    );
    expect(() => parseContextFile(`{ "content": { "a": { "ref": "x" } } }`, path)).toThrow(
      /^\/a\/context\.json: content "a": "ref" applies/,
    );
    expect(readContextFile(await mkdtemp(join(tmpdir(), "fa-context-file-")))).toEqual({ content: {}, declared: [] });
  });
});

describe("content: what a command's <source> adds", () => {
  it("a directory is a local entry linked to it, named after it; github:owner/repo is a clone", () => {
    expect(readContentSource("app", "/home/me/code")).toEqual({
      addition: { name: "app", entry: {}, link: "/home/me/code/app" },
      notes: [],
    });
    expect(readContentSource("/x", "/", { readonly: true, name: "n", description: "Notes." }).addition).toEqual({
      name: "n",
      entry: { readonly: true, description: "Notes." },
      link: "/x",
    });
    expect(readContentSource("github:acme/app", "/", { ref: "main" }).addition).toEqual({
      name: "app",
      entry: { github: "acme/app", ref: "main" },
    });
    expect(() => readContentSource("github:acme", "/")).toThrow(/names no repository/);
    expect(() => readContentSource("/x", "/", { ref: "main" })).toThrow(/--ref applies to a repository/);
  });
});

describe("content: resolved for this instance, at content/<name>", () => {
  async function layout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fa-content-")));
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "content"), { recursive: true });
    await mkdir(join(root, "app"));
    return { root, agentDir };
  }

  it("a local entry is the directory content/<name> links to; with nothing there it is absent, and said to be", async () => {
    const { root, agentDir } = await layout();
    await symlink(join(root, "app"), join(agentDir, "content", "app"));
    const declared = declareContent({ app: { readonly: true, description: "The app." }, notes: {} });
    expect(resolveContent(agentDir, declared)).toEqual([
      {
        name: "app",
        kind: "local",
        readonly: true,
        description: "The app.",
        location: join(agentDir, "content", "app"),
        linkedTo: join(root, "app"),
        notices: [],
      },
    ]);
    // Not linked on this machine (a host, a teammate's laptop): not resolved, not refused, and named for whoever opens it.
    expect(contentAbsentHere(agentDir, declared)).toEqual([expect.objectContaining({ name: "notes" })]);
    // A directory this place put there itself is the entry.
    await mkdir(join(agentDir, "content", "notes"));
    expect(resolveContent(agentDir, declared).map((entry) => [entry.name, entry.linkedTo])).toEqual([
      ["app", join(root, "app")],
      ["notes", undefined],
    ]);
  });

  it("a github entry with nothing linked is a clone fastagent makes there", async () => {
    const { agentDir } = await layout();
    expect(resolveContent(agentDir, declareContent({ app: { github: "acme/app" } }))).toEqual([
      expect.objectContaining({
        kind: "github",
        clone: true,
        location: join(agentDir, "content", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
  });

  it("refuses a link to nothing, to a file, or a file in its place", async () => {
    const { root, agentDir } = await layout();
    await writeFile(join(root, "file"), "");
    await symlink(join(root, "missing"), join(agentDir, "content", "gone"));
    await symlink(join(root, "file"), join(agentDir, "content", "file"));
    await writeFile(join(agentDir, "content", "plain"), "");
    const one = (name: string) => () => resolveContent(agentDir, declareContent({ [name]: {} }));
    expect(one("gone")).toThrow(
      `content "gone": content/gone links to ${join(root, "missing")}, which does not exist — link it again`,
    );
    expect(one("file")).toThrow(
      `content "file": content/file links to ${join(root, "file")}, which is not a directory`,
    );
    expect(one("plain")).toThrow(`content "plain": ${join(agentDir, "content", "plain")} is not a directory`);
  });

  it("refuses a link to a directory around the agent or inside it, asked of the real paths", async () => {
    const { root, agentDir } = await layout();
    // As written, `link` is beside the agent; really, it is the directory around it.
    await symlink(root, `${root}-link`);
    await symlink(`${root}-link`, join(agentDir, "content", "around"));
    expect(() => resolveContent(agentDir, declareContent({ around: {} }))).toThrow(
      /content "around" .* contains the agent directory/,
    );
    await mkdir(join(agentDir, "notes"));
    await symlink(join(agentDir, "notes"), join(agentDir, "content", "inside"));
    expect(() => resolveContent(agentDir, declareContent({ inside: {} }))).toThrow(
      /content "inside" .* is inside the agent directory/,
    );
  });

  it("asks it of an agent directory that does not exist yet, through a symlinked ancestor", async () => {
    // What `init <link>/agent --content <real>` checks before it creates anything: the agent will really be inside
    // the content, though neither path says so as written.
    const { root } = await layout();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    const entry = declareContent({ real: {} })[0] as DeclaredContent;
    expect(() => checkLinkTarget(join(root, "link", "agent", "deeper"), entry, join(root, "real"))).toThrow(
      /content "real" .* contains the agent directory/,
    );
  });
});
