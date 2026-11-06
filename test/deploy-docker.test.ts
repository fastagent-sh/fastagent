import { describe, expect, it } from "vitest";
import {
  MIN_DOCKER_COMPOSE_VERSION,
  ingressNotes,
  planDockerDeploy,
  toDockerProjectName,
} from "../src/deploy/docker/plan.ts";
import { declaredChannels } from "../src/channels/discover.ts";
import { webhookPaths } from "../src/deploy/channel-ingress.ts";

const compose = (plan: ReturnType<typeof planDockerDeploy>) =>
  plan.artifacts.find((artifact) => artifact.path.endsWith("fastagent.compose.yml"))!.content;
const runbook = (plan: ReturnType<typeof planDockerDeploy>) => plan.runbook.join("\n");

const base = {
  releaseId: "release-one",
  agent: "bot",
  valueFile: ".secrets/.env",
  projectName: "fastagent-bot",
  port: 8787,
  runtime: "node",
  hasLockfile: true,
} as const;

describe("deploy/docker: planDockerDeploy", () => {
  it("asks for no container privilege: the volume is a local disk, nothing needs mounting", () => {
    const yaml = compose(planDockerDeploy({ ...base, channels: [] }));
    expect(yaml).not.toContain("SYS_ADMIN");
    expect(yaml).not.toContain("apparmor");
  });
  it("generates only the app topology: loopback port + persistent state, no ingress coupling", () => {
    const plan = planDockerDeploy({ ...base, channels: declaredChannels(["telegram"]) });
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      "fastagent.compose.yml",
      "fastagent.release.json",
      "fastagent.deploy/fastagent.json",
      "fastagent.packages",
      "Dockerfile",
      ".dockerignore",
      "Dockerfile.dockerignore",
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

  it("names the value file instead of interpolating each secret", () => {
    // Interpolation resolves from the SHELL or the project `.env` — exactly the source a deployment must not have.
    // `env_file` points Compose at the deployed environment's own declaration, so no declared name appears here at
    // all, by hand or under `--run`.
    const yaml = compose(
      planDockerDeploy({
        ...base,
        channels: declaredChannels(["telegram", "feishu"]),
        secrets: [{ name: "GH_TOKEN", hint: "required by tools/gh.ts" }],
      }),
    );
    expect(yaml).toContain("env_file:\n      - .secrets/production/.env");
    for (const name of ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "FEISHU_APP_ID", "GH_TOKEN"]) {
      expect(yaml).not.toContain(name);
    }
    expect(yaml).not.toMatch(/: "\$\{/); // no value is interpolated from the shell
    expect(yaml).not.toContain("<value>");
    expect(yaml).not.toContain("sk-");

    // The path is FIXED, never the builder's FASTAGENT_SECRETS_DIR: this file is committed and must mean the same
    // thing on every machine. `deploy` creates the file so the entry is never a missing path.
    expect(compose(planDockerDeploy({ ...base, channels: [], valueFile: "somewhere/else/.env" }))).toContain(
      "env_file:\n      - .secrets/production/.env",
    );

    // Machinery pinned AFTER env_file, so a local path in that file (the scaffold lists these) cannot send the
    // container's sessions or credentials to a host path that does not exist inside it.
    expect(yaml).toContain('FASTAGENT_AUTH_PATH: "/data/.secrets/auth.json"');
  });

  it("puts the Compose file beside the Dockerfile and builds the agent directory itself", () => {
    const plan = planDockerDeploy({ ...base, channels: [] });
    expect(plan.composePath).toBe("fastagent.compose.yml");
    expect(compose(plan)).toContain("context: .\n");
    expect(compose(plan)).toContain("dockerfile: Dockerfile\n");
    expect(runbook(plan)).toContain("Run from the agent directory");
  });

  it("prints lifecycle + operator-owned ingress guidance for detected webhook channels", () => {
    const out = runbook(planDockerDeploy({ ...base, channels: declaredChannels(["telegram", "slack"]) }));
    expect(out).toContain(`Docker Engine/Desktop with Compose >= ${MIN_DOCKER_COMPOSE_VERSION}`);
    // One spelling everywhere: the generated file names the value file itself, so no command needs a flag.
    for (const cmd of ["build --pull", "up -d", "logs -f agent", "ps", "down"]) {
      expect(out).toContain(`docker compose -f fastagent.compose.yml ${cmd}`);
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
