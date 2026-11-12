/**
 * Content (src/content/): what the program declares an agent works on in `context.json`, what an instance's
 * configuration adds, what a command's `<source>` adds, and where each entry is for this instance. Each refusal is
 * tested once, here, where its rule lives; callers test only their wiring.
 */
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareContent } from "../src/content/declare.ts";
import { resolveContent } from "../src/content/resolve.ts";

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
});

describe("content: resolved for this instance", () => {
  async function layout() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fa-content-")));
    const dir = join(root, "agent");
    await mkdir(join(dir, "content"), { recursive: true });
    await mkdir(join(root, "notes"));
    return { root, dir, places: { workdir: dir } };
  }

  it("a repository is a clone fastagent makes at content/<name> in the working directory", async () => {
    const { root } = await layout();
    const declared = declareContent({ app: { github: "acme/app" } }, PROGRAM);
    const workdir = join(root, "instance");
    expect(resolveContent(declared, { workdir })).toEqual([
      expect.objectContaining({
        kind: "github",
        location: join(workdir, "content", "app"),
        notices: [expect.stringMatching(/^not cloned yet/)],
      }),
    ]);
  });
});
