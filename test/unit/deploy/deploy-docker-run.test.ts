import { afterEach, describe, expect, it } from "vitest";
import { type DockerRunPlan, deployDockerRun } from "../../../src/deploy/docker/run.ts";
import {
  type HostCliAnswer,
  type HostCliCall,
  recordHostCli,
  resetHostClis,
  spawnRunner,
} from "../../doubles/host-cli-double.ts";

afterEach(resetHostClis);

const recordDocker = (script: (call: HostCliCall) => HostCliAnswer = () => ({})) =>
  recordHostCli("docker", (call) => {
    const answer = script(call);
    return {
      ...answer,
      stdout: answer.stdout ?? (call.args.includes("--format") ? '{"services":{"agent":{}}}' : ""),
    };
  });

const plan = (override: Partial<DockerRunPlan> = {}): DockerRunPlan => ({
  composeFile: "fastagent.compose.yml",
  port: 8787,
  checkValues: () => undefined,
  ...override,
});

const healthy = async () => true;

describe("deploy/docker/run: local Compose journey", () => {
  it("checks tooling/daemon, reconciles Compose, verifies the agent, and health-checks its effective port", async () => {
    const docker = recordDocker(({ args }) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:9876\n" };
      return {};
    });
    const healthUrls: string[] = [];
    const out = await deployDockerRun(
      plan(),
      spawnRunner("docker", "."),
      () => {},
      async (url) => {
        healthUrls.push(url);
        return true;
      },
    );

    expect(out).toEqual({ ok: true, url: "http://127.0.0.1:9876" });
    expect(docker.cmds()).toEqual([
      "compose version",
      "info",
      "compose -f fastagent.compose.yml config --services",
      "compose -f fastagent.compose.yml config --format json",
      "compose -f fastagent.compose.yml build --pull",
      "compose -f fastagent.compose.yml up -d",
      "compose -f fastagent.compose.yml ps --status running --services",
      "compose -f fastagent.compose.yml port agent 8787",
    ]);
    expect(healthUrls).toEqual(["http://127.0.0.1:9876/health"]);
  });

  it("never puts a secret value in argv — Compose takes it from the environment it runs in", async () => {
    const docker = recordDocker(({ args }) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    await deployDockerRun(plan(), spawnRunner("docker", "."), () => {}, healthy);

    expect(docker.calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = docker.calls.find((call) => call.args.includes("up"));
    expect(up?.passedEnv).toBeUndefined();
  });
});
