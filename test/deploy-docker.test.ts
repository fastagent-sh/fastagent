import { describe, expect, it } from "vitest";
import {
  CLOUDFLARED_IMAGE,
  MIN_DOCKER_COMPOSE_VERSION,
  composeHasTunnelService,
  dockerWebhookPaths,
  planDockerDeploy,
  toDockerProjectName,
} from "../src/deploy/docker/plan.ts";

const compose = (plan: ReturnType<typeof planDockerDeploy>) =>
  plan.artifacts.find((artifact) => artifact.path.endsWith("fastagent.compose.yml"))!.content;
const runbook = (plan: ReturnType<typeof planDockerDeploy>) => plan.runbook.join("\n");

const base = {
  projectName: "fastagent-bot",
  port: 8787,
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  tunnel: false,
} as const;

describe("deploy/docker: planDockerDeploy", () => {
  it("generates only the app topology: loopback port + persistent state, no tunnel/ingress coupling", () => {
    const plan = planDockerDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"] });
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      "fastagent.compose.yml",
      "Dockerfile",
      ".dockerignore",
    ]);

    const yaml = compose(plan);
    expect(yaml).toContain('"127.0.0.1:8787:8787"');
    expect(yaml).toContain('FASTAGENT_STATE_DIR: "/data/.state"');
    expect(yaml).toContain('FASTAGENT_SECRETS_DIR: "/data/.secrets"');
    expect(yaml).toContain("- state:/data");
    expect(yaml).toContain("restart: unless-stopped");
    expect(yaml).not.toContain("cloudflared");
    expect(yaml).not.toContain("trycloudflare");
    expect(yaml).not.toContain("TUNNEL_TOKEN");
  });

  it("--tunnel adds a pinned ephemeral cloudflared service, without changing the app image", () => {
    const plan = planDockerDeploy({
      ...base,
      modelAuth: "OPENAI_API_KEY",
      channels: ["telegram"],
      tunnel: true,
    });
    const yaml = compose(plan);
    expect(yaml).toContain("tunnel:");
    expect(yaml).toContain(`image: ${CLOUDFLARED_IMAGE}`);
    expect(yaml).toContain("http://agent:8787");
    expect(yaml).toContain(`NO_PROXY: "agent,localhost,127.0.0.1,\${NO_PROXY:-}"`);
    expect(yaml).toContain(`no_proxy: "agent,localhost,127.0.0.1,\${no_proxy:-}"`);
    expect(yaml).toContain('restart: "no"');
    const dockerfile = plan.artifacts.find((artifact) => artifact.path.endsWith("Dockerfile"))!.content;
    expect(dockerfile).not.toContain("cloudflared");
    expect(runbook(plan)).toContain("locally onboarded Slack auto-register");
  });

  it("omits webhook-only secrets and public paths for long-connection Feishu", () => {
    const plan = planDockerDeploy({
      ...base,
      modelAuth: undefined,
      channels: ["feishu"],
      longConnectionChannels: ["feishu"],
    });
    const yaml = compose(plan);
    expect(yaml).toContain("FEISHU_APP_ID");
    expect(yaml).toContain("FEISHU_APP_SECRET");
    expect(yaml).not.toContain("FEISHU_VERIFICATION_TOKEN");
    expect(runbook(plan)).not.toContain("https://<your-domain>/feishu");
  });

  it("commits secret NAMES/interpolation only, including the absent-only auth seed seam", () => {
    const yaml = compose(
      planDockerDeploy({
        ...base,
        modelAuth: "OPENAI_API_KEY",
        channels: ["telegram", "feishu"],
        extraSecrets: ["GH_TOKEN"],
      }),
    );
    for (const name of [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_SECRET_TOKEN",
      "FEISHU_APP_ID",
      "GH_TOKEN",
      "FASTAGENT_AUTH_SEED",
    ]) {
      expect(yaml).toContain(`${name}: "\${${name}:-}"`);
    }
    expect(yaml).not.toContain("<value>");
    expect(yaml).not.toContain("sk-");
  });

  it("namespaces embedded artifacts under .fastagent/ and builds from the workbench root", () => {
    const plan = planDockerDeploy({
      ...base,
      modelAuth: undefined,
      channels: [],
      embedded: true,
    });
    expect(plan.artifacts.map((artifact) => artifact.path).sort()).toEqual([
      ".dockerignore",
      ".fastagent/Dockerfile",
      ".fastagent/Dockerfile.dockerignore",
      ".fastagent/fastagent.compose.yml",
    ]);
    expect(plan.composePath).toBe(".fastagent/fastagent.compose.yml");
    expect(compose(plan)).toContain("context: ..");
    expect(compose(plan)).toContain("dockerfile: .fastagent/Dockerfile");
    expect(runbook(plan)).toContain("run from the WORKBENCH ROOT");
  });

  it("prints lifecycle + operator-owned ingress guidance for detected webhook channels", () => {
    const out = runbook(planDockerDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram", "github"] }));
    expect(out).toContain(`Docker Engine/Desktop with Compose >= ${MIN_DOCKER_COMPOSE_VERSION}`);
    expect(out).toContain("docker compose -f fastagent.compose.yml up -d --build");
    expect(out).toContain("down        # stops containers; keeps the state volume");
    expect(out).toContain("down -v   # DESTRUCTIVE");
    expect(out).toContain("Public ingress is operator-owned");
    expect(out).toContain("https://<your-domain>/telegram");
    expect(out).toContain("https://<your-domain>/webhook");
  });

  it("sanitizes a stable Compose project name and exposes default webhook paths", () => {
    expect(toDockerProjectName("My Agent!")).toBe("fastagent-my-agent");
    expect(toDockerProjectName("___")).toBe("fastagent-agent");
    expect(composeHasTunnelService("services:\n  tunnel:\n    image: cloudflare/cloudflared\n")).toBe(true);
    expect(composeHasTunnelService("services:\n    tunnel:\n        image: cloudflare/cloudflared\n")).toBe(true);
    expect(composeHasTunnelService("services:\n\ttunnel:\n\t\timage: cloudflare/cloudflared\n")).toBe(true);
    expect(composeHasTunnelService("services:\n  agent:\n")).toBe(false);
    expect(dockerWebhookPaths(["telegram", "github", "slack", "feishu", "lark"])).toEqual([
      "/telegram",
      "/webhook",
      "/slack",
      "/feishu",
      "/lark",
    ]);
  });
});
