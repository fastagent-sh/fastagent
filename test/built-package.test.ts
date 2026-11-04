/**
 * A built package opened as an app opens one (agent-artifact.md §3, §10 delivery 1): installed under `node_modules`,
 * read-only, once per instance, two instances at a time. What the package is made of is build.test.ts's; that a
 * project's `dist/` is the one `start` opens is cli.test.ts's.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { loadBuiltDefinition, loadProjectBuild } from "../src/harnesses/pi-durable/built.ts";
import { FIXTURES, installProbe } from "./probe-package.ts";
import { assertDefinition, defineDefinition } from "../src/harnesses/pi-durable/definition.ts";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";

const made: string[] = [];
let installed: string | undefined;
const agents: LocalAgent[] = [];
const scratch = (parent: string, prefix: string) => {
  const dir = mkdtempSync(join(parent, prefix));
  made.push(dir);
  return dir;
};

afterAll(async () => {
  for (const agent of agents) await agent.close();
  if (installed !== undefined) setMode(installed, 0o644, 0o755);
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Every file of `dir` with a hash of its content: what "the package was not written to" is compared on. */
const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return `${file.slice(dir.length + 1)} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    })
    .sort();

const setMode = (dir: string, file: number, directory: number) => {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? directory : file);
  }
  chmodSync(dir, directory);
};
const readOnly = (dir: string) => setMode(dir, 0o444, 0o555);

async function ask(agent: LocalAgent, name: string, args: Record<string, unknown>) {
  const session = await agent.sessions.create();
  const end = await agent.messages.send(
    { sessionId: session.id, content: JSON.stringify({ name, args }) },
    { wait: 30 },
  );
  expect(end.status).toBe("completed");
  return end;
}

describe("an installed package, opened as instances", () => {
  let definition: Awaited<ReturnType<typeof loadBuiltDefinition>>;

  beforeAll(async () => {
    const project = scratch(FIXTURES, ".tmp-built-project-");
    const app = scratch(FIXTURES, ".tmp-built-app-");
    const location = await installProbe(project, app);
    readOnly(location);
    installed = location;
    definition = await loadBuiltDefinition(location);
  }, 60_000);

  it("is the package's default export, read where it is installed", () => {
    expect(definition).toMatchObject({ name: "@acme/probe", version: "1.0.0", dir: installed });
  });

  it("runs two instances side by side that share no state or working directory, and writes nothing into the package", async () => {
    const before = snapshot(installed as string);
    const rootA = scratch(tmpdir(), "fa-instance-a-");
    const rootB = scratch(tmpdir(), "fa-instance-b-");
    const a = await openAgent(definition, { root: rootA });
    const b = await openAgent(definition, { root: rootB });
    agents.push(a, b);
    // A path relative to the working directory, which is the instance's own.
    await ask(a, "write", { path: "out.txt", content: "from a" });
    await ask(b, "write", { path: "out.txt", content: "from b" });
    expect(readFileSync(join(rootA, "out.txt"), "utf8")).toBe("from a");
    expect(readFileSync(join(rootB, "out.txt"), "utf8")).toBe("from b");
    expect((await a.sessions.list()).data).toHaveLength(1);
    expect((await b.sessions.list()).data).toHaveLength(1);
    expect(readdirSync(join(rootA, ".state"))).toContain("agent.sqlite");
    expect(readdirSync(join(rootB, ".state"))).toContain("agent.sqlite");
    await a.close();
    await b.close();
    expect(snapshot(installed as string)).toEqual(before);
    expect(readdirSync(installed as string)).not.toContain("out.txt");
  }, 60_000);

  it("refuses a second open over the same state, and a relative location", async () => {
    const root = scratch(tmpdir(), "fa-instance-held-");
    const first = await openAgent(definition, { root });
    agents.push(first);
    await expect(openAgent(definition, { root })).rejects.toThrow();
    await expect(openAgent(definition, { root: "relative/root" })).rejects.toThrow(
      'root must be an absolute path, and is "relative/root"',
    );
    await expect(openAgent(definition, { stateDir: join(root, "s"), workdir: "w" })).rejects.toThrow(
      'workdir must be an absolute path, and is "w"',
    );
  });
});

describe("what an opener accepts", () => {
  const spec = {
    format: 1,
    builtWith: "1.0.0",
    name: "x",
    version: "1.0.0",
    dir: "/x",
    config: {},
    registry: {} as never,
  };

  it("refuses what is not a definition, and one built for another format, naming the version that opens it", () => {
    expect(() => assertDefinition({ name: "x" })).toThrow("needs an agent package's default export");
    expect(() =>
      assertDefinition(
        defineDefinition({
          ...spec,
          format: 2,
          builtWith: "9.9.9",
          registry: { tools: [], extensions: [], channels: [], schedules: [] },
        }),
      ),
    ).toThrow(
      "x was built as definition format 2, and this FastAgent opens format 1: install @fastagent-sh/fastagent 9.9.9",
    );
  });
});

describe("a project's build is the one `start` opens only while the project is what it was built from", () => {
  let project: string;
  beforeAll(async () => {
    project = scratch(FIXTURES, ".tmp-built-stale-");
    writeFileSync(join(project, "package.json"), '{"name":"stale","type":"module"}');
    writeFileSync(join(project, "fastagent.config.ts"), "export default {};\n");
    writeFileSync(join(project, "SYSTEM.md"), "v1\n");
    mkdirSync(join(project, "src/tools"), { recursive: true });
    writeFileSync(join(project, "lib.ts"), "export const v = 1;\n");
    writeFileSync(
      join(project, "src/tools/t.ts"),
      `import { v } from "../../lib.ts";\nexport default { name: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => ({ output: [{ type: "text", text: String(v) }] }) };\n`,
    );
  });

  it("refuses a project nobody built, naming the command", async () => {
    await expect(loadProjectBuild(project)).rejects.toThrow(/dist holds no build: run `fastagent build`/);
  });

  it("opens a fresh build, and keeps opening it while the agent runs and writes beside it", async () => {
    await buildProject(project);
    expect((await loadProjectBuild(project)).name).toBe("stale");
    for (const written of [".state/agent.sqlite", ".secrets/.env", "content/repo/README.md", "out.txt"]) {
      mkdirSync(join(project, written, ".."), { recursive: true });
      writeFileSync(join(project, written), "runtime");
    }
    expect((await loadProjectBuild(project)).name).toBe("stale");
  });

  it.each([
    ["a module's code changes", "src/tools/t.ts", "// edited\n"],
    ["a file a module imports changes", "lib.ts", "export const v = 2;\n"],
    ["the prompt changes", "SYSTEM.md", "v2\n"],
    ["a module is added", "src/tools/other.ts", "export default {};\n"],
    ["a resource beside the code is added", "src/tools/data.txt", "data\n"],
    ["the manifest changes", "package.json", '{"name":"stale","type":"module","version":"2.0.0"}'],
  ])("refuses it once %s", async (_what, file, content) => {
    await buildProject(project);
    const path = join(project, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file === "src/tools/t.ts" ? `${readFileSync(path, "utf8")}${content}` : content);
    await expect(loadProjectBuild(project)).rejects.toThrow(
      /was built from other sources than .* holds now: run `fastagent build`/,
    );
    await buildProject(project);
    expect((await loadProjectBuild(project)).name).toBe("stale");
  });
});
