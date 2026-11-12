import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBuiltDefinition } from "../src/harnesses/pi-durable/built.ts";
import { FIXTURES, installProbe } from "./probe-package.ts";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";
import { made, agents, scratch, setMode, readOnly } from "./built-package-fixtures.ts";

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

  it("refuses a second open over the same state, and a relative location", async () => {
    const root = scratch(tmpdir(), "fa-instance-held-");
    const first = await openAgent(definition, { root, offline: true });
    agents.push(first);
    await expect(openAgent(definition, { root, offline: true })).rejects.toThrow();
    await expect(openAgent(definition, { root: "relative/root" })).rejects.toThrow(
      'root must be an absolute path, and is "relative/root"',
    );
    await expect(openAgent(definition, { root, stateDir: join(root, "s"), workdir: root } as never)).rejects.toThrow(
      "give the instance a root, or a stateDir and a workdir, not both",
    );
    await expect(openAgent(definition, { stateDir: join(root, "s"), workdir: "w" })).rejects.toThrow(
      'workdir must be an absolute path, and is "w"',
    );
  });
});
