/**
 * Content (src/content/): what an author declares an agent works on or knows, where each one is for this instance,
 * and the literal list `fastagent content` edits. Each refusal is tested once, here, where its rule lives; callers test
 * only their wiring.
 */
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { declareContent } from "../src/content/declare.ts";
import { declarationFor } from "../src/content/source.ts";
import { contentAbsentHere, resolveContent } from "../src/content/resolve.ts";
import { rewriteContent } from "../src/content/config-text.ts";
import { writeContent } from "../src/harnesses/pi/config.ts";

const AGENT = "/home/me/agents/reviewer";

describe("content: the declaration", () => {
  it("reads each kind, settles names and makes paths absolute against the agent directory", () => {
    expect(
      declareContent(
        [
          { local: "/home/me/code/app" },
          { local: "../notes", readonly: true },
          { github: "acme/handbook", ref: "main", local: "/home/me/src/handbook", name: "rules" },
        ],
        AGENT,
      ),
    ).toEqual([
      { name: "app", readonly: false, kind: "local", path: "/home/me/code/app" },
      { name: "notes", readonly: true, kind: "local", path: "/home/me/agents/notes" },
      {
        name: "rules",
        readonly: false,
        kind: "github",
        repo: "acme/handbook",
        ref: "main",
        checkout: "/home/me/src/handbook",
      },
    ]);
    expect(declareContent(undefined, AGENT)).toEqual([]);
  });

  it.each([
    ["not a list", { local: "/x" }, /"content" must be an array/],
    ["no source", [{ name: "x" }], /content\[0\]: declare where it comes from/],
    ["an unknown key", [{ local: "/x", copyy: true }], /content\[0\]: unknown key "copyy"/],
    ["a subdirectory (later)", [{ github: "a/b", path: "docs" }], /"path" .* is not supported yet/],
    // Never released, so refused like any key a declaration does not have.
    ["a copy for a host", [{ local: "/x", copy: true }], /content\[0\]: unknown key "copy"/],
    ["ref on a directory", [{ local: "/x", ref: "main" }], /"ref" applies to github content/],
    ["a repository not owner/repo", [{ github: "acme" }], /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", [{ github: "a/b", ref: "--upload-pack=x" }], /"ref" must name a branch/],
    ["a non-boolean flag", [{ local: "/x", readonly: "yes" }], /"readonly" must be a boolean/],
    ["a name that is a path", [{ local: "/x", name: "a/b" }], /"name" must be one path segment/],
    ["a default name that is not one", [{ local: "/my notes" }], /default name "my notes" .* give it a "name"/],
    [
      "two names equal ignoring case",
      [{ local: "/a/App" }, { local: "/b/app" }],
      /two content entries are named "App" and "app"/,
    ],
    [
      "one that contains the agent",
      [{ local: "/home/me/agents" }],
      /content "agents" \(\/home\/me\/agents\) contains the agent directory/,
    ],
    ["the agent itself", [{ local: AGENT }], /contains the agent directory/],
    ["one inside the agent", [{ local: "./notes" }], /content "notes" .* is inside the agent directory/],
    ["a checkout inside the agent", [{ github: "a/b", local: "./b" }], /content "b" .* is inside the agent directory/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContent(raw, AGENT)).toThrow(message);
  });

  it("a command reads a directory as local content, absolute", () => {
    expect(declarationFor("app", "/home/me/code").declaration).toEqual({ local: "/home/me/code/app" });
    expect(declarationFor("/x", "/", { readonly: true, name: "n" }).declaration).toEqual({
      local: "/x",
      readonly: true,
      name: "n",
    });
  });
});

describe("content: resolved for this instance", () => {
  async function layout() {
    const root = await mkdtemp(join(tmpdir(), "fa-content-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, "app"));
    return { root, agentDir };
  }

  it("local content is its directory, on this machine", async () => {
    const { root, agentDir } = await layout();
    expect(resolveContent(agentDir, [{ local: "../app", readonly: true }], "local")).toEqual([
      { name: "app", kind: "local", readonly: true, location: join(root, "app"), notices: [] },
    ]);
  });

  it("refuses what is not there to work on; on a host a directory is absent, and said to be", async () => {
    const { root, agentDir } = await layout();
    await writeFile(join(root, "file"), "");
    expect(() => resolveContent(agentDir, [{ local: "../missing" }], "local")).toThrow(
      /content "missing": .*missing does not exist/,
    );
    expect(() => resolveContent(agentDir, [{ local: "../file" }], "local")).toThrow(/is not a directory/);
    // A directory of the author's machine is not on a host: not resolved, not refused, and named for whoever opens it.
    expect(resolveContent(agentDir, [{ local: "../missing" }, { github: "acme/app", name: "repo" }], "host")).toEqual([
      expect.objectContaining({ name: "repo", kind: "github" }),
    ]);
    expect(contentAbsentHere(agentDir, [{ local: "../missing" }, { github: "acme/app" }], "host")).toEqual([
      expect.objectContaining({ name: "missing", kind: "local" }),
    ]);
    expect(contentAbsentHere(agentDir, [{ local: "../app" }], "local")).toEqual([]);
    // A repository is cloned on a host, wherever the author's checkout is: no `local` of theirs is looked for there.
    expect(resolveContent(agentDir, [{ github: "acme/app", local: join(root, "app") }], "host")).toEqual([
      expect.objectContaining({
        kind: "github",
        clone: true,
        location: join(agentDir, ".contexts", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
    // FASTAGENT_CONTEXTS_DIR moves the clones (a deployment's `start` points it at its storage: deployment-start.test.ts).
    vi.stubEnv("FASTAGENT_CONTEXTS_DIR", join(root, "storage", ".contexts"));
    try {
      expect(resolveContent(agentDir, [{ github: "acme/app" }], "host")).toEqual([
        expect.objectContaining({ location: join(root, "storage", ".contexts", "app") }),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("asks the nesting question again of the real paths: a symlink cannot smuggle the agent in", async () => {
    // As written, `link` is beside the agent; really, it is the directory around it.
    const { root, agentDir } = await layout();
    const link = `${root}-link`;
    await symlink(root, link);
    expect(() => declareContent([{ local: link }], agentDir)).not.toThrow();
    expect(() => resolveContent(agentDir, [{ local: link }], "local")).toThrow(/contains the agent directory/);
  });

  it("asks it of an agent directory that does not exist yet, through a symlinked ancestor", async () => {
    // What `init <link>/agent --content <real>` checks before it creates anything: the agent will really be inside
    // the content, though neither path says so as written.
    const { root } = await layout();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    expect(() =>
      resolveContent(join(root, "link", "agent", "deeper"), [{ local: join(root, "real") }], "local"),
    ).toThrow(/content "real" .* contains the agent directory/);
  });
});

describe("content: the literal list in fastagent.config.ts", () => {
  const config = (body: string) =>
    `import type { FastagentConfig } from "x";\n\nexport default {\n${body}} satisfies FastagentConfig;\n`;

  it("replaces the literal list, keeping everything around it", () => {
    const src = config(`  // what it works on\n  content: [\n    { local: '/old' }, // mine\n  ],\n  model: "p/m",\n`);
    expect(rewriteContent(src, [{ local: "/a" }, { readonly: true, local: "/b", name: "b" }])).toBe(
      config(
        `  // what it works on\n  content: [\n    { local: "/a" },\n    { local: "/b", readonly: true, name: "b" },\n  ],\n  model: "p/m",\n`,
      ),
    );
    expect(rewriteContent(config(`  content: [{ local: "/a" }],\n`), [])).toBe(config(`  content: [],\n`));
  });

  it("adds the list at the top of `export default {` when there is none", () => {
    expect(rewriteContent(config(`  model: "p/m",\n`), [{ github: "acme/a", ref: "main" }])).toBe(
      config(`  content: [\n    { github: "acme/a", ref: "main" },\n  ],\n  model: "p/m",\n`),
    );
  });

  it.each([
    ["a variable", `  content: shared,\n`],
    ["a spread", `  content: [...shared, { local: "/a" }],\n`],
    ["a call", `  content: [here()],\n`],
    ["a reference inside an entry", `  content: [{ local: home }],\n`],
  ])("refuses a computed list (%s) rather than overwrite it with its value", (_what, body) => {
    expect(() => rewriteContent(config(body), [])).toThrow(/is computed, not a literal list — edit it by hand/);
  });

  it("refuses a file it cannot place the list in", () => {
    expect(() => rewriteContent(`export default defineConfig({ model: "p/m" });\n`, [])).toThrow(
      /no `export default \{` line/,
    );
    expect(() => rewriteContent(config(`  content: [],\n  content: [],\n`), [])).toThrow(/more than once/);
  });

  it("writes the config only after importing the candidate and finding what it meant", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-content-write-"));
    const agentDir = join(root, "agent");
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(agentDir);
    const path = join(agentDir, "fastagent.config.ts");
    await writeFile(path, `export default {\n  content: [],\n};\n`);
    await writeContent(agentDir, [{ local: join(root, "app"), readonly: true }]);
    expect(await readFile(path, "utf8")).toBe(
      `export default {\n  content: [\n    { local: ${JSON.stringify(join(root, "app"))}, readonly: true },\n  ],\n};\n`,
    );

    // The import is the check, not the text: a later spread that overrides the list makes the edit mean something
    // else, and nothing is written.
    const overridden = `const base = { content: [{ local: "/z" }] };\nexport default {\n  content: [],\n  ...base,\n};\n`;
    await writeFile(path, overridden);
    await expect(writeContent(agentDir, [])).rejects.toThrow(/would declare \[\{"local":"\/z"\}\], not \[\]/);
    expect(await readFile(path, "utf8")).toBe(overridden);

    // A refusal leaves the file as it was, and no candidate behind.
    const computed = `const mine = [];\nexport default {\n  content: mine,\n};\n`;
    await writeFile(path, computed);
    await expect(writeContent(agentDir, [])).rejects.toThrow(/is computed/);
    await expect(writeContent(agentDir, [{ local: join(root, "missing") }])).rejects.toThrow(/does not exist/);
    expect(await readFile(path, "utf8")).toBe(computed);
    expect(await readdir(agentDir)).toEqual(["fastagent.config.ts"]);
  });
});
