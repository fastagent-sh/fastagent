import { describe, expect, it } from "vitest";
import { type DockerRunPlan, deployDockerRun } from "../src/deploy/docker/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

function fakeDocker(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const docker: CliRunner = async (args, options) => {
    calls.push({ args, env: options?.env });
    const result = script(args);
    // `config --format json` is how the run learns the ports to be published; a script that says nothing publishes none.
    const stdout = result.stdout ?? (args.includes("--format") ? '{"services":{"agent":{}}}' : "");
    return { code: result.code ?? 0, stdout };
  };
  return { docker, calls, commands: () => calls.map((call) => call.args.join(" ")) };
}

const plan = (override: Partial<DockerRunPlan> = {}): DockerRunPlan => ({
  composeFile: "fastagent.compose.yml",
  port: 8787,
  checkValues: () => undefined,
  ...override,
});

const healthy = async () => true;

describe("deploy/docker/run: local Compose journey", () => {
  it("checks tooling/daemon, reconciles Compose, verifies the agent, and health-checks its effective port", async () => {
    const { docker, commands } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:9876\n" };
      return {};
    });
    const healthUrls: string[] = [];
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      async (url) => {
        healthUrls.push(url);
        return true;
      },
    );

    expect(out).toEqual({ ok: true, url: "http://127.0.0.1:9876" });
    expect(commands()).toEqual([
      "compose version",
      "info",
      "compose -f fastagent.compose.yml config --services",
      "compose -f fastagent.compose.yml config --format json",
      // The base image is a floating tag: a copy cached here may predate the runtime floor.
      "compose -f fastagent.compose.yml build --pull",
      "compose -f fastagent.compose.yml up -d",
      "compose -f fastagent.compose.yml ps --status running --services",
      "compose -f fastagent.compose.yml port agent 8787",
    ]);
    expect(healthUrls).toEqual(["http://127.0.0.1:9876/health"]);
  });

  it("never puts a secret value in argv — Compose takes it from the environment it runs in", async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    await deployDockerRun(plan(), docker, () => {}, healthy);

    expect(calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = calls.find((call) => call.args.includes("up"))!;
    // The declared names are listed in the generated Compose and filled from the environment the child inherits: this
    // process hands Compose nothing of its own.
    expect(up.env).toBeUndefined();
  });
});
