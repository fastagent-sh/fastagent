import { describe, expect, it } from "vitest";
import {
  type DockerRunPlan,
  deployDockerRun,
  localUrlFromComposePort,
  waitForComposeTunnelUrl,
} from "../src/deploy/docker/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { TUNNEL_DNS_LAG_MS } from "../src/tunnel.ts";

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
  valueFile: "fastagent/.secrets/.env",
  needsModelCredential: false,
  requireTunnel: false,
  announce: async () => [],
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

  it("passes ONLY the auth seed, and sets it even when absent", async () => {
    // The container reads the value file itself through the generated `env_file`, so nothing else has to cross this
    // process. The seed is the exception (`--run` mints it from the local auth.json) and is set unconditionally:
    // `spawnRunner` merges over `process.env`, so leaving it unset would let a same-named variable in the builder's
    // shell interpolate into the container in its place.
    const before = process.env.FASTAGENT_AUTH_SEED;
    process.env.FASTAGENT_AUTH_SEED = "from-the-builders-shell";
    try {
      const { docker, calls } = fakeDocker((args) => (args[1] === "port" ? { code: 1 } : {}));
      await deployDockerRun(plan({ secrets: { TELEGRAM_BOT_TOKEN: "t" } }), docker, () => {}, healthy);
      const passed = calls.find((call) => call.env)?.env;
      expect(passed).toEqual({ FASTAGENT_AUTH_SEED: "" }); // blanked, and nothing else travels
    } finally {
      if (before === undefined) delete process.env.FASTAGENT_AUTH_SEED;
      else process.env.FASTAGENT_AUTH_SEED = before;
    }
  });

  it("carries the minted auth seed when there is one", async () => {
    const { docker, calls } = fakeDocker((args) => (args[1] === "port" ? { code: 1 } : {}));
    await deployDockerRun(plan({ secrets: { FASTAGENT_AUTH_SEED: "b64" } }), docker, () => {}, healthy);
    expect(calls.find((call) => call.env)?.env).toEqual({ FASTAGENT_AUTH_SEED: "b64" });
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
    expect(withoutTunnel.commands()).not.toContain("compose -f fastagent.compose.yml up -d --build");
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
      plan({
        requireTunnel: true,
        announce: async () => [
          { kind: "telegram", outcome: "failed" },
          { kind: "github", outcome: "manual" },
        ],
      }),
      docker,
      () => {},
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
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
      plan({ requireTunnel: true, announce: async () => [{ kind: "github", outcome: "manual" }] }),
      docker,
      () => {},
      healthy,
      async () => ({ url: "https://blue-cat.trycloudflare.com", connected: true }),
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
      plan({ requireTunnel: true, announce: async () => [{ kind: "github", outcome: "manual" }] }),
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
      plan({ requireTunnel: true, announce: async () => [{ kind: "github", outcome: "manual" }] }),
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
    await deployDockerRun(
      plan({ secrets: { OPENAI_API_KEY: "sk-secret", FASTAGENT_AUTH_SEED: "base64-secret" } }),
      docker,
      () => {},
      healthy,
    );

    expect(calls.some((call) => call.args.join(" ").includes("sk-secret"))).toBe(false);
    const up = calls.find((call) => call.args.includes("up"))!;
    // The declared key rides `env_file` in the generated Compose, so it does not travel through this process at all.
    expect(up.env).toEqual({ FASTAGENT_AUTH_SEED: "base64-secret" });
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
      { name: "credential", override: { needsModelCredential: true }, gate: /fastagent login/ },
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
    // Neither poll carries a connection line, so the budget runs out — and the URL is still returned,
    // marked as never having connected. The registrars downstream report their own outcome; a "no URL"
    // gate would misname this one, and an unmarked URL would leave the driver unable to say which it is.
    expect(url).toEqual({ url: "https://blue-cat.trycloudflare.com", connected: false });
    expect(sleeps).toEqual([7]);
  });

  // #435, the same requirement startCloudflareTunnel has: a quick tunnel's hostname is published when
  // the tunnel registers an edge connection, so the URL alone is a name that does not resolve yet —
  // and this driver hands it straight to `announce`.
  it("waits for the edge connection, not just the URL, before handing the tunnel over", async () => {
    let calls = 0;
    const { docker } = fakeDocker(() => {
      calls++;
      return calls === 1
        ? { stdout: "INF https://blue-cat.trycloudflare.com ready\n" }
        : { stdout: "INF https://blue-cat.trycloudflare.com ready\nINF Registered tunnel connection connIndex=0\n" };
    });
    const sleeps: number[] = [];
    const url = await waitForComposeTunnelUrl(
      docker,
      "fastagent.compose.yml",
      {},
      {
        attempts: 5,
        intervalMs: 7,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
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
