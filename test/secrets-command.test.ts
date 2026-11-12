import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./cli-run.ts";
import { agent, realStdin } from "./secrets-command-fixtures.ts";

afterEach(() => {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
});

describe("secrets list", () => {
  it("Docker holds no values of its own, so it is not a host here: Compose takes them from the environment that runs it", async () => {
    const result = await runInProcess(["secrets", "list", "docker", await agent()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Allowed choices are fly, railway, agentcore");
  });
});

describe("secrets push", () => {
  it("two sources are a usage error", async () => {
    const dir = await agent();
    const result = await runInProcess(["secrets", "push", "fly", dir, "--from-env", "--env-file", join(dir, "x")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("two sources");
  });
});
