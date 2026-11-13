import { describe, expect, it } from "vitest";
import { planRailwayDeploy } from "../../../src/deploy/railway/plan.ts";
import { declaredChannels } from "../../../src/channels/discover.ts";

const runbook = (p: ReturnType<typeof planRailwayDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code agent with a lockfile). */
const base = {
  config: "{}",
  agent: "reviewer",
  serviceName: "bot",
  runtime: "node",
  hasLockfile: true,
  hasCron: false,
} as const;

describe("deploy/railway: planRailwayDeploy", () => {
  it("ships the shared portable container (Dockerfile + .dockerignore), same as Fly", () => {
    const artifacts = planRailwayDeploy({ ...base, channels: [] }).artifacts;
    expect(artifacts.map((a) => a.path)).toEqual(["Dockerfile", ".dockerignore", ".railwayignore"]);
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
});
