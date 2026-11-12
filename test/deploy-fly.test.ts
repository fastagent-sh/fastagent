import { describe, expect, it } from "vitest";
import { planFlyDeploy } from "../src/deploy/fly/plan.ts";
import { declaredChannels } from "../src/channels/discover.ts";

const flyToml = (p: ReturnType<typeof planFlyDeploy>) =>
  p.artifacts.find((a) => a.path === "fly.reviewer.toml")!.content;

/** Defaults for the fields a test doesn't care about (a code agent with a lockfile). */
const base = {
  config: "{}",
  agent: "reviewer",
  appName: "bot",
  port: 8787,
  runtime: "node",
  hasLockfile: true,
  hasCron: false,
} as const;

describe("deploy/fly: planFlyDeploy", () => {
  it("wires the state root to the volume and tunes autostop to suspend", () => {
    const toml = flyToml(planFlyDeploy({ ...base, channels: [] }));
    expect(toml).toContain('FASTAGENT_STATE_DIR = "/data/.state"');
    expect(toml).toContain('FASTAGENT_SECRETS_DIR = "/data/.secrets"');
    expect(toml).toContain('destination = "/data"');
    expect(toml).toContain('auto_stop_machines = "suspend"');
    expect(toml).toContain("min_machines_running = 0");
    expect(toml).toContain("internal_port = 8787");
  });

  it("keeps one machine running for a cron, scales to zero otherwise (definition-aware)", () => {
    expect(flyToml(planFlyDeploy({ ...base, channels: [], hasCron: true }))).toContain(
      "min_machines_running = 1", // schedules need a running machine — no external wake-up for a cron instant
    );
    expect(flyToml(planFlyDeploy({ ...base, channels: declaredChannels(["telegram"]) }))).toContain(
      "min_machines_running = 0",
    );
  });
});
