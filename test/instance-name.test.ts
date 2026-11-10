/**
 * An instance's name (agent-artifact.md §4.5): a key of its configuration, over which a flag, a variable and `openAgent`'s
 * option stand; one path segment, defaulting to the definition's made into one. `info().name` and what a command reports
 * are it.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enterInstance, instanceInputs } from "../src/cli/instance.ts";
import { instanceName } from "../src/instance-name.ts";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { agentWorkspace, fauxAgent, runInProcess } from "./cli-run.ts";
import { openSource } from "./open-source.ts";

const opened: LocalAgent[] = [];
afterEach(async () => {
  for (const agent of opened.splice(0)) await agent.close();
  vi.unstubAllEnvs();
});

describe("the name", () => {
  it("defaults to the definition's, made one path segment, and an explicit one is that or refused", () => {
    expect(instanceName("support")).toBe("support");
    expect(instanceName("@acme/reviewer")).toBe("acme-reviewer");
    expect(instanceName("@@//")).toBe("agent");
    expect(instanceName("reviewer@")).toBe("reviewer");
    expect(instanceName("@reviewer")).toBe("reviewer");
    // Interior dashes stay as written, and a long run of them is not slow to trim (a regex backtracks on it).
    expect(instanceName("a--b")).toBe("a--b");
    expect(instanceName("@acme//x")).toBe("acme--x");
    const started = performance.now();
    expect(instanceName(`${"-".repeat(100_000)}x${"-".repeat(100_000)}y`)).toBe(
      `${"-".repeat(100_000)}x${"-".repeat(100_000)}y`.replace(/^-+/, ""),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(instanceName("@acme/reviewer", "kage_1")).toBe("kage_1");
    for (const bad of ["", "a/b", "a b", "..", "é"]) {
      expect(() => instanceName("support", bad), JSON.stringify(bad)).toThrow(/must be one path segment/);
    }
  });
});

describe("an app's open", () => {
  it("reports the name it is given, else the definition's", async () => {
    const dir = await fauxAgent("fa-name-open-");
    const plain = await openSource(dir, { stateDir: join(await mkdtemp(join(tmpdir(), "fa-name-")), "a") });
    opened.push(plain);
    expect((await plain.info()).name).toMatch(/^fa-name-open-[A-Za-z0-9]+$/);
    const named = await openSource(dir, {
      name: "reviewer-2",
      stateDir: join(await mkdtemp(join(tmpdir(), "fa-name-")), "b"),
    });
    opened.push(named);
    expect((await named.info()).name).toBe("reviewer-2");
  });

  it("takes it from the configuration, over the program's, and an option over the configuration's", async () => {
    const dir = await fauxAgent("fa-name-config-");
    const state = async () => join(await mkdtemp(join(tmpdir(), "fa-name-")), "s");
    const filed = await openSource(dir, { config: { name: "from-file" }, stateDir: await state() });
    opened.push(filed);
    expect((await filed.info()).name).toBe("from-file");
    const over = await openSource(dir, { config: { name: "from-file" }, name: "from-option", stateDir: await state() });
    opened.push(over);
    expect((await over.info()).name).toBe("from-option");
  });

  it("refuses a configuration's name that is not one segment, naming where it is, before anything is opened", async () => {
    const dir = await fauxAgent("fa-name-config-refused-");
    const state = join(await mkdtemp(join(tmpdir(), "fa-name-")), "state");
    await expect(openSource(dir, { config: { name: "a/b" }, stateDir: state })).rejects.toThrow(
      /^the config object: the instance name "a\/b" must be one path segment/,
    );
    await expect(readFile(join(state, "agent.sqlite"))).rejects.toThrow(/ENOENT/);
  });

  it("is the instance's alone: the program's defaults refuse it", async () => {
    const dir = await fauxAgent("fa-name-defaults-");
    await writeFile(join(dir, "fastagent.config.ts"), `export default { defaults: { name: "x" } };\n`);
    await expect(openSource(dir, { stateDir: join(await mkdtemp(join(tmpdir(), "fa-name-")), "s") })).rejects.toThrow(
      /\/name unknown field/,
    );
  });

  it("refuses a name that is not one segment before anything of the instance is opened", async () => {
    const dir = await fauxAgent("fa-name-refused-");
    const state = join(await mkdtemp(join(tmpdir(), "fa-name-")), "state");
    await expect(openSource(dir, { name: "a/b", stateDir: state })).rejects.toThrow(/must be one path segment/);
    await expect(readFile(join(state, "agent.sqlite"))).rejects.toThrow(/ENOENT/);
  });
});

describe("the commands", () => {
  const name = async (args: string[], env?: Record<string, string>) => {
    const dir = await agentWorkspace("fa-name-cli-");
    const info = await runInProcess(["info", dir, "--json", ...args], undefined, env);
    return { info, dir, name: info.code === 0 ? (JSON.parse(info.stdout) as { name: string }).name : undefined };
  };

  it("`--name` names the instance, over FASTAGENT_NAME, over the program's", async () => {
    expect((await name([])).name).toMatch(/^fa-name-cli-[A-Za-z0-9]+$/);
    expect((await name([], { FASTAGENT_NAME: "from-env" })).name).toBe("from-env");
    expect((await name(["--name", "from-flag"], { FASTAGENT_NAME: "from-env" })).name).toBe("from-flag");
  });

  it("the project's fastagent.json names it, and a flag or the variable overrides that", async () => {
    const dir = await agentWorkspace("fa-name-file-", { "fastagent.json": JSON.stringify({ name: "from-file" }) });
    const info = async (args: string[], env?: Record<string, string>) =>
      (JSON.parse((await runInProcess(["info", dir, "--json", ...args], undefined, env)).stdout) as { name: string })
        .name;
    expect(await info([])).toBe("from-file");
    expect(await info([], { FASTAGENT_NAME: "from-env" })).toBe("from-env");
    expect(await info(["--name", "from-flag"], { FASTAGENT_NAME: "from-env" })).toBe("from-flag");
    await writeFile(join(dir, "fastagent.json"), JSON.stringify({ name: "a b" }));
    const refused = await runInProcess(["info", dir, "--json"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/fastagent\.json: the instance name "a b" must be one path segment/);
  });

  it("refuses a name that is not a segment, naming where it came from, and an empty flag", async () => {
    const flag = await name(["--name", "a/b"]);
    expect([flag.info.code, flag.info.stderr]).toEqual([
      2,
      expect.stringContaining('--name: the instance name "a/b" must be one path segment'),
    ]);
    const env = await name([], { FASTAGENT_NAME: "a b" });
    expect([env.info.code, env.info.stderr]).toEqual([2, expect.stringContaining("FASTAGENT_NAME: the instance name")]);
    const empty = await name(["--name", ""]);
    expect(empty.info.code).toBe(2);
    // An empty variable is not set, as an empty path variable is not.
    expect((await name([], { FASTAGENT_NAME: "" })).name).toMatch(/^fa-name-cli-/);
  });

  it("is checked by the commands that open an instance, `invoke` among them", async () => {
    const dir = await fauxAgent("fa-name-invoke-");
    const refused = await runInProcess(["invoke", "hello", dir, "--name", "a/b"]);
    expect([refused.code, refused.stderr]).toEqual([2, expect.stringContaining("--name: the instance name")]);
    const ran = await runInProcess(["invoke", "hello", dir, "--name", "mine"]);
    expect(ran.code, ran.stderr).toBe(0);
  });

  it("reaches what a command opens: the environment's configuration is the open's `overrides`", async () => {
    const dir = await agentWorkspace("fa-env-inputs-");
    vi.stubEnv("FASTAGENT_THINKING_LEVEL", "low");
    expect(instanceInputs(dir).overrides?.map(({ label }) => label)).toEqual(["FASTAGENT_THINKING_LEVEL"]);
  });

  it("reaches what a command opens: the flag or the variable, entered once, is the open's `name`", async () => {
    const dir = await agentWorkspace("fa-name-inputs-");
    vi.stubEnv("FASTAGENT_NAME", undefined);
    enterInstance(dir, { name: "from-flag" });
    expect(instanceInputs(dir).name).toBe("from-flag");
    vi.stubEnv("FASTAGENT_NAME", undefined);
    enterInstance(dir, {});
    expect(instanceInputs(dir).name).toBeUndefined();
    vi.stubEnv("FASTAGENT_NAME", "from-env");
    enterInstance(dir, {});
    expect(instanceInputs(dir).name).toBe("from-env");
  });
});
