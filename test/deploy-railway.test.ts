import { describe, expect, it } from "vitest";
import { planRailwayDeploy, toRailwayName } from "../src/deploy/railway/plan.ts";
import { declaredChannels } from "../src/channels/discover.ts";

const runbook = (p: ReturnType<typeof planRailwayDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code agent with a lockfile). */
const base = {
  releaseId: "release-one",
  agent: "reviewer",
  serviceName: "bot",
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  hasCron: false,
} as const;

describe("deploy/railway: planRailwayDeploy", () => {
  it("generates no Railway config file: Railway builds the root Dockerfile, and the runbook says /health is not waited for", () => {
    const p = planRailwayDeploy({ ...base, channels: [] });
    expect(p.artifacts.map((a) => a.path)).not.toContain("railway.json");
    expect(runbook(p)).not.toMatch(/railway\.json|RAILWAY_DOCKERFILE_PATH|Config-as-code/);
    expect(runbook(p)).toContain("Railway builds the\n# Dockerfile at its root");
    expect(runbook(p)).toContain("without waiting for\n# /health");
    expect(runbook(p)).toContain(
      "railway variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets\n",
    );
    expect(runbook(p)).toContain("each release replaces /data/definition");
  });

  it("ships the shared portable container (Dockerfile + .dockerignore), same as Fly", () => {
    const artifacts = planRailwayDeploy({ ...base, channels: [] }).artifacts;
    expect(artifacts.map((a) => a.path)).toEqual([
      "fastagent.release.json",
      "Dockerfile",
      ".dockerignore",
      "Dockerfile.dockerignore",
    ]);
    // .git is deliberately SHIPPED (the agent's pull/push loop needs it) — the exclusion must not
    // creep back in silently; machinery/secret excludes are the hard contract instead.
    const dockerignore = artifacts.find((a) => a.path === ".dockerignore")!.content;
    expect(dockerignore.split("\n")).not.toContain(".git");
    // Recursive on purpose: dockerignore patterns are root-anchored, and a repo-as-agent can hold
    // nested projects — bare `node_modules`/`.env` would bake their build-machine deps and secrets
    // into the image.
    expect(dockerignore).toMatch(/^\*\*\/node_modules$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.secrets\/\*\*$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.state$/m);
    expect(dockerignore).not.toMatch(/^\*\*\/\.git$/m);
  });

  it("sets the state root as a variable matched to the volume mount, + the secret list", () => {
    const out = runbook(
      planRailwayDeploy({
        ...base,
        channels: declaredChannels(["telegram"]),
        secrets: [
          { name: "OPENAI_API_KEY", hint: "your model provider key" },
          { name: "TELEGRAM_BOT_TOKEN", hint: "required by channels/telegram.ts" },
        ],
      }),
    );
    expect(out).toContain("railway volume add --mount-path /data");
    // `set` subcommand, NOT the deprecated `--set` legacy flag; secrets space-separated in one command.
    expect(out).toContain(
      "railway variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets",
    );
    expect(out).toContain("railway variables set OPENAI_API_KEY=<value> TELEGRAM_BOT_TOKEN=<value>");
    expect(out).not.toContain("--set"); // deprecated form must be gone everywhere
  });

  it("forbids App Sleeping and omits webhook-only setup for long-connection Lark", () => {
    const out = runbook(
      planRailwayDeploy({
        ...base,
        channels: [...declaredChannels(["lark"], "long-connection")],
      }),
    );
    expect(out).not.toContain("Request URL = https://<your-domain>/lark");
    expect(out).toContain("do NOT enable App Sleeping — a long-connection channel");
  });

  it("forbids App Sleeping for a custom long-connection channel", () => {
    const out = runbook(
      planRailwayDeploy({
        ...base,
        channels: declaredChannels(["socket"], "long-connection"),
      }),
    );
    expect(out).toContain("do NOT enable App Sleeping — a long-connection channel");
  });

  it("creates the service, and orders it before the service-scoped volume/variables/up (Railway model)", () => {
    const out = runbook(planRailwayDeploy({ ...base, channels: [] }));
    // railway init makes only a project; the service must exist before volume/variables/up.
    expect(out).toContain("railway add --service bot");
    // Anchor to line-start commands (\n prefix): comments reference `railway up` in backticks, so a bare
    // indexOf would match the prose, not the command.
    const order = (cmd: string) => out.indexOf(`\n${cmd}`);
    expect(order("railway init")).toBeLessThan(order("railway add --service bot"));
    expect(order("railway add --service bot")).toBeLessThan(order("railway volume add"));
    expect(order("railway volume add")).toBeLessThan(order("railway variables set"));
    expect(order("railway variables set")).toBeLessThan(order("railway up")); // vars before first deploy
  });

  // WHICH webhook steps a runbook carries is webhookRunbook's — deploy-channel-ingress owns that. What
  // is railway's is that they are spelled against a domain minted ONCE, never a precomputed URL.
  it("mints the domain ONCE and spells every webhook step at that placeholder", () => {
    const out = runbook(planRailwayDeploy({ ...base, channels: declaredChannels(["telegram", "slack", "feishu"]) }));
    expect(out.match(/railway domain/g)).toHaveLength(1); // minted first, and not once per channel
    expect(out).toContain("https://<your-domain>/telegram"); // placeholder, not a deterministic guess
    expect(out).toContain("https://<your-domain>/slack");
    expect(out).toContain("https://<your-domain>/feishu");
    expect(out).not.toContain("https://<your-domain>/lark"); // only what is mounted
    expect(out).not.toContain(".fly.dev");
  });

  it("separates one-time setup from release regeneration and upload", () => {
    const out = runbook(planRailwayDeploy({ ...base, channels: [] }));
    expect(out).toMatch(/one-time setup/i);
    expect(out).toMatch(/fastagent deploy railway[\s\S]*railway up/);
  });

  it("states App Sleeping as a manual dashboard step; forbids it for time triggers", () => {
    expect(runbook(planRailwayDeploy({ ...base, channels: declaredChannels(["telegram"]) }))).toContain("App Sleeping");
    // time triggers: cron/wake has no external wake-up — a sleeping service sleeps through them.
    expect(
      runbook(
        planRailwayDeploy({
          ...base,
          channels: declaredChannels(["telegram"]),
          hasCron: true,
        }),
      ),
    ).toContain("do NOT enable App Sleeping");
  });

  it("toRailwayName survives `railway add --service <name>` — and never yields an empty argument", () => {
    // The live probe tears down the project by the name the CLI creates, so both go through this.
    expect(toRailwayName("fastagent-live-a1b2c3d4")).toBe("fastagent-live-a1b2c3d4"); // the probe's own
    expect(toRailwayName("My Agent (v2)")).toBe("My-Agent-v2");
    expect(toRailwayName("___")).toBe("agent"); // nothing left to name it with
  });

  it("a credential that does not travel is a login on the box, after the deploy", () => {
    const out = runbook(planRailwayDeploy({ ...base, boxLogin: "openai-codex", channels: [] }));
    expect(out.indexOf("fastagent login openai-codex --deployment railway")).toBeGreaterThan(out.indexOf("railway up"));
    expect(runbook(planRailwayDeploy({ ...base, channels: [] }))).not.toContain("login --deployment");
  });
});
