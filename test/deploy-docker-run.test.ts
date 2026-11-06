import { describe, expect, it } from "vitest";
import { declaredChannels } from "../src/channels/discover.ts";
import {
  agentPublishedPorts,
  type DockerRunPlan,
  deployDockerRun,
  localUrlFromComposePort,
  waitForComposeTunnelUrl,
} from "../src/deploy/docker/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { TUNNEL_DNS_LAG_MS } from "../src/tunnel.ts";

/** What `config --format json` says of a Compose file whose agent reads its tunnel's URL (a plain one needs none). */
const WIRED = JSON.stringify({
  services: {
    agent: { environment: { FASTAGENT_TUNNEL_METRICS: "http://tunnel:20241" } },
    tunnel: { command: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:20241", "--url", "http://agent:8787"] },
  },
});

/** The agent's own `/health`, reporting each webhook channel as the agent ended it. */
const agentReporting = (
  ...webhooks: { channel: string; outcome: "registered" | "manual" | "failed" | "pending" }[]
) => ({
  probe: async () => webhooks,
  intervalMs: 0,
});

function fakeDocker(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const docker: CliRunner = async (args, options) => {
    calls.push({ args, env: options?.env });
    const result = script(args);
    // `config --format json` is how the run learns the ports to be published; a script that says nothing publishes none.
    const stdout = result.stdout ?? (args.includes("--format") ? WIRED : "");
    return { code: result.code ?? 0, stdout };
  };
  return { docker, calls, commands: () => calls.map((call) => call.args.join(" ")) };
}

const plan = (override: Partial<DockerRunPlan> = {}): DockerRunPlan => ({
  composeFile: "fastagent.compose.yml",
  port: 8787,
  secrets: {},
  missingSecrets: [],
  valueFile: "fastagent/.secrets/.env",
  requireTunnel: false,
  channels: [],
  registrars: {},
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
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
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
    expect(withoutTunnel.commands()).not.toContain("compose -f fastagent.compose.yml up -d");
  });

  it("recreates the agent with the tunnel, so it reads the new tunnel's URL; a plain run does not", async () => {
    const withTunnel = fakeDocker((args) => (args.includes("--services") ? { stdout: "agent\ntunnel\n" } : {}));
    await deployDockerRun(
      plan({ requireTunnel: true }),
      withTunnel.docker,
      () => {},
      healthy,
      async () => ({
        url: "https://blue-cat.trycloudflare.com",
        connected: true,
      }),
    );
    expect(withTunnel.commands()).toContain("compose -f fastagent.compose.yml up -d --force-recreate");
    const plain = fakeDocker((args) => (args.includes("--services") ? { stdout: "agent\n" } : {}));
    await deployDockerRun(plan(), plain.docker, () => {}, healthy);
    expect(plain.commands()).toContain("compose -f fastagent.compose.yml up -d");
  });

  it("reads the agent's webhooks where the Compose file publishes it, else through the tunnel, and names the tunnel as where the platforms reach it", async () => {
    const seen: string[] = [];
    const slack: string[] = [];
    const probe = async (healthUrl: string) => {
      seen.push(healthUrl);
      return [{ channel: "telegram", outcome: "registered" as const }];
    };
    const run = (ports: string) => {
      const { docker } = fakeDocker((args) => {
        if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
        if (args.includes("port")) return ports === "" ? { code: 1 } : { stdout: ports };
        return {};
      });
      return deployDockerRun(
        plan({
          requireTunnel: true,
          channels: declaredChannels(["telegram", "slack"]),
          registrars: {
            slack: async (baseUrl) => {
              slack.push(baseUrl);
              return "registered";
            },
          },
        }),
        docker,
        () => {},
        healthy,
        async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
        undefined,
        { probe: async (url) => probe(url), intervalMs: 0 },
      );
    };
    await run("127.0.0.1:8787\n");
    await run("");
    // Slack's Request URL is set by the deploy at the tunnel; its outcome is the registrar's, not the agent's `manual`.
    expect(slack).toEqual(["https://blue-cat.trycloudflare.com", "https://blue-cat.trycloudflare.com"]);
    expect(seen).toEqual(["http://127.0.0.1:8787/health", "https://blue-cat.trycloudflare.com/health"]);
  });

  it("gates a kept Compose file whose agent cannot read its tunnel, naming what to add", async () => {
    const unwired = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("--format")) {
        return {
          stdout: JSON.stringify({ services: { agent: { environment: {} }, tunnel: { command: ["tunnel"] } } }),
        };
      }
      return {};
    });
    const out = await deployDockerRun(plan({ requireTunnel: true }), unwired.docker, () => {}, healthy);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.gate).toContain('set FASTAGENT_TUNNEL_METRICS: "http://tunnel:20241" on the "agent" service');
      expect(out.gate).toContain('add "--metrics" "0.0.0.0:20241" to the "tunnel" service\'s command');
      expect(out.gate).toContain("fastagent.compose.yml — edit it, delete it and regenerate, or pass --force");
    }
    // Before the first side effect: nothing was built, recreated or started.
    expect(unwired.commands().some((c) => c.includes(" build") || c.includes(" up"))).toBe(false);
    expect(unwired.commands().some((c) => c.includes("rm -s -f tunnel"))).toBe(false);

    // A plain run has no tunnel to read, so a Compose file without the wiring is not one that lacks it.
    const plain = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("--format")) return { stdout: JSON.stringify({ services: { agent: {} } }) };
      return {};
    });
    expect((await deployDockerRun(plan(), plain.docker, () => {}, healthy)).ok).toBe(true);
  });

  it("the box logs in once healthy and before the tunnel is announced; a failed login still says where Compose is", async () => {
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const order: string[] = [];
    const out = await deployDockerRun(
      plan({
        requireTunnel: true,
        channels: declaredChannels(["telegram"]),
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
      async () => {
        order.push("tunnel");
        return { url: "https://blue-cat.trycloudflare.com", connected: true };
      },
    );
    // The tunnel is announced only by a run, so the way to its webhooks after a login is another run.
    expect(out).toMatchObject({
      ok: false,
      gate: expect.stringMatching(
        /^not logged in: …\. This deploy confirmed no webhook.*re-run `fastagent deploy docker --run`/,
      ),
      url: "http://127.0.0.1:8787",
    });
    expect(order).toEqual(["health", "login"]);

    // Without a tunnel the webhooks were never this run's to register, so the login is all there is to say.
    const noTunnel = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const bare = await deployDockerRun(
      plan({
        channels: declaredChannels(["telegram"]),
        boxLogin: { command: "fastagent login p --deployment docker", run: async () => "not logged in: …" },
      }),
      noTunnel.docker,
      () => {},
      healthy,
    );
    expect(bare).toEqual({ ok: false, gate: "not logged in: …", url: "http://127.0.0.1:8787" });
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

  it("gates when a webhook registration terminally fails, and still reports where Compose is", async () => {
    // The parity fix: fly/railway/agentcore all gate on their registrars, and docker could not,
    // because registration happened above this layer — where no outcome was available to gate on.
    // exit 0 there tells a caller the deployment is reachable while a channel cannot receive a
    // message. The URLs ride along with the gate: Compose IS up, so the operator needs both.
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const gated = await deployDockerRun(
      plan({ requireTunnel: true, channels: declaredChannels(["telegram"]) }),
      docker,
      () => {},
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
      undefined,
      agentReporting({ channel: "telegram", outcome: "failed" }),
    );
    expect(gated.ok).toBe(false);
    if (!gated.ok) {
      expect(gated.gate).toMatch(/telegram/);
      expect(gated.tunnelUrl).toBe("https://blue-cat.trycloudflare.com");
    }
  });

  it("does not gate when every registrar succeeded or needs a human", async () => {
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const out = await deployDockerRun(
      // `manual` must NOT gate: re-running can never clear it, so an unclearable gate would spin a
      // coding agent forever (registration-gate.ts states this).
      plan({ requireTunnel: true, channels: declaredChannels(["feishu"]) }),
      docker,
      () => {},
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
      undefined,
      agentReporting({ channel: "feishu", outcome: "manual" }),
    );
    expect(out.ok).toBe(true);
  });

  // The sibling of the warning `startCloudflareTunnel` prints, and load-bearing for a sharper reason:
  // this cloudflared runs in a CONTAINER, so its logs are not in front of the author. Without this
  // line the deploy announces a URL nothing can reach and the only visible symptom is a platform
  // refusing to register — which sends the author to debug the platform.
  it("names a tunnel that never connected, rather than announcing it silently", async () => {
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const lines: string[] = [];
    const out = await deployDockerRun(
      plan({ requireTunnel: true }),
      docker,
      (message) => lines.push(message),
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: false }),
    );
    expect(out.ok).toBe(true);
    const warned = lines.find((line) => line.startsWith("warn:"));
    expect(warned, `no warning among: ${lines.join(" | ")}`).toBeDefined();
    // The URL and the remedy, because the author cannot reach these container logs on their own.
    expect(warned).toContain("https://blue-cat.trycloudflare.com");
    expect(warned).toContain("logs tunnel");
  });

  it("a connected tunnel says nothing — the warning must not fire on the normal path", async () => {
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\ntunnel\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const lines: string[] = [];
    await deployDockerRun(
      plan({ requireTunnel: true }),
      docker,
      (message) => lines.push(message),
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
    );
    expect(lines.filter((line) => line.startsWith("warn:"))).toEqual([]);
  });

  it("never puts a secret value in argv — the container reads the value file itself", async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    await deployDockerRun(plan({ secrets: { OPENAI_API_KEY: "sk-secret" } }), docker, () => {}, healthy);

    expect(calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = calls.find((call) => call.args.includes("up"))!;
    // The declared key rides `env_file` in the generated Compose, so it does not travel through this process at all.
    expect(up.env).toBeUndefined();
  });

  it("names the values the container must find, and the file it reads them from", async () => {
    // A mounted tool/channel/schedule declares its own names, so the list has to be visible, not a count. It is
    // NOT "passing N secrets to Compose": the container reads the value file itself, and a hand-owned Compose
    // file may have no `env_file` entry at all — saying we handed them over would be false.
    const { docker } = fakeDocker((args) => {
      if (args.includes("--services")) return { stdout: "agent\n" };
      if (args.includes("port")) return { stdout: "127.0.0.1:8787\n" };
      return {};
    });
    const logs: string[] = [];
    await deployDockerRun(
      plan({ secrets: { OPENAI_API_KEY: "sk", X_API_KEY: "x" } }),
      docker,
      (message) => logs.push(message),
      healthy,
    );
    expect(logs.join("\n")).toContain(
      "2 value(s) the container reads from fastagent/.secrets/.env: OPENAI_API_KEY, X_API_KEY",
    );
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
      { name: "secret", override: { missingSecrets: ["BOT_TOKEN"] }, gate: /BOT_TOKEN/ },
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
  it("reads the Quick Tunnel URL from detached Compose logs without matching Cloudflare's API URL", async () => {
    let calls = 0;
    const { docker } = fakeDocker(() => {
      calls++;
      return calls === 1
        ? { stdout: 'ERR Post "https://api.trycloudflare.com/tunnel": timeout\n' }
        : { stdout: "INF https://blue-cat.trycloudflare.com ready\n" };
    });
    const sleeps: number[] = [];
    const url = await waitForComposeTunnelUrl(docker, "fastagent.compose.yml", {
      attempts: 2,
      intervalMs: 7,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // Neither poll carries a connection line, so the budget runs out — and the URL is still returned,
    // marked as never having connected. The registrars downstream report their own outcome; a "no URL"
    // gate would misname this one, and an unmarked URL would leave the driver unable to say which it is.
    expect(url).toEqual({ url: "https://blue-cat.trycloudflare.com", connected: false });
    expect(sleeps).toEqual([7]);
  });

  // #435, the same requirement startCloudflareTunnel has: a quick tunnel's hostname is published when
  // the tunnel registers an edge connection, so the URL alone is a name that does not resolve yet —
  // and the agent registers at it as soon as it has it.
  it("waits for the edge connection, not just the URL, before handing the tunnel over", async () => {
    let calls = 0;
    const { docker } = fakeDocker(() => {
      calls++;
      return calls === 1
        ? { stdout: "INF https://blue-cat.trycloudflare.com ready\n" }
        : { stdout: "INF https://blue-cat.trycloudflare.com ready\nINF Registered tunnel connection connIndex=0\n" };
    });
    const sleeps: number[] = [];
    const url = await waitForComposeTunnelUrl(docker, "fastagent.compose.yml", {
      attempts: 5,
      intervalMs: 7,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(url).toEqual({ url: "https://blue-cat.trycloudflare.com", connected: true });
    expect(calls, "the URL was there on poll 1; it kept polling for the connection").toBe(2);
    expect(sleeps).toEqual([7, TUNNEL_DNS_LAG_MS]);
  });

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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
