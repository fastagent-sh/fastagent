import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";

vi.mock("../../../packages/fastagent/src/git.ts", () => import("../../doubles/git-double.ts"));

const scratch = () => mkdtemp(join(tmpdir(), "fa-instance-"));

describe("info reports where the instance is", () => {
  const where = async (args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env) => {
    const dir = await agentWorkspace("fa-instance-info-");
    const result = await runInProcess(["-C", dir, "info", "--json", ...args], cwd, env);
    expect(result.code, result.stderr).toBe(0);
    const { workdir, stateRoot } = JSON.parse(result.stdout) as { workdir: string; stateRoot: string };
    return { dir, workdir, stateRoot };
  };

  it("a flag beats its environment variable, which beats the default", async () => {
    const fromEnv = await scratch();
    const fromFlag = await scratch();
    const env = { ...process.env, FASTAGENT_ROOT: fromEnv };
    expect((await where([], undefined, env)).workdir).toBe(fromEnv);
    expect((await where(["--root", fromFlag], undefined, env)).workdir).toBe(fromFlag);
  });
});
