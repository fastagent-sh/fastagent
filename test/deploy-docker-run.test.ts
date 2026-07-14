import { describe, expect, it } from "vitest";
import {
  type DockerRunPlan,
  deployDockerRun,
  localUrlFromComposePort,
  waitForComposeTunnelUrl,
} from "../src/deploy/docker/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

function fakeDocker(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const docker: CliRunner = async (args, options) => {
    calls.push({ args, env: options?.env });
    const result = script(args);
    return { code: result.code ?? 0, stdout: result.stdout ?? "" };
  };
  return { docker, calls, commands: () => calls.map((call) => call.args.join(" ")) };
}

const plan = (override: Partial<DockerRunPlan> = {}): DockerRunPlan => ({
  composeFile: "fastagent.compose.yml",
  port: 8787,
  secrets: {},
  missingSecrets: [],
  needsModelCredential: false,
  requireTunnel: false,
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
      "compose -f fastagent.compose.yml up -d --build",
      "compose -f fastagent.compose.yml ps --status running --services",
      "compose -f fastagent.compose.yml port agent 8787",
    ]);
    expect(healthUrls).toEqual(["http://127.0.0.1:9876/health"]);
  });

  it("detects the Compose tunnel service, waits for its URL, and makes --tunnel a topology gate", async () => {
    const { docker, commands } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const out = await deployDockerRun(
      plan({ requireTunnel: true }),
      docker,
      () => {},
      healthy,
      async () => "https://blue-cat.trycloudflare.com",
    );
    expect(out).toEqual({
      ok: true,
      url: "http://127.0.0.1:8787",
      tunnelUrl: "https://blue-cat.trycloudflare.com",
    });
    expect(commands()).toContain("compose -f fastagent.compose.yml rm -s -f tunnel");

    const withoutTunnel = fakeDocker((args) => (args.includes("--services") ? { stdout: "agent\n" } : {}));
    const gated = await deployDockerRun(plan({ requireTunnel: true }), withoutTunnel.docker, () => {}, healthy);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/--tunnel.*no "tunnel" service.*--force/);
    expect(withoutTunnel.commands()).not.toContain("compose -f fastagent.compose.yml up -d --build");
  });

  it("passes secret values through the child environment, never argv", async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    await deployDockerRun(
      plan({ secrets: { OPENAI_API_KEY: "sk-secret", FASTAGENT_AUTH_SEED: "base64-secret" } }),
      docker,
      () => {},
      healthy,
    );

    expect(calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = calls.find((call) => call.args.includes("up"))!;
    expect(up.env).toEqual({ OPENAI_API_KEY: "sk-secret", FASTAGENT_AUTH_SEED: "base64-secret" });
  });

  it("accepts a running custom topology with no host-published port (operator-owned ingress)", async () => {
    const logs: string[] = [];
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { code: 1 };
      return {};
    });
    const out = await deployDockerRun(plan(), docker, (message) => logs.push(message), healthy);
    expect(out).toEqual({ ok: true });
    expect(logs.join("\n")).toContain("no host-published port");
  });

  it("gates missing CLI/plugin, credential, secret, daemon, failed up, stopped service, and failed health", async () => {
    const cases: {
      name: string;
      override?: Partial<DockerRunPlan>;
      script?: (args: string[]) => { code?: number; stdout?: string };
      probe?: () => Promise<boolean>;
      gate: RegExp;
    }[] = [
      {
        name: "CLI",
        script: (args) => (args[0] === "compose" && args[1] === "version" ? { code: 127 } : {}),
        gate: /Docker CLI not found/,
      },
      {
        name: "plugin",
        script: (args) => (args[0] === "compose" && args[1] === "version" ? { code: 1 } : {}),
        gate: /Compose plugin/,
      },
      { name: "credential", override: { needsModelCredential: true }, gate: /fastagent login/ },
      { name: "secret", override: { missingSecrets: ["BOT_TOKEN"] }, gate: /BOT_TOKEN/ },
      {
        name: "daemon",
        script: (args) => (args[0] === "info" ? { code: 1 } : {}),
        gate: /daemon is unavailable/,
      },
      {
        name: "up",
        script: (args) => {
          if (args.includes("--services")) return { stdout: "agent\n" };
          return args.includes("up") ? { code: 1 } : {};
        },
        gate: /compose up.*failed/i,
      },
      {
        name: "service",
        script: (args) => {
          if (args.includes("config")) return { stdout: "agent\n" };
          if (args.includes("ps")) return { stdout: "" };
          return {};
        },
        gate: /not running/,
      },
      {
        name: "health",
        script: (args) => {
          if (args.includes("--services")) return { stdout: "agent\n" };
          if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
          return {};
        },
        probe: async () => false,
        gate: /did not become healthy/,
      },
    ];

    for (const item of cases) {
      const { docker } = fakeDocker(item.script);
      const out = await deployDockerRun(plan(item.override), docker, () => {}, item.probe ?? healthy);
      expect(out.ok, item.name).toBe(false);
      if (!out.ok) expect(out.gate, item.name).toMatch(item.gate);
    }
  });
});

describe("deploy/docker/run: parsers", () => {
  it("reads the Quick Tunnel URL from detached Compose logs without matching Cloudflare's API URL", async () => {
    let calls = 0;
    const { docker } = fakeDocker(() => {
      calls++;
      return calls === 1
        ? { stdout: 'ERR Post "https://api.trycloudflare.com/tunnel": timeout\n' }
        : { stdout: "INF https://blue-cat.trycloudflare.com ready\n" };
    });
    const sleeps: number[] = [];
    const url = await waitForComposeTunnelUrl(
      docker,
      "fastagent.compose.yml",
      {},
      {
        attempts: 2,
        intervalMs: 7,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(url).toBe("https://blue-cat.trycloudflare.com");
    expect(sleeps).toEqual([7]);
  });

  it("normalizes Compose port output to a loopback URL", () => {
    expect(localUrlFromComposePort("127.0.0.1:8787\n")).toBe("http://127.0.0.1:8787");
    expect(localUrlFromComposePort("0.0.0.0:9000\n")).toBe("http://127.0.0.1:9000");
    expect(localUrlFromComposePort("[::]:7000\n")).toBe("http://127.0.0.1:7000");
    expect(localUrlFromComposePort("")).toBeUndefined();
  });
});
