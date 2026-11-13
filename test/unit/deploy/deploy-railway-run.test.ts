import { afterEach, describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../../../src/channels/discover.ts";
import type { RegistrationOutcome } from "../../../src/channels/registration.ts";
import { type RailwayRunPlan, deployRailwayRun } from "../../../src/deploy/railway/run.ts";
import type { CliRunner } from "../../../src/deploy/runner.ts";
import {
  type HostCliAnswer,
  type HostCliCall,
  recordHostCli,
  resetHostClis,
  spawnRunner,
} from "../../doubles/host-cli-double.ts";
import { boxReporting } from "../../harnesses/box-webhooks.ts";

afterEach(resetHostClis);

/** `railway volume list --json` as the CLI prints it: the whole project's volumes. */
const volumes = (...vs: { serviceName: string | null; mountPath?: string; status?: string }[]) =>
  JSON.stringify({ volumes: vs.map((v) => ({ mountPath: "/data", status: "Ready", ...v })) });

function recordRailway(script: (call: HostCliCall) => HostCliAnswer = () => ({})) {
  let added = false;
  return recordHostCli("railway", (call) => {
    const answer = script(call);
    if (call.args[0] === "volume" && call.args[1] === "add" && (answer.code ?? 0) === 0) added = true;
    if (call.args[0] === "volume" && call.args[1] === "list" && answer.stdout === undefined) {
      return { code: answer.code ?? 0, stdout: added ? volumes({ serviceName: "bot" }) : volumes() };
    }
    return answer;
  });
}

const plan = (over: Partial<RailwayRunPlan> = {}): RailwayRunPlan => ({
  name: "bot",
  mountPath: "/data",
  provideSecrets: async () => undefined,
  channels: [],
  intoLinked: false,
  delivery: (url) => ({ variables: { FASTAGENT_NAME: "bot", FASTAGENT_CONFIG_JSON: "{}" }, publicUrl: url }),
  ...over,
});

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
    const railway = recordRailway(({ args }) => {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const delivered: { url: string; before: string[] }[] = [];
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
        delivery: (url) => {
          delivered.push({ url, before: railway.cmds() });
          return {
            variables: { FASTAGENT_NAME: "bot", FASTAGENT_CONFIG_JSON: `{"http":{"publicUrl":"${url}"}}` },
            publicUrl: url,
          };
        },
      }),
      spawnRunner("railway", "."),
      tg,
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(delivered).toEqual([
      { url: "https://bot-production.up.railway.app", before: expect.not.arrayContaining(["up --ci --service bot"]) },
    ]);
    expect(railway.cmds()).toEqual([
      "whoami",
      "status --json",
      "init --name bot",
      "add --service bot --variables FASTAGENT_STATE_DIR=/data/.state",
      "variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets --service bot",
      "volume list --json",
      "volume add --mount-path /data",
      "volume list --json",
      "domain --json --service bot",
      'variables set FASTAGENT_NAME=bot FASTAGENT_CONFIG_JSON={"http":{"publicUrl":"https://bot-production.up.railway.app"}} --skip-deploys --service bot',
      "up --ci --service bot",
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot-production.up.railway.app");
  });

  it("gate (SAFETY): a linked dir WITHOUT --into-linked is refused before any side effect — names the project", async () => {
    const railway = recordRailway(({ args }) =>
      args[0] === "status" ? { stdout: JSON.stringify({ name: "prod-app", id: "prod-99" }) } : {},
    );
    const out = await run(plan(), spawnRunner("railway", "."));
    expect(out.ok).toBe(false);
    const gate = out.ok ? "" : out.gate;
    expect(gate).toContain("prod-app");
    expect(gate).toMatch(/--into-linked/);
    expect(railway.cmds()).toEqual(["whoami", "status --json"]);
  });
});
