import { afterEach, describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../../../src/channels/discover.ts";
import type { RegistrationOutcome } from "../../../src/channels/registration.ts";
import { type FlyRunPlan, deployFlyRun } from "../../../src/deploy/fly/run.ts";
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

const recordFly = (script: (call: HostCliCall) => HostCliAnswer = () => ({})) =>
  recordHostCli("fly", (call) => {
    const answer = script(call);
    return {
      ...answer,
      stdout: answer.stdout ?? (call.args.includes("--json") ? "[]" : ""),
    };
  });

const plan = (over: Partial<FlyRunPlan> = {}): FlyRunPlan => ({
  appName: "bot",
  provideSecrets: async () => undefined,
  channels: [],
  flyConfig: "fastagent/fly.toml",
  dockerfile: "fastagent/Dockerfile",
  forAgent: "fastagent deploy fly ../bot --run --json",
  ...over,
});

/** Healthy by default: every test but the readiness one is about the flyctl sequence, not the probe. */
const run = (
  p: FlyRunPlan,
  fly: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
  healthy: () => Promise<boolean> = async () => true,
) => deployFlyRun(p, fly, () => {}, {}, healthy, boxReporting({ telegram: tg }));

describe("deploy/fly/run: the coding-agent deploy journey (benchmark)", () => {
  it("happy path: auth → create app+address → set secrets → deploy → telegram webhook", async () => {
    const fly = recordFly(({ args }) => (args[0] === "apps" || args[0] === "ips" ? { stdout: "[]" } : {}));
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
      }),
      spawnRunner("fly", "."),
      tg,
    );

    expect(out).toEqual({ ok: true });
    expect(fly.cmds()).toEqual([
      "auth whoami",
      "apps list --json",
      "apps create bot",
      "ips list -a bot --json",
      "ips allocate-v4 --shared -a bot",
      "ips allocate-v6 -a bot",
      "deploy . -a bot -c fastagent/fly.toml --dockerfile fastagent/Dockerfile --remote-only --yes --ha=false",
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot.fly.dev");
  });

  it("gate: not logged in with nobody to sign in → stops before any side effect, naming every way in", async () => {
    const fly = recordFly(({ args }) => (args[0] === "auth" ? { code: 1 } : {}));
    const out = await run(plan(), spawnRunner("fly", "."));
    expect(out).toEqual({
      ok: false,
      gate:
        "not logged in to Fly — run `fly auth login` in a terminal (it opens a browser), or set FLY_API_TOKEN in this " +
        "shell's environment (it is not a value of the deployment); then re-run",
    });
    expect(fly.cmds()).toEqual(["auth whoami"]);
  });
});
