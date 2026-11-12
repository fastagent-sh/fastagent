import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

const scratch = () => mkdtemp(join(tmpdir(), "fa-instance-"));

describe("info reports where the instance is", () => {
  const where = async (args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env) => {
    const dir = await agentWorkspace("fa-instance-info-");
    const result = await runInProcess(["info", dir, "--json", ...args], cwd, env);
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

describe("the configuration a command is given", () => {
  it("--config names the instance configuration, over the project's own, and a missing file refuses", async () => {
    const dir = await agentWorkspace("fa-instance-config-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "fastagent.json": JSON.stringify({ thinkingLevel: "low" }),
    });
    const named = join(await scratch(), "other.json");
    await writeFile(named, JSON.stringify({ thinkingLevel: "high" }));
    const project = await runInProcess(["info", dir, "--json"]);
    expect(JSON.parse(project.stdout).thinkingLevel).toBe("low");
    const over = await runInProcess(["info", dir, "--json", "--config", named]);
    expect(JSON.parse(over.stdout).config.thinkingLevel).toEqual({ value: "high", source: named });
    const missing = await runInProcess(["info", dir, "--json", "--config", join(dirname(named), "absent.json")]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("absent.json");
  });
});
