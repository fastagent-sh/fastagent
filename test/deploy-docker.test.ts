import { describe, expect, it } from "vitest";
import {
  CLOUDFLARED_IMAGE,
  MIN_DOCKER_COMPOSE_VERSION,
  composeHasTunnelService,
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
  agentPrefix: "fastagent/",
  valueFile: "fastagent/.secrets/.env",
  valueFileExists: true,
  projectName: "fastagent-bot",
  port: 8787,
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  tunnel: false,
} as const;

describe("deploy/docker: planDockerDeploy", () => {
  it("asks for no container privilege: the volume is a local disk, nothing needs mounting", () => {
    const yaml = compose(planDockerDeploy({ ...base, modelAuth: undefined, channels: [] }));
    expect(yaml).not.toContain("SYS_ADMIN");
    expect(yaml).not.toContain("apparmor");
  });
  it("generates only the app topology: loopback port + persistent state, no tunnel/ingress coupling", () => {
    const plan = planDockerDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: declaredChannels(["telegram"]) });
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      "fastagent/fastagent.compose.yml",
      "fastagent/fastagent.release.json",
      "fastagent/Dockerfile",
      ".dockerignore",
      "fastagent/Dockerfile.dockerignore",
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
      channels: declaredChannels(["telegram"]),
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
      channels: [...declaredChannels(["feishu"], "long-connection")],
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
        channels: declaredChannels(["telegram", "feishu"]),
        extraSecrets: [{ name: "GH_TOKEN", source: "tools/gh.ts" }],
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

  it("namespaces artifacts under fastagent/ and builds from the workspace root", () => {
    const plan = planDockerDeploy({ ...base, modelAuth: undefined, channels: [] });
    expect(plan.artifacts.map((artifact) => artifact.path).sort()).toEqual([
      ".dockerignore",
      "fastagent/Dockerfile",
      "fastagent/Dockerfile.dockerignore",
      "fastagent/fastagent.compose.yml",
      "fastagent/fastagent.release.json",
    ]);
    expect(plan.composePath).toBe("fastagent/fastagent.compose.yml");
    expect(compose(plan)).toContain("context: ..");
    expect(compose(plan)).toContain("dockerfile: fastagent/Dockerfile");
    expect(runbook(plan)).toContain("Run from the WORKSPACE ROOT");
  });

  it("omits --env-file when the value file does not exist yet, and says why", () => {
    // `fastagent init` writes .env.example, not .env, so an OAuth-only agent has no value file. `--env-file` on a
    // missing path is `couldn't find env file: …`, which would take the whole runbook's `up` down with it.
    const out = runbook(
      planDockerDeploy({
        ...base,
        valueFileExists: false,
        modelAuth: "OPENAI_API_KEY",
        channels: declaredChannels(["telegram"]),
      }),
    );
    expect(out).toContain("docker compose -f fastagent/fastagent.compose.yml up -d --build");
    expect(out).not.toContain("docker compose --env-file"); // the note mentions the flag; no command uses it
    expect(out).toMatch(/does not exist yet.*--env-file fails on a missing path/s);
  });

  it("prints lifecycle + operator-owned ingress guidance for detected webhook channels", () => {
    const out = runbook(
      planDockerDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: declaredChannels(["telegram", "github"]) }),
    );
    expect(out).toContain(`Docker Engine/Desktop with Compose >= ${MIN_DOCKER_COMPOSE_VERSION}`);
    expect(out).toContain(
      "docker compose --env-file 'fastagent/.secrets/.env' -f fastagent/fastagent.compose.yml up -d --build",
    );
    // ONLY `up` interpolates, so only `up` carries --env-file: `--env-file` is a hard failure on a missing path,
    // and these three need no values at all.
    for (const cmd of ["logs -f agent", "ps", "down"]) {
      expect(out).toContain(`docker compose -f fastagent/fastagent.compose.yml ${cmd}`);
    }
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
    expect(webhookPaths(declaredChannels(["telegram", "github", "slack", "feishu", "lark"]))).toEqual([
      "/telegram",
      "/webhook",
      "/slack",
      "/feishu",
      "/lark",
    ]);
  });
});
