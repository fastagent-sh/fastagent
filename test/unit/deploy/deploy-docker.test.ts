import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { planDockerDeploy } from "../../../src/deploy/docker/plan.ts";
import { declaredChannels } from "../../../src/channels/discover.ts";

const compose = (plan: ReturnType<typeof planDockerDeploy>) =>
  plan.artifacts.find((artifact) => artifact.path.endsWith("fastagent.bot.compose.yml"))!.content;

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
});
