import { describe, expect, it, vi } from "vitest";
import { type FlyRunPlan, deployFlyRun } from "../../../src/deploy/fly/run.ts";
import type { RegistrationOutcome } from "../../../src/channels/registration.ts";
import type { CliRunner } from "../../../src/deploy/runner.ts";
import { declaredChannels } from "../../../src/channels/discover.ts";
import { boxReporting } from "../../harnesses/box-webhooks.ts";

/** A fake flyctl: records every call, returns per-command scripted results (default code 0, empty out). */
function fakeFly(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const fly: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    // An unscripted `--json` command answers an EMPTY LIST, not an empty string: flyctl cannot print
    // the latter, and the driver's parse gates correctly refuse it. Scripting stays per-test.
    return { code: r.code ?? 0, stdout: r.stdout ?? (args.includes("--json") ? "[]" : "") };
  };
  return { fly, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

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
    // Fresh account: apps/ips lists are empty, everything succeeds.
    const { fly, cmds } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
      }),
      fly,
      tg,
    );

    expect(out).toEqual({ ok: true });
    expect(cmds()).toEqual([
      "auth whoami",
      "apps list --json",
      "apps create bot",
      "ips list -a bot --json",
      "ips allocate-v4 --shared -a bot",
      "ips allocate-v6 -a bot",
      "deploy . -a bot -c fastagent/fly.toml --dockerfile fastagent/Dockerfile --remote-only --yes --ha=false",
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot.fly.dev"); // telegram end-to-end
  });

  // The check is per family because the ACTION is: "has an ingress address" would read either of
  // these as done. The v6-only app is #425 itself — it resolves, to an AAAA record alone, which an
  // IPv4-only webhook sender (Telegram, GitHub) cannot reach. The v4-only app is how it gets there:
  // allocate-v4 succeeds, allocate-v6 gates, and the re-run the gate asks for sees v4 and skips.

  // Exit 0 with unreadable output is a THIRD answer, and every list gates on it rather than reading it
  // as "absent". flyctl has dropped `--json` before (superfly/flyctl#1967), and each collapse has its
  // own damage: a create misreported as a name clash, an unreachable deploy (#425).

  it("gate: not logged in with nobody to sign in → stops before any side effect, naming every way in", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "auth" ? { code: 1 } : {}));
    const out = await run(plan(), fly);
    expect(out).toEqual({
      ok: false,
      gate:
        "not logged in to Fly — run `fly auth login` in a terminal (it opens a browser), or set FLY_API_TOKEN in this " +
        "shell's environment (it is not a value of the deployment); then re-run. " +
        "From a coding agent, `fastagent deploy fly ../bot --run --json` hands the sign-in to its user",
    });
    expect(cmds()).toEqual(["auth whoami"]); // nothing after the gate
  });
});
