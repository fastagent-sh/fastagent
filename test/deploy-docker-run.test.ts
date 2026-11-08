import { describe, expect, it } from "vitest";
import {
  agentPublishedPorts,
  type DockerRunPlan,
  deployDockerRun,
  localUrlFromComposePort,
} from "../src/deploy/docker/run.ts";
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
  provideSecrets: async () => undefined,
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

  it("tells the health probe when the agent container is gone (a crashed boot must not spend the budget)", async () => {
    // The budget absorbs a first boot that seeds the whole workspace onto the volume, so it is also
    // how long a container that EXITED would be waited for. It cannot come back; the probe is told.
    let running = true;
    const { docker, commands } = fakeDocker((args) => {
      if (args.includes("--status")) return { stdout: running ? "agent\n" : "" };
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const answers: boolean[] = [];
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      async (_url, stillStarting) => {
        answers.push(await stillStarting()); // throttled: the first call inside the window says "yes"
        await new Promise((r) => setTimeout(r, 5_050));
        running = false;
        answers.push(await stillStarting());
        return false;
      },
    );
    expect(answers).toEqual([true, false]);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("did not become healthy") });
    expect(commands().filter((c) => c.includes("--status running"))).toHaveLength(2);
  }, 10_000);

  it("the box logs in once healthy; a failed login says what it reported and still says where Compose is", async () => {
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const order: string[] = [];
    const out = await deployDockerRun(
      plan({
        boxLogin: {
          command: "fastagent login p --deployment docker",
          run: async () => {
            order.push("login");
            return "not logged in: …";
          },
        },
      }),
      docker,
      () => {},
      async () => {
        order.push("health");
        return true;
      },
    );
    expect(out).toEqual({ ok: false, gate: "not logged in: …", url: "http://127.0.0.1:8787" });
    expect(order).toEqual(["health", "login"]);
  });

  it("with no published port, a login waits for /health inside the container; without one, nothing is probed", async () => {
    const order: string[] = [];
    let probes = 0;
    const { docker, commands } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { code: 1 }; // the owner's Compose publishes nothing
      if (args.includes("exec")) {
        order.push("probe");
        return { code: ++probes < 2 ? 1 : 0 }; // not ready yet, then ready
      }
      return {};
    });
    const boxLogin = async () => {
      order.push("login");
      return undefined;
    };
    expect(
      await deployDockerRun(
        plan({ boxLogin: { command: "fastagent login p --deployment docker", run: boxLogin } }),
        docker,
        () => {},
        healthy,
      ),
    ).toEqual({ ok: true, url: undefined });
    expect(order).toEqual(["probe", "probe", "login"]);
    expect(commands().find((c) => c.includes("exec"))).toMatch(/exec -T agent sh -c .*127\.0\.0\.1:8787\/health/);

    const quiet = fakeDocker((args) =>
      args.includes("port") ? { code: 1 } : args.includes("--services") ? { stdout: "agent\n" } : {},
    );
    await deployDockerRun(plan(), quiet.docker, () => {}, healthy);
    expect(quiet.commands().some((c) => c.includes("exec"))).toBe(false);
  });

  it("never puts a secret value in argv — the container reads the value file itself", async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    await deployDockerRun(plan(), docker, () => {}, healthy);

    expect(calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = calls.find((call) => call.args.includes("up"))!;
    // The declared key rides `env_file` in the generated Compose, so it does not travel through this process at all.
    expect(up.env).toBeUndefined();
  });

  it("asks for the values before the first side effect: a name it lacks stops the run with nothing built", async () => {
    const { docker, commands } = fakeDocker();
    const out = await deployDockerRun(
      plan({ provideSecrets: async () => "Docker has no value for: BOT_TOKEN" }),
      docker,
      () => {},
      healthy,
    );
    expect(out).toEqual({ ok: false, gate: "Docker has no value for: BOT_TOKEN" });
    expect(commands().some((c) => c.includes("up") || c.includes("build"))).toBe(false);
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
      {
        name: "daemon",
        script: (args) => (args[0] === "info" ? { code: 1 } : {}),
        gate: /daemon is unavailable/,
      },
      {
        name: "unsupported Compose file",
        script: (args) => (args.includes("config") ? { code: 1 } : {}),
        gate: /generated files require Docker Compose >= 2\.3\.3/,
      },
      {
        name: "build",
        script: (args) => {
          if (args.includes("--services")) return { stdout: "agent\n" };
          return args.includes("build") ? { code: 1 } : {};
        },
        gate: /compose build.*failed/i,
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
          if (args.includes("--services") && args.includes("config")) return { stdout: "agent\n" };
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
  it("normalizes Compose port output to a loopback URL", () => {
    expect(localUrlFromComposePort("127.0.0.1:8787\n")).toBe("http://127.0.0.1:8787");
    expect(localUrlFromComposePort("0.0.0.0:9000\n")).toBe("http://127.0.0.1:9000");
    expect(localUrlFromComposePort("[::]:7000\n")).toBe("http://127.0.0.1:7000");
    expect(localUrlFromComposePort("")).toBeUndefined();
  });
});

describe("deploy/docker/run: the published port must be free", () => {
  const ports = (...published: object[]) => JSON.stringify({ services: { agent: { ports: published } } });
  const tcp = (port: number, hostIp?: string) => ({
    mode: "ingress",
    target: 8787,
    published: String(port),
    protocol: "tcp",
    ...(hostIp ? { host_ip: hostIp } : {}),
  });
  const compose = (config: string, runningBeforeUp = "") => {
    let up = false;
    return fakeDocker((args) => {
      if (args.includes("up")) up = true;
      if (args.includes("--format")) return { stdout: config };
      if (args.includes("--services") && args.includes("config")) return { stdout: "agent\n" };
      if (args.includes("--status")) return { stdout: up ? "agent\n" : runningBeforeUp };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
  };

  it("refuses, before building anything, when another process already serves the port", async () => {
    // A `/health` that answers there would be that process's, and the run would report it as the agent's.
    const { docker, commands } = compose(ports(tcp(8787, "127.0.0.1")));
    const asked: string[] = [];
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      healthy,
      async (host, port) => {
        asked.push(`${host}:${port}`);
        return true;
      },
    );
    expect(asked).toEqual(["127.0.0.1:8787"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.gate).toMatch(/127\.0\.0\.1:8787 is already in use by another process.*--force/);
    expect(commands().some((c) => c.endsWith(" build --pull") || c.endsWith(" up -d"))).toBe(false);
    expect(commands()).not.toContain("compose -f fastagent.compose.yml rm -s -f tunnel");
  });

  it("does not ask when the agent container is already running: the port is its own", async () => {
    const { docker } = compose(ports(tcp(8787)), "agent\n");
    let asked = 0;
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      healthy,
      async () => {
        asked++;
        return true;
      },
    );
    expect(asked).toBe(0);
    expect(out.ok).toBe(true);
  });

  it("goes on when the port is free", async () => {
    const { docker, commands } = compose(ports(tcp(8787)));
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      healthy,
      async () => false,
    );
    expect(out).toEqual({ ok: true, url: "http://127.0.0.1:8787" });
    expect(commands()).toContain("compose -f fastagent.compose.yml up -d");
  });

  it("asks nothing of a topology that publishes no fixed host port", async () => {
    const { docker } = compose(ports({ mode: "ingress", target: 8787, protocol: "tcp" }));
    let asked = 0;
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      healthy,
      async () => {
        asked++;
        return true;
      },
    );
    expect(asked).toBe(0);
    expect(out.ok).toBe(true);
  });

  it("gates on a Compose configuration it cannot read, rather than skipping the check", async () => {
    const { docker, commands } = compose("not json");
    const out = await deployDockerRun(
      plan(),
      docker,
      () => {},
      healthy,
      async () => false,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.gate).toMatch(/config --format json.*unreadable/);
    expect(commands()).not.toContain("compose -f fastagent.compose.yml up -d");
  });
});

