import { describe, expect, it } from "vitest";
import { planRailwayDeploy } from "../src/deploy/railway/plan.ts";

const json = (p: ReturnType<typeof planRailwayDeploy>) => p.artifacts.find((a) => a.path === "railway.json")!.content;
const runbook = (p: ReturnType<typeof planRailwayDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code workspace with a lockfile). */
const base = {
  serviceName: "bot",
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
} as const;

describe("deploy/railway: planRailwayDeploy", () => {
  it("generates a thin railway.json — build from Dockerfile, healthcheck /health (no boot-race routing)", () => {
    const j = JSON.parse(json(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] })));
    expect(j.build.builder).toBe("DOCKERFILE");
    expect(j.deploy.healthcheckPath).toBe("/health");
    expect(j.deploy.restartPolicyType).toBe("ON_FAILURE");
    // Thin on purpose: no env/volume/sleeping in the file — those are CLI/dashboard service settings.
    expect(json(planRailwayDeploy({ ...base, modelAuth: undefined, channels: [] }))).not.toContain("FASTAGENT");
  });

  it("ships the shared portable container (Dockerfile + .dockerignore), same as Fly", () => {
    const artifacts = planRailwayDeploy({ ...base, modelAuth: undefined, channels: [] }).artifacts;
    expect(artifacts.map((a) => a.path)).toEqual(["railway.json", "Dockerfile", ".dockerignore"]);
    // .git must stay an EFFECTIVE ignore line (a size/secret contract), never fumbled into a `# .git`
    // comment — that would silently ship the whole repo history into the image.
    const dockerignore = artifacts.find((a) => a.path === ".dockerignore")!.content;
    expect(dockerignore.split("\n")).toContain(".git");
  });

  it("sets the state root as a variable matched to the volume mount, + the secret list", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"] }));
    expect(out).toContain("railway volume add --mount-path /data");
    // `set` subcommand, NOT the deprecated `--set` legacy flag; secrets space-separated in one command.
    expect(out).toContain("railway variables set FASTAGENT_STATE_DIR=/data");
    expect(out).toContain(
      "railway variables set OPENAI_API_KEY=<value> TELEGRAM_BOT_TOKEN=<value> TELEGRAM_SECRET_TOKEN=<value>",
    );
    expect(out).not.toContain("--set"); // deprecated form must be gone everywhere
  });

  it("creates the service, and orders it before the service-scoped volume/variables/up (Railway model)", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] }));
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

  it("points the webhook at the MINTED domain (railway domain), not a precomputed URL", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram"] }));
    expect(out).toContain("railway domain"); // must generate + read the domain first
    expect(out).toContain("https://<your-domain>/telegram"); // placeholder, not a deterministic guess
    expect(out).not.toContain(".fly.dev");
  });

  it("marks the setup one-time and names `railway up` as the whole redeploy (no dup service/volume)", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] }));
    // Re-running the setup silently makes a DUPLICATE service (Railway names aren't unique) + another
    // volume → split state; the banner must say skip-on-redeploy and that a redeploy is just `railway up`.
    expect(out).toMatch(/one-time setup/i);
    expect(out).toMatch(/redeploy is[\s\S]*railway up/i);
  });

  it("mints the domain ONCE even when both webhook channels are present", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram", "github"] }));
    expect(out.match(/railway domain/g)).toHaveLength(1); // not once per channel
  });

  it("states App Sleeping as a manual dashboard step; forbids it for github (no replay)", () => {
    expect(runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram"] }))).toContain(
      "App Sleeping",
    );
    // github: fire-and-forget reviews have no replay → do NOT sleep (same floor Fly enforces via config).
    expect(runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["github"] }))).toContain(
      "do NOT enable App Sleeping",
    );
  });

  it("turns a non-env auth label into guidance, not a variable (shared secret logic)", () => {
    for (const label of ["OAuth", "stored credential", "keychain"]) {
      const out = runbook(planRailwayDeploy({ ...base, modelAuth: label, channels: [] }));
      expect(out).not.toContain(`${label}=`); // never injected as a `variables set <label>=<value>` pair
      expect(out).toContain("Model auth");
    }
  });
});
