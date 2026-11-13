import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { loadBuiltDefinition, loadProjectBuild } from "../../../src/harnesses/pi-durable/built.ts";
import { FIXTURES, installProbe } from "../../harnesses/probe-package.ts";
import { openAgent } from "../../../src/harnesses/pi-durable/serve.ts";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { LocalAgent } from "../../../src/harnesses/pi-durable/serve.ts";

vi.mock("../../../src/harnesses/pi-durable/storage.ts", () => import("../../doubles/storage-no-wait.ts"));

const made: string[] = [];

const agents: LocalAgent[] = [];

const scratch = (parent: string, prefix: string) => {
  const dir = mkdtempSync(join(parent, prefix));
  made.push(dir);
  return dir;
};

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

vi.mock("../../../src/harnesses/pi-durable/tsc.ts", () => import("../../doubles/tsc-double.ts"));

let installed: string | undefined;

afterAll(async () => {
  for (const agent of agents) await agent.close();
  if (installed !== undefined) setMode(installed, 0o644, 0o755);
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

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
    const a = await openAgent(definition, { root: rootA, offline: true });
    const b = await openAgent(definition, { root: rootB, offline: true });
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
    const unbuilt = scratch(FIXTURES, ".tmp-built-none-");
    writeFileSync(join(unbuilt, "package.json"), '{"name":"none","type":"module"}');
    await expect(loadProjectBuild(unbuilt, { checkSources: true })).rejects.toThrow(
      /dist holds no build: run `fastagent build`/,
    );
  });
});
