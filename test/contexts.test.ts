/**
 * Contexts (src/contexts/): what an author declares an agent works on or knows, where each one is for this instance,
 * and the literal list `fastagent context` edits. Each refusal is tested once, here, where its rule lives; callers test
 * only their wiring.
 */
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { declareContexts } from "../src/contexts/declare.ts";
import { declarationFor } from "../src/contexts/source.ts";
import { contextsAbsentHere, resolveContexts } from "../src/contexts/resolve.ts";
import { rewriteContexts } from "../src/contexts/config-text.ts";
import { writeContexts } from "../src/engines/pi/config.ts";

const AGENT = "/home/me/agents/reviewer";

describe("contexts: the declaration", () => {
  it("reads each kind, settles names and makes paths absolute against the agent directory", () => {
    expect(
      declareContexts(
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
    expect(declareContexts(undefined, AGENT)).toEqual([]);
  });

  it.each([
    ["not a list", { local: "/x" }, /"contexts" must be an array/],
    ["no source", [{ name: "x" }], /contexts\[0\]: declare where it comes from/],
    ["an unknown key", [{ local: "/x", copyy: true }], /contexts\[0\]: unknown key "copyy"/],
    ["a subdirectory (later)", [{ github: "a/b", path: "docs" }], /"path" .* is not supported yet/],
    // Never released, so refused like any key a declaration does not have.
    ["a copy for a host", [{ local: "/x", copy: true }], /contexts\[0\]: unknown key "copy"/],
    ["ref on a directory", [{ local: "/x", ref: "main" }], /"ref" applies to a github context/],
    ["a repository not owner/repo", [{ github: "acme" }], /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", [{ github: "a/b", ref: "--upload-pack=x" }], /"ref" must name a branch/],
    ["a non-boolean flag", [{ local: "/x", readonly: "yes" }], /"readonly" must be a boolean/],
    ["a name that is a path", [{ local: "/x", name: "a/b" }], /"name" must be one path segment/],
    ["a default name that is not one", [{ local: "/my notes" }], /default name "my notes" .* give it a "name"/],
    [
      "two names equal ignoring case",
      [{ local: "/a/App" }, { local: "/b/app" }],
      /two contexts are named "App" and "app"/,
    ],
    [
      "one that contains the agent",
      [{ local: "/home/me/agents" }],
      /context "agents" \(\/home\/me\/agents\) contains the agent directory/,
    ],
    ["the agent itself", [{ local: AGENT }], /contains the agent directory/],
    ["one inside the agent", [{ local: "./notes" }], /context "notes" .* is inside the agent directory/],
    ["a checkout inside the agent", [{ github: "a/b", local: "./b" }], /context "b" .* is inside the agent directory/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContexts(raw, AGENT)).toThrow(message);
  });

  it("a command reads a directory as a local context, absolute", () => {
    expect(declarationFor("app", "/home/me/code").declaration).toEqual({ local: "/home/me/code/app" });
    expect(declarationFor("/x", "/", { readonly: true, name: "n" }).declaration).toEqual({
      local: "/x",
      readonly: true,
      name: "n",
    });
  });
});

describe("contexts: resolved for this instance", () => {
  async function layout() {
    const root = await mkdtemp(join(tmpdir(), "fa-contexts-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, "app"));
    return { root, agentDir };
  }

  it("a local context is its directory, on this machine", async () => {
    const { root, agentDir } = await layout();
    expect(resolveContexts(agentDir, [{ local: "../app", readonly: true }], "local")).toEqual([
      { name: "app", kind: "local", readonly: true, location: join(root, "app"), notices: [] },
    ]);
  });

  it("refuses what is not there to work on; on a host a directory is absent, and said to be", async () => {
    const { root, agentDir } = await layout();
    await writeFile(join(root, "file"), "");
    expect(() => resolveContexts(agentDir, [{ local: "../missing" }], "local")).toThrow(
      /context "missing": .*missing does not exist/,
    );
    expect(() => resolveContexts(agentDir, [{ local: "../file" }], "local")).toThrow(/is not a directory/);
    // A directory of the author's machine is not on a host: not resolved, not refused, and named for whoever opens it.
    expect(resolveContexts(agentDir, [{ local: "../missing" }, { github: "acme/app", name: "repo" }], "host")).toEqual([
      expect.objectContaining({ name: "repo", kind: "github" }),
    ]);
    expect(contextsAbsentHere(agentDir, [{ local: "../missing" }, { github: "acme/app" }], "host")).toEqual([
      expect.objectContaining({ name: "missing", kind: "local" }),
    ]);
    expect(contextsAbsentHere(agentDir, [{ local: "../app" }], "local")).toEqual([]);
    // A repository is cloned on a host, wherever the author's checkout is: no `local` of theirs is looked for there.
    expect(resolveContexts(agentDir, [{ github: "acme/app", local: join(root, "app") }], "host")).toEqual([
      expect.objectContaining({
        kind: "github",
        clone: true,
        location: join(agentDir, ".contexts", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
    // A deployment puts the clones on its storage (`start` sets FASTAGENT_CONTEXTS_DIR there), as it does the state.
    vi.stubEnv("FASTAGENT_CONTEXTS_DIR", join(root, "storage", ".contexts"));
    try {
      expect(resolveContexts(agentDir, [{ github: "acme/app" }], "host")).toEqual([
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
    expect(() => declareContexts([{ local: link }], agentDir)).not.toThrow();
    expect(() => resolveContexts(agentDir, [{ local: link }], "local")).toThrow(/contains the agent directory/);
  });

  it("asks it of an agent directory that does not exist yet, through a symlinked ancestor", async () => {
    // What `init <link>/agent --context <real>` checks before it creates anything: the agent will really be inside
    // the context, though neither path says so as written.
    const { root } = await layout();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    expect(() =>
      resolveContexts(join(root, "link", "agent", "deeper"), [{ local: join(root, "real") }], "local"),
    ).toThrow(/context "real" .* contains the agent directory/);
  });
});

describe("contexts: the literal list in fastagent.config.ts", () => {
  const config = (body: string) =>
    `import type { FastagentConfig } from "x";\n\nexport default {\n${body}} satisfies FastagentConfig;\n`;

  it("replaces the literal list, keeping everything around it", () => {
    const src = config(`  // what it works on\n  contexts: [\n    { local: '/old' }, // mine\n  ],\n  model: "p/m",\n`);
    expect(rewriteContexts(src, [{ local: "/a" }, { readonly: true, local: "/b", name: "b" }])).toBe(
      config(
        `  // what it works on\n  contexts: [\n    { local: "/a" },\n    { local: "/b", readonly: true, name: "b" },\n  ],\n  model: "p/m",\n`,
      ),
    );
    expect(rewriteContexts(config(`  contexts: [{ local: "/a" }],\n`), [])).toBe(config(`  contexts: [],\n`));
  });

  it("adds the list at the top of `export default {` when there is none", () => {
    expect(rewriteContexts(config(`  model: "p/m",\n`), [{ github: "acme/a", ref: "main" }])).toBe(
      config(`  contexts: [\n    { github: "acme/a", ref: "main" },\n  ],\n  model: "p/m",\n`),
    );
  });

  it.each([
    ["a variable", `  contexts: shared,\n`],
    ["a spread", `  contexts: [...shared, { local: "/a" }],\n`],
    ["a call", `  contexts: [here()],\n`],
    ["a reference inside an entry", `  contexts: [{ local: home }],\n`],
  ])("refuses a computed list (%s) rather than overwrite it with its value", (_what, body) => {
    expect(() => rewriteContexts(config(body), [])).toThrow(/is computed, not a literal list — edit it by hand/);
  });

  it("refuses a file it cannot place the list in", () => {
    expect(() => rewriteContexts(`export default defineConfig({ model: "p/m" });\n`, [])).toThrow(
      /no `export default \{` line/,
    );
    expect(() => rewriteContexts(config(`  contexts: [],\n  contexts: [],\n`), [])).toThrow(/more than once/);
  });

  it("writes the config only after importing the candidate and finding what it meant", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-contexts-write-"));
    const agentDir = join(root, "agent");
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(agentDir);
    const path = join(agentDir, "fastagent.config.ts");
    await writeFile(path, `export default {\n  contexts: [],\n};\n`);
    await writeContexts(agentDir, [{ local: join(root, "app"), readonly: true }]);
    expect(await readFile(path, "utf8")).toBe(
      `export default {\n  contexts: [\n    { local: ${JSON.stringify(join(root, "app"))}, readonly: true },\n  ],\n};\n`,
    );

    // The import is the check, not the text: a later spread that overrides the list makes the edit mean something
    // else, and nothing is written.
    const overridden = `const base = { contexts: [{ local: "/z" }] };\nexport default {\n  contexts: [],\n  ...base,\n};\n`;
    await writeFile(path, overridden);
    await expect(writeContexts(agentDir, [])).rejects.toThrow(/would declare \[\{"local":"\/z"\}\], not \[\]/);
    expect(await readFile(path, "utf8")).toBe(overridden);

    // A refusal leaves the file as it was, and no candidate behind.
    const computed = `const mine = [];\nexport default {\n  contexts: mine,\n};\n`;
    await writeFile(path, computed);
    await expect(writeContexts(agentDir, [])).rejects.toThrow(/is computed/);
    await expect(writeContexts(agentDir, [{ local: join(root, "missing") }])).rejects.toThrow(/does not exist/);
    expect(await readFile(path, "utf8")).toBe(computed);
    expect(await readdir(agentDir)).toEqual(["fastagent.config.ts"]);
  });
});
