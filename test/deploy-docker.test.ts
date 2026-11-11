import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  MIN_DOCKER_COMPOSE_VERSION,
  composeValuesGate,
  ingressNotes,
  planDockerDeploy,
  toDockerProjectName,
} from "../src/deploy/docker/plan.ts";
import { declaredChannels } from "../src/channels/discover.ts";
import { webhookPaths } from "../src/deploy/channel-ingress.ts";

const compose = (plan: ReturnType<typeof planDockerDeploy>) =>
  plan.artifacts.find((artifact) => artifact.path.endsWith("fastagent.bot.compose.yml"))!.content;
const runbook = (plan: ReturnType<typeof planDockerDeploy>) => plan.runbook.join("\n");

const base = {
  config: "{}",
  agent: "bot",
  secretNames: [],
  projectName: "fastagent-bot",
  port: 8787,
  runtime: "node",
  hasLockfile: true,
} as const;

describe("deploy/docker: planDockerDeploy", () => {
  it("says how to regenerate the manifest after a change: this instance's --config, and --force for a file that is kept", () => {
    const out = runbook(planDockerDeploy({ ...base, channels: [], configFile: "/etc/acme prod.json" }));
    expect(out).toContain("run `fastagent deploy docker --config '/etc/acme prod.json' --force`");
    expect(runbook(planDockerDeploy({ ...base, channels: [] }))).toContain("run `fastagent deploy docker --force`");
  });

  it("renders the instance's name, release and configuration into the Compose file, with `$` doubled for Compose", () => {
    const config = JSON.stringify({
      mcpServers: { n: { url: "https://e.com", headers: { A: `Bearer $` + "{TOKEN}" } } },
    });
    const yaml = compose(planDockerDeploy({ ...base, config, channels: [] }));
    const { environment } = parseYaml(yaml).services.agent as { environment: Record<string, string> };
    expect(environment.FASTAGENT_NAME).toBe("bot");
    expect(environment.FASTAGENT_RELEASE_ID).toMatch(/^[0-9a-f]{12}$/);
    // Compose reads `$$` as `$`: what the box is given is the configuration as written.
    expect(environment.FASTAGENT_CONFIG_JSON).toContain("$${TOKEN}");
    expect(environment.FASTAGENT_CONFIG_JSON?.replaceAll("$$", "$")).toBe(config);
    // The same configuration renders the same file, so a committed one changes only when the configuration does.
    expect(compose(planDockerDeploy({ ...base, config, channels: [] }))).toBe(yaml);
  });

  it("asks for no container privilege: the volume is a local disk, nothing needs mounting", () => {
    const yaml = compose(planDockerDeploy({ ...base, channels: [] }));
    expect(yaml).not.toContain("SYS_ADMIN");
    expect(yaml).not.toContain("apparmor");
  });
  it("generates only the app topology: loopback port + persistent state, no ingress coupling", () => {
    const plan = planDockerDeploy({ ...base, channels: declaredChannels(["telegram"]) });
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      "fastagent.bot.compose.yml",
      ".fastagent/deploy/fastagent.packages",
      "Dockerfile",
      ".dockerignore",
    ]);

    const yaml = compose(plan);
    expect(yaml).toContain('"127.0.0.1:8787:8787"');
    expect(yaml).toContain('FASTAGENT_STATE_DIR: "/data/.state"');
    expect(yaml).toContain('FASTAGENT_SECRETS_DIR: "/data/.secrets"');
    // Content is linked onto the volume by the release itself (workspace.ts), not by an override.
    expect(yaml).not.toContain("CONTENT");
    expect(yaml).toContain("- state:/data");
    expect(yaml).toContain("restart: unless-stopped");
    // Docker's default json-file driver never rotates, and this agent's log is where a failed turn's reason is
    // recorded — so the topology carries the bound the host does not.
    expect(yaml).toMatch(/logging:\n\s+driver: json-file\n\s+options:\n\s+max-size: "10m"\n\s+max-file: "3"/);
    expect(yaml).not.toContain("cloudflared");
    expect(yaml).not.toContain("trycloudflare");
    expect(yaml).not.toContain("TUNNEL_TOKEN");
  });

  it("tells whoever owns the ingress to name its URL as http.publicUrl, and leaves a plain Compose alone", () => {
    const plan = planDockerDeploy({ ...base, channels: declaredChannels(["telegram"]) });
    expect(runbook(plan)).toContain("Name that URL as http.publicUrl");
    expect(runbook(plan)).not.toContain("logs -f tunnel");
    expect(compose(plan)).not.toContain("tunnel:");
  });

  it("says what is left of the webhook channels: nothing reaches them without a URL, or the agent points them at the named one", () => {
    const channels = declaredChannels(["telegram", "slack"]);
    expect(ingressNotes(channels, undefined, "http://127.0.0.1:8787/health")).toEqual([
      expect.stringContaining("/telegram, /slack receive nothing until a public URL reaches this container"),
    ]);
    const named = ingressNotes(channels, "https://agent.acme.com", "http://127.0.0.1:8787/health");
    expect(named).toEqual([
      "the agent points its webhook channels at https://agent.acme.com on every start; http://127.0.0.1:8787/health says how each went",
      expect.stringContaining("slack: set Event Subscriptions → Request URL → https://agent.acme.com/slack"),
    ]);
    // Without Slack there is no step of the operator's; without a webhook channel there is nothing to say.
    expect(ingressNotes(declaredChannels(["telegram"]), "https://agent.acme.com", undefined)).toEqual([
      "the agent points its webhook channels at https://agent.acme.com on every start; its /health says how each went",
    ]);
    expect(ingressNotes(declaredChannels(["feishu"], "long-connection"), undefined, undefined)).toEqual([]);
    expect(ingressNotes([], "https://agent.acme.com", undefined)).toEqual([]);
  });

  it("omits public paths for long-connection Feishu", () => {
    const plan = planDockerDeploy({
      ...base,
      channels: [...declaredChannels(["feishu"], "long-connection")],
    });
    expect(runbook(plan)).not.toContain("https://<your-domain>/feishu");
  });

  it("lists each secret by name only: Compose fills it from the environment that runs it, and the file holds no value", () => {
    const yaml = compose(
      planDockerDeploy({
        ...base,
        channels: declaredChannels(["telegram"]),
        secrets: [{ name: "GH_TOKEN", hint: "required by tools/gh.ts" }],
        secretNames: ["OPENAI_API_KEY", "GH_TOKEN", "FASTAGENT_API_KEY"],
      }),
    );
    const { environment } = parseYaml(yaml).services.agent as { environment: Record<string, string | null> };
    // A key with no value: Compose resolves it from its own environment, and sets nothing when it has none.
    for (const name of ["OPENAI_API_KEY", "GH_TOKEN", "FASTAGENT_API_KEY"]) {
      expect(Object.hasOwn(environment, name), name).toBe(true);
      expect(environment[name]).toBeNull();
    }
    // No file of this machine is named, no value is interpolated from the shell, and none is written down.
    expect(yaml).not.toContain("env_file");
    expect(yaml).not.toContain(".secrets/production");
    expect(yaml).not.toMatch(/: "\$\{/);
    expect(yaml).not.toContain("sk-");
    // Pinned machinery stays where it was: the container's sessions and credentials stay on the volume.
    expect(yaml).toContain('FASTAGENT_AUTH_PATH: "/data/.secrets/auth.json"');
    // A deployment with no secret lists none.
    expect(
      Object.keys(parseYaml(compose(planDockerDeploy({ ...base, channels: [] }))).services.agent.environment),
    ).not.toContain("OPENAI_API_KEY");
  });

  it("stops a run when a required name has no value in the environment, reading whether it is set and never what it is", () => {
    const needs = [
      { name: "OPENAI_API_KEY", hint: "your model provider key" },
      { name: "GH_TOKEN", hint: "required by tools/gh.ts" },
    ];
    expect(composeValuesGate(needs, { OPENAI_API_KEY: "sk-x", GH_TOKEN: "t" }, "the environment")).toBeUndefined();
    const gate = composeValuesGate(needs, { OPENAI_API_KEY: "sk-x", GH_TOKEN: "  " }, "the environment") as string;
    // An empty value is no value, as for every other host; the secret that is there is not in what is said.
    expect(gate).toContain("Docker has no value for: GH_TOKEN (required by tools/gh.ts)");
    expect(gate).not.toContain("OPENAI_API_KEY");
    expect(gate).not.toContain("sk-x");
    expect(gate).toContain("pass --env-file <file>");
  });

  it("puts the Compose file beside the Dockerfile and builds the agent directory itself", () => {
    const plan = planDockerDeploy({ ...base, channels: [] });
    expect(plan.composePath).toBe("fastagent.bot.compose.yml");
    expect(compose(plan)).toContain("context: .\n");
    expect(compose(plan)).toContain("dockerfile: Dockerfile\n");
    expect(runbook(plan)).toContain("Run from the agent directory");
  });

  it("prints lifecycle + operator-owned ingress guidance for detected webhook channels", () => {
    const out = runbook(planDockerDeploy({ ...base, channels: declaredChannels(["telegram", "slack"]) }));
    expect(out).toContain(`Docker Engine/Desktop with Compose >= ${MIN_DOCKER_COMPOSE_VERSION}`);
    for (const cmd of ["build --pull", "up -d", "logs -f agent", "ps", "down"]) {
      expect(out).toContain(`docker compose -f fastagent.bot.compose.yml ${cmd}`);
    }
    expect(out).toContain("down        # stops containers; keeps the state volume");
    expect(out).toContain("down -v   # DESTRUCTIVE");
    expect(out).toContain("Public ingress is operator-owned");
    expect(out).toContain("https://<your-domain>/telegram");
    expect(out).toContain("https://<your-domain>/slack");
  });

  it("sanitizes a stable Compose project name and exposes default webhook paths", () => {
    expect(toDockerProjectName("My Agent!")).toBe("fastagent-my-agent");
    expect(toDockerProjectName("___")).toBe("fastagent-agent");
    expect(webhookPaths(declaredChannels(["telegram", "slack", "feishu", "lark"]))).toEqual([
      "/telegram",
      "/slack",
      "/feishu",
      "/lark",
    ]);
  });
});
