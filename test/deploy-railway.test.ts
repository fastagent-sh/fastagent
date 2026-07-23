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
  hasTimeTriggers: false,
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

  it("kit layout (kitDir): railway.json namespaced + dockerfilePath into the kit + the dashboard config-path step", () => {
    const p = planRailwayDeploy({ ...base, modelAuth: undefined, channels: [], kitDir: "agent" });
    expect(p.artifacts.map((a) => a.path).sort()).toEqual([
      ".dockerignore",
      "agent/Dockerfile",
      "agent/Dockerfile.dockerignore",
      "agent/railway.json",
    ]);
    const cfg = JSON.parse(p.artifacts.find((a) => a.path === "agent/railway.json")?.content ?? "{}");
    expect(cfg.build.dockerfilePath).toBe("agent/Dockerfile"); // relative to the repo-root upload context
    expect(runbook(p)).toMatch(/Config-as-code/); // the dashboard-only pointer step is stated
    expect(runbook(p)).toMatch(/Write-back mechanics/);
  });

  it("ships the shared portable container (Dockerfile + .dockerignore), same as Fly", () => {
    const artifacts = planRailwayDeploy({ ...base, modelAuth: undefined, channels: [] }).artifacts;
    expect(artifacts.map((a) => a.path)).toEqual(["railway.json", "Dockerfile", ".dockerignore"]);
    // .git must stay an EFFECTIVE ignore line (a size/secret contract), never fumbled into a `# .git`
    // comment — that would silently ship the whole repo history into the image.
    const dockerignore = artifacts.find((a) => a.path === ".dockerignore")!.content;
    expect(dockerignore.split("\n")).toContain(".git");
    // Recursive on purpose: dockerignore patterns are root-anchored, and a repo-as-agent can hold
    // nested projects — bare `node_modules`/`.env` would bake their build-machine deps and secrets
    // into the image. `.git` stays root-anchored (asserted above) so nested repos' .git ships.
    expect(dockerignore).toMatch(/^\*\*\/node_modules$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
    expect(dockerignore).not.toMatch(/^\*\*\/\.git$/m);
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

  it("keeps Feishu/Lark Encrypt Keys optional in the runbook instead of deployment prerequisites", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["feishu", "lark"] }));
    const requiredCommand = out.split("\n").find((line) => line.startsWith("railway variables set OPENAI")) ?? "";
    expect(requiredCommand).toContain("FEISHU_APP_ID=<value>");
    expect(requiredCommand).toContain("LARK_VERIFICATION_TOKEN=<value>");
    expect(requiredCommand).not.toContain("FEISHU_ENCRYPT_KEY");
    expect(requiredCommand).not.toContain("LARK_ENCRYPT_KEY");
    expect(out).toContain("# railway variables set FEISHU_ENCRYPT_KEY=<value> LARK_ENCRYPT_KEY=<value>");
  });

  it("forbids App Sleeping and omits webhook-only setup for long-connection Lark", () => {
    const out = runbook(
      planRailwayDeploy({
        ...base,
        modelAuth: undefined,
        channels: ["lark"],
        longConnectionChannels: ["lark"],
      }),
    );
    expect(out).toContain("LARK_APP_ID=<value>");
    expect(out).toContain("LARK_APP_SECRET=<value>");
    expect(out).not.toContain("LARK_VERIFICATION_TOKEN");
    expect(out).not.toContain("Request URL = https://<your-domain>/lark");
    expect(out).toContain("do NOT enable App Sleeping — a long-connection channel");
  });

  it("forbids App Sleeping for a custom long-connection channel", () => {
    const out = runbook(
      planRailwayDeploy({
        ...base,
        modelAuth: undefined,
        channels: [],
        longConnectionChannels: ["socket"],
      }),
    );
    expect(out).toContain("do NOT enable App Sleeping — a long-connection channel");
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

  it("mints a domain and prints Slack's manual Events API Request URL", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["slack"] }));
    expect(out).toContain("railway domain");
    expect(out).toContain("SLACK_BOT_TOKEN=<value>");
    expect(out).toContain("https://<your-domain>/slack");
  });

  it("mints a domain and prints the Feishu Request URL for a feishu-only agent", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["feishu"] }));
    expect(out).toContain("railway domain");
    expect(out).toContain("POST /feishu");
    expect(out).toContain("https://<your-domain>/feishu");
    expect(out).not.toContain("https://<your-domain>/lark");
  });

  it("marks the setup one-time and names `railway up` as the whole redeploy (no dup service/volume)", () => {
    const out = runbook(planRailwayDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: [] }));
    // Re-running the setup silently makes a DUPLICATE service (Railway names aren't unique) + another
    // volume → split state; the banner must say skip-on-redeploy and that a redeploy is just `railway up`.
    expect(out).toMatch(/one-time setup/i);
    expect(out).toMatch(/redeploy is[\s\S]*railway up/i);
  });

  it("mints the domain ONCE and prints every path when all webhook channels are present", () => {
    const out = runbook(
      planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram", "github", "feishu", "lark"] }),
    );
    expect(out.match(/railway domain/g)).toHaveLength(1); // not once per channel
    expect(out).toContain("https://<your-domain>/feishu");
    expect(out).toContain("https://<your-domain>/lark");
  });

  it("states App Sleeping as a manual dashboard step; forbids it for github (no replay)", () => {
    expect(runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram"] }))).toContain(
      "App Sleeping",
    );
    // github: fire-and-forget reviews have no replay → do NOT sleep (same floor Fly enforces via config).
    expect(runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["github"] }))).toContain(
      "do NOT enable App Sleeping",
    );
    // time triggers: cron/wake has no external wake-up — a sleeping service sleeps through them.
    expect(
      runbook(planRailwayDeploy({ ...base, modelAuth: undefined, channels: ["telegram"], hasTimeTriggers: true })),
    ).toContain("do NOT enable App Sleeping");
  });

  it("turns a non-env auth label into guidance, not a variable (shared secret logic)", () => {
    for (const label of ["OAuth", "stored credential", "keychain"]) {
      const out = runbook(planRailwayDeploy({ ...base, modelAuth: label, channels: [] }));
      expect(out).not.toContain(`${label}=`); // never injected as a `variables set <label>=<value>` pair
      expect(out).toContain("Model auth");
    }
  });
});
