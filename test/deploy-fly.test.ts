import { describe, expect, it } from "vitest";
import { parseFlyAppName, parseFlyMinMachines, planFlyDeploy, toFlyAppName } from "../src/deploy/fly/plan.ts";
import { modelTravelIssue } from "../src/deploy/preflight.ts";

const flyToml = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "fly.toml")!.content;
const dockerfile = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "Dockerfile")!.content;
const runbook = (p: ReturnType<typeof planFlyDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code workspace with a lockfile, default autostop). */
const base = {
  appName: "bot",
  port: 8787,
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  autostop: "suspend",
  scaleToZero: true,
  hasTimeTriggers: false,
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
    expect(flyToml(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], hasTimeTriggers: true }))).toContain(
      "min_machines_running = 1", // schedules/wake need a running machine — no external wake-up for a cron instant
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

  it("computes the secret list from the model key + discovered channels + config deploy.secrets", () => {
    const out = runbook(
      planFlyDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"], extraSecrets: ["GH_TOKEN"] }),
    );
    expect(out).toContain("OPENAI_API_KEY=");
    expect(out).toContain("TELEGRAM_BOT_TOKEN=");
    expect(out).toContain("TELEGRAM_SECRET_TOKEN=");
    expect(out).toContain("GH_TOKEN="); // G4: an agent-declared extra secret joins the list
    // the fastagent-only post step: point the webhook at the live URL
    expect(out).toContain("https://bot.fly.dev/telegram");
  });

  it("keeps Feishu/Lark Encrypt Keys optional in the runbook instead of deployment prerequisites", () => {
    const out = runbook(planFlyDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["feishu", "lark"] }));
    const requiredCommand = out.split("\n").find((line) => line.startsWith("fly secrets set")) ?? "";
    expect(requiredCommand).toContain("FEISHU_APP_ID=<value>");
    expect(requiredCommand).toContain("LARK_VERIFICATION_TOKEN=<value>");
    expect(requiredCommand).not.toContain("FEISHU_ENCRYPT_KEY");
    expect(requiredCommand).not.toContain("LARK_ENCRYPT_KEY");
    expect(out).toContain("# fly secrets set --app bot FEISHU_ENCRYPT_KEY=<value> LARK_ENCRYPT_KEY=<value>");
  });

  it("prints one event Request URL for each mounted Feishu-cloud kind", () => {
    const feishu = runbook(planFlyDeploy({ ...base, modelAuth: undefined, channels: ["feishu"] }));
    expect(feishu).toContain("POST /feishu");
    expect(feishu).toContain("https://bot.fly.dev/feishu");
    expect(feishu).not.toContain("https://bot.fly.dev/lark");

    const both = runbook(planFlyDeploy({ ...base, modelAuth: undefined, channels: ["feishu", "lark"] }));
    expect(both).toContain("https://bot.fly.dev/feishu");
    expect(both).toContain("https://bot.fly.dev/lark");
  });

  it("bakes config deploy.apt into the generated Dockerfile (G6 — system tools the agent's tools need)", () => {
    const docker = dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], apt: ["git", "ripgrep"] }));
    expect(docker).toMatch(/apt-get install -y --no-install-recommends git ripgrep/);
    // omitted when no apt declared: no apt layer at all
    expect(dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [] }))).not.toContain("apt-get");
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
    expect(docker).toContain("npm i -g @fastagent-sh/fastagent@9.9.9");
    expect(docker).not.toContain("npm ci");
  });

  it("markdown path ALWAYS uses node:22-slim (npm i -g), even if runtime is somehow bun (oven/bun has no npm)", () => {
    const docker = dockerfile(
      planFlyDeploy({
        ...base,
        modelAuth: undefined,
        channels: [],
        hasPackageJson: false,
        runtime: "bun",
        bunVersion: "1.3.13",
      }),
    );
    expect(docker).toContain("FROM node:22-slim"); // never oven/bun — the global npm i -g needs npm
    expect(docker).not.toContain("oven/bun");
    expect(docker).toContain("npm i -g @fastagent-sh/fastagent");
  });

  it("kit layout (kitDir): artifacts namespaced under the kit, kit deps installed, .git shipped, explicit deploy flags", () => {
    const p = planFlyDeploy({ ...base, modelAuth: undefined, channels: [], kitDir: "agent" });
    // Artifacts never collide with the host repo's own deploy files.
    expect(p.artifacts.map((a) => a.path).sort()).toEqual([
      ".dockerignore", // ROOT form — the only one host context-packers reliably read (kept if the host has one)
      "agent/Dockerfile",
      "agent/Dockerfile.dockerignore",
      "agent/fly.toml",
    ]);
    // Both ignore forms carry the same kit content (recursive patterns, .git not excluded).
    const rootIgnore = p.artifacts.find((a) => a.path === ".dockerignore")?.content ?? "";
    expect(rootIgnore).toMatch(/^\*\*\/node_modules$/m);
    expect(rootIgnore).not.toMatch(/^\.git$/m);
    const df = p.artifacts.find((a) => a.path === "agent/Dockerfile")?.content ?? "";
    expect(df).toContain("COPY agent/package.json agent/package-lock.json* ./agent/"); // kit deps…
    expect(df).toContain("cd agent && npm ci");
    expect(df).toContain("COPY . ."); // …then the whole repo as the workspace
    expect(df).toContain(`"./agent/node_modules/.bin/fastagent", "start", "/app"`); // runs from the kit
    const ignore = p.artifacts.find((a) => a.path === "agent/Dockerfile.dockerignore")?.content ?? "";
    expect(ignore).not.toMatch(/^\.git$/m); // write-back needs the repo's .git — NOT excluded
    // Recursive on purpose: dockerignore is root-anchored, and a bare `node_modules` would let the build
    // machine's agent/node_modules (macOS binaries) clobber the image's freshly-installed linux deps.
    expect(ignore).toMatch(/^\*\*\/node_modules$/m);
    expect(ignore).toMatch(/^\*\*\/\.env$/m);
    // The runbook deploys from the repo root with explicit, version-proof flags.
    expect(runbook(p)).toContain("fly deploy . --config agent/fly.toml --dockerfile agent/Dockerfile --app bot");
    expect(runbook(p)).toMatch(/Write-back mechanics/);
  });

  it("kit layout: bun kit uses the bun base + cd-install + bun run; markdown-only kit uses the pinned global CLI", () => {
    const bun = planFlyDeploy({
      ...base,
      runtime: "bun",
      bunVersion: "1.3.13",
      modelAuth: undefined,
      channels: [],
      kitDir: "agent",
    });
    const bunDf = bun.artifacts.find((a) => a.path === "agent/Dockerfile")?.content ?? "";
    expect(bunDf).toContain("FROM oven/bun:1.3.13");
    expect(bunDf).toContain("COPY agent/package.json agent/bun.lock* ./agent/");
    expect(bunDf).toContain("cd agent && bun install --frozen-lockfile");
    expect(bunDf).toContain(`"sh", "-c", "cd agent && bun run fastagent start /app"`);

    const md = planFlyDeploy({
      ...base,
      hasPackageJson: false,
      modelAuth: undefined,
      channels: [],
      kitDir: "agent",
    });
    const mdDf = md.artifacts.find((a) => a.path === "agent/Dockerfile")?.content ?? "";
    expect(mdDf).toContain("FROM node:22-slim");
    expect(mdDf).toContain("npm i -g @fastagent-sh/fastagent@9.9.9"); // pinned global — no kit deps to install
    expect(mdDf).not.toContain("npm ci");
    expect(mdDf).toContain(`["fastagent", "start", "/app"]`);
  });

  it("falls back to npm install when a code workspace has no lockfile (npm ci would hard-fail)", () => {
    expect(dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [], hasLockfile: false }))).toMatch(
      /RUN npm install\n/, // no lockfile → npm install; all deps (no --omit=dev — the agent needs its toolchain)
    );
    expect(dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [] }))).toMatch(/RUN npm ci\n/);
  });

  it("code-workspace CMD runs the LOCAL bin, never npx/bunx (bare `fastagent` on npm is a third party)", () => {
    const npm = dockerfile(planFlyDeploy({ ...base, modelAuth: undefined, channels: [] }));
    expect(npm).toContain('CMD ["./node_modules/.bin/fastagent", "start", "/app"]');
    expect(npm).not.toContain("npx");
  });

  it("generates a Bun Dockerfile for a bun workspace (oven/bun base, bun install, bun run)", () => {
    const bun = dockerfile(
      planFlyDeploy({ ...base, modelAuth: undefined, channels: [], runtime: "bun", bunVersion: "1.3.13" }),
    );
    expect(bun).toContain("FROM oven/bun:1.3.13");
    expect(bun).toContain("bun install --frozen-lockfile"); // base.hasLockfile: true → frozen
    // The LOCAL bin, never the registry — the npm package named `fastagent` is an unrelated third party.
    expect(bun).toContain('CMD ["bun", "run", "fastagent", "start", "/app"]');
    expect(bun).not.toContain("node:22-slim");
    // Unpinned bun (a bun lockfile but no packageManager version) → oven/bun:1; no lockfile → plain install.
    const unpinned = dockerfile(
      planFlyDeploy({ ...base, modelAuth: undefined, channels: [], runtime: "bun", hasLockfile: false }),
    );
    expect(unpinned).toContain("FROM oven/bun:1\n");
    expect(unpinned).toMatch(/RUN bun install\n/); // no --frozen-lockfile without a lockfile
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

  it("parses min_machines_running from a kept fly.toml (the KEEP-mode time-trigger check)", () => {
    expect(parseFlyMinMachines("  min_machines_running = 0         # scale to zero")).toBe(0); // explicit 0 → warn/gate
    expect(parseFlyMinMachines("  min_machines_running = 1         # kept running")).toBe(1); // ≥ 1 → fine
    // Absent line → undefined; the CALLER treats it as 0 (Fly's platform default) — a hand-written
    // fly.toml without the line scales to zero exactly like an explicit 0.
    expect(parseFlyMinMachines('app = "bot"\nprimary_region = "iad"')).toBeUndefined();
  });
});
