import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitIdentity } from "./git-env.ts";
import { addContent, createAgent, removeContent } from "../src/authoring.ts";
import { readContentSource } from "../src/content/source.ts";
import { directory } from "./authoring-fixtures.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

describe("authoring API", () => {
  // createAgent commits the scaffold.
  beforeEach(() => {
    useGitIdentity(vi.stubEnv);
    return () => vi.unstubAllEnvs();
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

  it("a refused edit on an agent without context files leaves none", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-none-")));
    const agentDir = join(base, "agent");
    await createAgent(agentDir);
    await expect(removeContent(agentDir, "app")).rejects.toThrow('no content named "app" (this agent has: none)');
    await expect(addContent(agentDir, directory(join(base, "missing")))).rejects.toThrow(/does not exist/);
    for (const file of ["context.json", "fastagent.json"]) {
      await expect(access(join(agentDir, file))).rejects.toThrow(/ENOENT/);
    }
  });
});
