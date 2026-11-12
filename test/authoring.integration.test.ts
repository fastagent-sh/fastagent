import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitIdentity } from "./git-env.ts";
import { ContentNameError, addContent, initAgent, listContent, removeContent } from "../src/authoring.ts";
import { directory, createAndOpen } from "./authoring-fixtures.ts";

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

  it("creates with content, edits it, and throws a name refusal as ContentNameError", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-")));
    const [app, docs, other] = [join(base, "app"), join(base, "docs"), join(base, "elsewhere", "app")];
    for (const dir of [app, docs, other]) await mkdir(dir, { recursive: true });
    const agentDir = join(base, "agent");

    const created = await initAgent(agentDir, { content: [directory(app)] });
    expect(created.created).not.toContain(join("extensions", "web-access.ts"));
    // A created agent is a repository of its own, whatever created it: the CLI's tests cover the cases it is not.
    expect(created.repository).toBe("created a git repository, with the scaffold as its first commit");
    await access(join(agentDir, ".git"));
    // A directory of this machine is the instance's: it goes in fastagent.json, and the program's file is not written for it.
    expect(created.content.map((c) => [c.name, c.location])).toEqual([["app", app]]);
    const bindings = () => readFile(join(agentDir, "fastagent.json"), "utf8");
    expect(await bindings()).toBe(`{\n  "content": {\n    "app": {\n      "path": "${app}"\n    }\n  }\n}\n`);
    await expect(access(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);

    const added = await addContent(agentDir, directory(docs));
    expect(added.name).toBe("docs");
    expect(added.content.map((c) => c.name)).toEqual(["app", "docs"]);
    await expect(addContent(agentDir, directory(other))).rejects.toThrow(ContentNameError);
    await expect(addContent(agentDir, directory(other, { name: "a b" }))).rejects.toThrow(ContentNameError);
    await expect(removeContent(agentDir, "nope")).rejects.toThrow(ContentNameError);
    // Not a name problem: a plain Error, as the CLI reports it. Nothing is written.
    const before = await bindings();
    const gone: unknown = await addContent(agentDir, directory(join(base, "gone"), { name: "gone" })).catch(
      (e: unknown) => e,
    );
    expect(gone).not.toBeInstanceOf(ContentNameError);
    expect((gone as Error).message).toMatch(/does not exist/);
    expect(await bindings()).toBe(before);
    // A directory around the agent is content like any other.
    expect((await addContent(agentDir, directory(base, { name: "around" }))).name).toBe("around");
    await removeContent(agentDir, "around");

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
});
