/**
 * The environment (src/environment/): what the `environment` of context.json may declare, and how the agent's own mise
 * installs it here and how a process that runs the agent enters it. mise itself is a stand-in here, a script at the
 * path the agent's platform package would put it: what is tested is FastAgent's side (which isolation, which
 * arguments, where, in which order, what reaches the process), not mise. What mise itself does is not tested here.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareEnvironment } from "../../../src/environment/mise.ts";
import { log } from "../../../src/log.ts";
import { savedEnv, agentDir, fakeMise } from "../../fixtures/environment-fixtures.ts";

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

/** Every file under `dir`, with its content: to see that nothing changed there. */
async function contents(dir: string): Promise<Record<string, string>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(file.parentPath, file.name);
        return [path.slice(dir.length + 1), await readFile(path, "utf8")] as const;
      }),
    ),
  );
}

describe("environment: prepared by a process that runs the agent", () => {
  it("installs what is missing and answers the PATH that puts the packages first, writing nothing", async () => {
    const dir = await agentDir({ packages: { gh: "2", jq: "1" } });
    const { calls } = await fakeMise(dir);
    vi.spyOn(log, "info").mockImplementation(() => {});
    const before = await contents(dir);
    const variables = await prepareEnvironment(dir, process.env);
    // `where` asks of each package at once, so those runs are in no particular order.
    const args = (await calls()).map((call) => call.args);
    expect([...args.slice(0, 2).sort(), ...args.slice(2)]).toEqual([
      "where gh@2",
      "where jq@1",
      "install gh@2 jq@1",
      "env --json gh@2 jq@1",
    ]);
    expect(await contents(dir)).toEqual(before);
    expect((variables.PATH ?? "").split(delimiter)[0]).toBe("/fake/tools");
    expect(variables.FAKE_TOOL_HOME).toBe("/fake/home");
    // Answered, not entered: this process may run other agents.
    expect(process.env).toEqual(savedEnv);
    // The isolation is these runs' alone, and the agent's mise is not on the PATH.
    for (const name of ["MISE_OVERRIDE_CONFIG_FILENAMES", "MISE_GLOBAL_CONFIG_FILE", "MISE_PYTHON_COMPILE"]) {
      expect(variables[name], name).toBeUndefined();
    }
    expect(variables.PATH).not.toContain(join(dir, "node_modules"));
    // The next start has them all: it installs nothing, so it needs no network.
    await prepareEnvironment(dir, process.env);
    const again = (await calls()).slice(4).map((call) => call.args);
    expect([...again.slice(0, 2).sort(), ...again.slice(2)]).toEqual([
      "where gh@2",
      "where jq@1",
      "env --json gh@2 jq@1",
    ]);
  });
});

describe("environment: `fastagent env`", () => {
  const CLI = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
  /** The CLI as a process: for what only one shows (a command's own stdio, an interrupt, two at once). */
  const spawnCli = (
    args: string[],
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("runs a command in the environment, and exits as it does", async () => {
    const dir = await agentDir({ packages: { gh: "2" } });
    await fakeMise(dir);
    const exec = await spawnCli(["env", "exec", "--", "sh", "-c", 'echo "$PATH"; exit 3'], dir);
    expect(exec.code).toBe(3);
    expect(exec.stdout.split(delimiter)[0]).toBe("/fake/tools");
    // The command's arguments are its own, an empty one included.
    const empty = await spawnCli(["env", "exec", "--", "sh", "-c", 'printf "[%s]" "$1"', "sh", ""], dir);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toBe("[]");
    const missing = await spawnCli(["env", "exec", "--", "no-such-command-here"], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no-such-command-here: command not found in the environment");
  });
});
