/**
 * An instance's name (agent-artifact.md §4.5): an input, one path segment, defaulting to the definition's made into one;
 * `info().name` and what a command reports are it.
 */
import { mkdtemp, readFile } from "node:fs/promises";
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
