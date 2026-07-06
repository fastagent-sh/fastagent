import { describe, expect, it } from "vitest";
import { modelTravelIssue, parseFlyAppName, planFlyDeploy, toFlyAppName } from "../src/deploy/fly.ts";

const flyToml = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "fly.toml")!.content;
const dockerfile = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "Dockerfile")!.content;
const runbook = (p: ReturnType<typeof planFlyDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code workspace with a lockfile, default autostop). */
const base = {
  appName: "bot",
  port: 8787,
  hasPackageJson: true,
  hasLockfile: true,
  version: "9.9.9",
  autostop: "suspend",
  scaleToZero: true,
} as const;

describe("deploy/fly: planFlyDeploy", () => {
  it("wires the state root to the volume and tunes autostop to suspend", () => {
    const toml = flyToml(planFlyDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] }));
    expect(toml).toContain('FASTAGENT_STATE_DIR = "/data"');
    expect(toml).toContain('destination = "/data"');
    expect(toml).toContain('auto_stop_machines = "suspend"');
    expect(toml).toContain("min_machines_running = 0");
    expect(toml).toContain("internal_port = 8787");
  });

  it("keeps one machine running for github (no replay), scales to zero otherwise (definition-aware)", () => {
    expect(flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: ["github"] }))).toContain(
      "min_machines_running = 1",
    );
    expect(flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: ["telegram"] }))).toContain(
      "min_machines_running = 0",
    );
  });

  it("--stop and --no-scale-to-zero flags shape the generated autostop", () => {
    const stopped = flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], autostop: "stop" }));
    expect(stopped).toContain('auto_stop_machines = "stop"');
    const kept = flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], scaleToZero: false }));
    expect(kept).toContain("min_machines_running = 1");
    expect(kept).toContain("--no-scale-to-zero"); // reason-tagged comment, not the github one
    // default is suspend + scale-to-zero
    const def = flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: [] }));
    expect(def).toContain('auto_stop_machines = "suspend"');
    expect(def).toContain("min_machines_running = 0");
  });

  it("computes the secret list from the model key + discovered channels", () => {
    const out = runbook(planFlyDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"] }));
    expect(out).toContain("OPENAI_API_KEY=");
    expect(out).toContain("TELEGRAM_BOT_TOKEN=");
    expect(out).toContain("TELEGRAM_SECRET_TOKEN=");
    // the fastagent-only post step: point the webhook at the live URL
    expect(out).toContain("https://bot.fly.dev/telegram");
  });

  it("turns a non-env auth label into guidance, not a secret (positive env-name match)", () => {
    // OAuth, stored credential, or any future non-UPPER_SNAKE label → guidance, never a fake secret.
    for (const label of ["OAuth", "stored credential", "keychain"]) {
      const out = runbook(planFlyDeploy({ ...base, modelAuth: label, channels: [] }));
      expect(out).not.toContain(`${label}=`);
      expect(out).toContain("Model auth");
    }
  });

  it("keeps the region single-sourced in fly.toml — the volume command references it, never a 2nd literal", () => {
    const p = planFlyDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] });
    expect(flyToml(p)).toContain("primary_region");
    expect(runbook(p)).toContain("--region <region>"); // placeholder, not a hardcoded 2nd region that could drift
  });

  it("pins the global-install Dockerfile to the current version for a pure markdown agent", () => {
    const docker = dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], hasPackageJson: false }));
    expect(docker).toContain("npm i -g @kid7st/fastagent@9.9.9");
    expect(docker).not.toContain("npm ci");
  });

  it("falls back to npm install when a code workspace has no lockfile (npm ci would hard-fail)", () => {
    expect(dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], hasLockfile: false }))).toContain(
      "npm install --omit=dev",
    );
    expect(dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [] }))).toContain("npm ci --omit=dev");
  });

  it("flags a model that won't travel — config.model is the deployed box's only source", () => {
    // A model in config.ts travels (in the image) → no issue.
    expect(modelTravelIssue("openai/gpt-4o", "openai/gpt-4o")).toBeUndefined();
    // Resolved from env/flag but NOT in config → won't reach the box; the message names config.ts + the spec.
    expect(modelTravelIssue(undefined, "openai/gpt-4o")).toMatch(/fastagent\.config\.ts.*openai\/gpt-4o/s);
    // No model at all.
    expect(modelTravelIssue(undefined, undefined)).toMatch(/no model/);
  });

  it("sanitizes a dir basename into a valid Fly app name", () => {
    expect(toFlyAppName("My Agent")).toBe("my-agent");
    expect(toFlyAppName("123bot")).toBe("app-123bot"); // must start with a letter
    expect(toFlyAppName("weird_@_name")).toBe("weird-name");
  });

  it("parses the app name from a kept fly.toml (double OR single quotes; else undefined)", () => {
    expect(parseFlyAppName('app = "renamed-bot"\nprimary_region = "iad"')).toBe("renamed-bot");
    expect(parseFlyAppName("app = 'single-quoted'")).toBe("single-quoted"); // TOML allows single quotes
    expect(parseFlyAppName('primary_region = "iad"')).toBeUndefined(); // no app line → caller uses basename
  });
});
