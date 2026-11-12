import { describe, expect, it, vi } from "vitest";
import { type RailwayRunPlan, deployRailwayRun } from "../src/deploy/railway/run.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { declaredChannels } from "../src/channels/discover.ts";
import { boxReporting } from "./box-webhooks.ts";

/** `railway volume list --json` as the CLI prints it: the whole project's volumes. */
const volumes = (...vs: { serviceName: string | null; mountPath?: string; status?: string }[]) =>
  JSON.stringify({ volumes: vs.map((v) => ({ mountPath: "/data", status: "Ready", ...v })) });

/**
 * A fake railway CLI: records every call, returns per-command scripted results (default code 0, empty). A
 * `volume list` the script does not answer behaves like the project's: nothing on `bot` until `volume add`, then
 * the new volume listed on it.
 */
function fakeRailway(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  let added = false;
  const railway: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    if (args[0] === "volume" && args[1] === "add" && (r.code ?? 0) === 0) added = true;
    if (args[0] === "volume" && args[1] === "list" && r.stdout === undefined) {
      return { code: r.code ?? 0, stdout: added ? volumes({ serviceName: "bot" }) : volumes() };
    }
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  };
  return { railway, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const plan = (over: Partial<RailwayRunPlan> = {}): RailwayRunPlan => ({
  name: "bot",
  mountPath: "/data",
  provideSecrets: async () => undefined,
  channels: [],
  intoLinked: false,
  forAgent: "fastagent deploy railway ../bot --into-linked --run --json",
  delivery: (url) => ({ variables: { FASTAGENT_NAME: "bot", FASTAGENT_CONFIG_JSON: "{}" }, publicUrl: url }),
  ...over,
});

// A minted domain, as `railway domain --json` would return it (field name unknown → parser scans values).
const DOMAIN_JSON = JSON.stringify({ domain: "bot-production.up.railway.app" });

/** Healthy by default: every test but the readiness one is about the railway sequence, not the probe. */
const run = (
  p: RailwayRunPlan,
  railway: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
  healthy: () => Promise<boolean> = async () => true,
) =>
  deployRailwayRun(
    p,
    railway,
    () => {},
    {},
    healthy,
    async () => {},
    boxReporting({ telegram: tg }),
  );

describe("deploy/railway/run: the coding-agent deploy journey (benchmark)", () => {
  it("fresh (unlinked): auth → init+add+volume → variables → domain → up → telegram webhook", async () => {
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" }; // unlinked → create
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const delivered: { url: string; before: string[] }[] = [];
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
        delivery: (url) => {
          delivered.push({ url, before: cmds() });
          return {
            variables: { FASTAGENT_NAME: "bot", FASTAGENT_CONFIG_JSON: `{"http":{"publicUrl":"${url}"}}` },
            publicUrl: url,
          };
        },
      }),
      railway,
      tg,
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    // Delivered before the upload, as service variables: the box reads them when it starts.
    expect(delivered).toEqual([
      { url: "https://bot-production.up.railway.app", before: expect.not.arrayContaining(["up --ci --service bot"]) },
    ]);
    expect(cmds()).toEqual([
      "whoami",
      "status --json",
      "init --name bot",
      "add --service bot --variables FASTAGENT_STATE_DIR=/data/.state", // a bare `add` prompts in a terminal
      "variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets --service bot", // first --service cmd, BEFORE the volume
      "volume list --json",
      "volume add --mount-path /data",
      "volume list --json", // attached to `bot` and Ready before the deploy that needs it
      // The domain before the upload, so the box is given it as its http.publicUrl.
      "domain --json --service bot",
      // `railway up` follows, so the variables alone would only be a second deploy.
      'variables set FASTAGENT_NAME=bot FASTAGENT_CONFIG_JSON={"http":{"publicUrl":"https://bot-production.up.railway.app"}} --skip-deploys --service bot',
      "up --ci --service bot", // bare `domain` only — NOT `domain list` (destructive on older CLIs)
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot-production.up.railway.app");
  });

  it("gate (SAFETY): a linked dir WITHOUT --into-linked is refused before any side effect — names the project", async () => {
    // The near-miss: the dir is linked to an unrelated/production project. `--run` only creates on an
    // unlinked dir, so a link is refused; the gate names the project so the operator sees it isn't theirs.
    const { railway, cmds } = fakeRailway((a) =>
      a[0] === "status" ? { stdout: JSON.stringify({ name: "prod-app", id: "prod-99" }) } : {},
    );
    const out = await run(plan(), railway);
    expect(out.ok).toBe(false);
    const gate = out.ok ? "" : out.gate;
    expect(gate).toContain("prod-app"); // names the linked project so it's recognizable as not-theirs
    expect(gate).toMatch(/--into-linked/); // and how to proceed if it IS the target
    expect(cmds()).toEqual(["whoami", "status --json"]); // NOTHING after the read-only status — no init, no up
  });
});
