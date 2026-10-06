/**
 * Creating an agent and editing its contexts as an API (what `init` and `context` wrap). The rules themselves (names,
 * nesting, the literal-list rewrite) are tested where they live and through the CLI; this file owns what only the API
 * promises: an agent it creates runs as created, and its refusals are thrown, a name problem as its own class.
 */
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContextNameError, addContext, createAgent, listContexts, removeContext } from "../src/engines/pi/authoring.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Create an agent and open it in a plain Node process. vitest aliases `@fastagent-sh/fastagent` to this checkout's
 * source, which would make every import resolve; a child process run from a temp directory resolves it the way an
 * app that never ran `npm install` there does: not at all.
 */
function createAndOpen(dir: string, exampleTool: boolean): Promise<string> {
  const script = `
    import { createAgent } from ${JSON.stringify(join(SRC, "engines/pi/authoring.ts"))};
    import { createPiAgentFromDir } from ${JSON.stringify(join(SRC, "index.ts"))};
    await createAgent(${JSON.stringify(dir)}, { exampleTool: ${exampleTool} });
    await createPiAgentFromDir(${JSON.stringify(dir)}).then(() => console.log("opened"), (e) => console.log(e.message));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: tmpdir() });
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
  it("an agent createAgent makes opens without npm install; the example tool is what needs it", async () => {
    const base = await mkdtemp(join(tmpdir(), "fa-authoring-"));
    expect(await createAndOpen(join(base, "plain"), false)).toBe("opened");
    expect(await createAndOpen(join(base, "example"), true)).toMatch(
      /tools\/fetch-url\.ts \(Cannot find package '@fastagent-sh\/fastagent'/,
    );
  });

  it("creates with contexts, edits them, and throws a name refusal as ContextNameError", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-")));
    const [app, docs, other] = [join(base, "app"), join(base, "docs"), join(base, "elsewhere", "app")];
    for (const dir of [app, docs, other]) await mkdir(dir, { recursive: true });
    const agentDir = join(base, "agent");

    const created = await createAgent(agentDir, { contexts: [{ local: app }] });
    expect(created.created).not.toContain(join("tools", "fetch-url.ts"));
    expect(created.contexts.map((c) => c.name)).toEqual(["app"]);
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toContain(
      `{ local: ${JSON.stringify(app)} }`,
    );

    const added = await addContext(agentDir, { local: docs, readonly: true });
    expect(added.name).toBe("docs");
    expect(added.contexts.map((c) => [c.name, c.readonly])).toEqual([
      ["app", false],
      ["docs", true],
    ]);
    await expect(addContext(agentDir, { local: other })).rejects.toThrow(ContextNameError);
    await expect(addContext(agentDir, { local: other, name: "a b" })).rejects.toThrow(ContextNameError);
    await expect(removeContext(agentDir, "nope")).rejects.toThrow(ContextNameError);
    // Not a name problem: a plain Error, as the CLI reports it.
    const around: unknown = await addContext(agentDir, { local: base, name: "around" }).catch((e: unknown) => e);
    expect(around).not.toBeInstanceOf(ContextNameError);
    expect((around as Error).message).toMatch(/contains the agent directory/);

    // Concurrent edits apply one after the other: neither is lost, neither is refused.
    const [x, y] = [join(base, "x"), join(base, "y")];
    for (const dir of [x, y]) await mkdir(dir);
    await Promise.all([addContext(agentDir, { local: x }), addContext(agentDir, { local: y })]);
    expect((await listContexts(agentDir)).map((c) => c.name).sort()).toEqual(["app", "docs", "x", "y"]);
    await Promise.all([removeContext(agentDir, "x"), removeContext(agentDir, "y")]);

    const removed = await removeContext(agentDir, "APP");
    expect(removed).toEqual({ name: "app", contexts: await listContexts(agentDir) });
    expect(removed.contexts.map((c) => c.name)).toEqual(["docs"]);
  });

  it("createAgent refuses a name problem as ContextNameError, before it writes anything", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "fa-authoring-")));
    const [one, two, spaced] = [join(base, "a", "app"), join(base, "b", "App"), join(base, "my app")];
    for (const dir of [one, two, spaced]) await mkdir(dir, { recursive: true });
    const agentDir = join(base, "agent");
    const taken: unknown = await createAgent(agentDir, { contexts: [{ local: one }, { local: two }] }).catch((e) => e);
    expect(taken).toBeInstanceOf(ContextNameError);
    expect((taken as Error).message).toBe('this agent already has a context named "app"');
    await expect(createAgent(agentDir, { contexts: [{ local: spaced }] })).rejects.toBeInstanceOf(ContextNameError);
    await expect(access(agentDir)).rejects.toThrow(/ENOENT/);
    // Named apart, the same directories are fine.
    await createAgent(agentDir, { contexts: [{ local: one }, { local: two, name: "app2" }] });
  });
});