describe("deploy/docker/run: agentPublishedPorts", () => {
  const read = (ports: unknown) => agentPublishedPorts(JSON.stringify({ services: { agent: { ports } } }));

  it("reads each fixed TCP host port, a wildcard bind asked on loopback", () => {
    expect(
      read([
        { published: "8787", host_ip: "127.0.0.1", protocol: "tcp" },
        { published: 9000, host_ip: "0.0.0.0", protocol: "tcp" },
        { published: "9001", host_ip: "::" },
        { published: "9002", host_ip: "192.168.1.5", protocol: "tcp" },
      ]),
    ).toEqual([
      { host: "127.0.0.1", port: 8787 },
      { host: "127.0.0.1", port: 9000 },
      { host: "127.0.0.1", port: 9001 },
      { host: "192.168.1.5", port: 9002 },
    ]);
  });

  it("leaves out what cannot collide: no fixed host port, and UDP", () => {
    expect(read([{ target: 8787 }, { published: "", target: 8787 }, { published: "53", protocol: "udp" }])).toEqual([]);
  });

  it("has no ports when the agent publishes none, and refuses what it cannot read", () => {
    expect(agentPublishedPorts('{"services":{"agent":{}}}')).toEqual([]);
    expect(agentPublishedPorts('{"services":{}}')).toEqual([]);
    expect(() => read("8787")).toThrow(/not a list/);
    expect(() => agentPublishedPorts("agent")).toThrow();
  });
});
