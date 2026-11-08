import { describe, expect, it, vi } from "vitest";
import { type FlyRunPlan, deployFlyRun } from "../src/deploy/fly/run.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { deploymentSecrets } from "../src/deploy/secrets.ts";
import { declaredChannels } from "../src/channels/discover.ts";
import { boxReporting } from "./box-webhooks.ts";

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

  const LOGIN = "fastagent login openai-codex --deployment fly";
  it("the box logs in after it answers and before any webhook points at it; a box left logged out stays dark", async () => {
    const order: string[] = [];
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => {
      order.push("register");
      return "registered";
    });
    const healthy = async () => {
      order.push("health");
      return true;
    };
    const login = async (verdict: string | undefined) => {
      order.push("login");
      return verdict;
    };
    const p = (verdict: string | undefined) =>
      plan({ channels: declaredChannels(["telegram"]), boxLogin: { command: LOGIN, run: () => login(verdict) } });

    expect(await run(p(undefined), fly, tg, healthy)).toEqual({ ok: true });
    expect(order).toEqual(["health", "login", "register"]);

    order.length = 0;
    expect(await run(p("not logged in: …"), fly, tg, healthy)).toMatchObject({
      ok: false,
      gate: expect.stringMatching(
        /^not logged in: …\. This deploy confirmed no webhook.*re-run `fastagent deploy fly --run`/,
      ),
    });
    expect(order).toEqual(["health", "login"]);

    // No webhook to point, but a login follows: the box must be up (workspace prepared, CLI installed) for it.
    order.length = 0;
    await run(plan({ boxLogin: { command: LOGIN, run: () => login(undefined) } }), fly, tg, healthy);
    expect(order).toEqual(["health", "login"]);
  });

  it("a box that never answers hands over the login it was about to run, provider included", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
    const logs: string[] = [];
    const out = await deployFlyRun(
      plan({ boxLogin: { command: LOGIN, run: async () => undefined } }),
      fly,
      (m) => logs.push(m),
      {},
      async () => false,
    );
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining(`log it in: ${LOGIN}`) });
  });

  it("an app that already has both families is not allocated a second address", async () => {
    // The shape `fly ips list --json` really returns (Address + Type), from a deployed app.
    const existing = JSON.stringify([
      { ID: "ip_x", Address: "66.241.124.150", Type: "shared_v4" },
      { ID: "ip_y", Address: "2a09:8280:1::1:2", Type: "v6" },
    ]);
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "ips") return { stdout: existing };
      return a[0] === "apps" ? { stdout: "[]" } : {};
    });

    expect(await run(plan(), fly)).toEqual({ ok: true });
    expect(cmds()).toContain("ips list -a bot --json");
    expect(cmds().some((c) => c.startsWith("ips allocate"))).toBe(false);
  });

  // The check is per family because the ACTION is: "has an ingress address" would read either of
  // these as done. The v6-only app is #425 itself — it resolves, to an AAAA record alone, which an
  // IPv4-only webhook sender (Telegram, GitHub) cannot reach. The v4-only app is how it gets there:
  // allocate-v4 succeeds, allocate-v6 gates, and the re-run the gate asks for sees v4 and skips.
  for (const [held, missing, expected] of [
    [{ ID: "ip_y", Address: "2a09:8280:1::1:2", Type: "v6" }, "v4", "ips allocate-v4 --shared -a bot"],
    [{ ID: "ip_x", Address: "66.241.124.150", Type: "shared_v4" }, "v6", "ips allocate-v6 -a bot"],
  ] as const) {
    it(`allocates the missing ${missing} for an app that holds only the other family`, async () => {
      const { fly, cmds } = fakeFly((a) => {
        if (a[0] === "ips") return { stdout: JSON.stringify([held]) };
        return a[0] === "apps" ? { stdout: "[]" } : {};
      });

      expect(await run(plan(), fly)).toEqual({ ok: true });
      expect(cmds().filter((c) => c.startsWith("ips allocate"))).toEqual([expected]);
    });
  }

  it("allocates for an app whose only addresses are Flycast and egress", async () => {
    // Every one of these carries a non-empty Address and NONE of them answers https://<app>.fly.dev.
    // Treating them as ingress is #425 again, and it also stops flyctl's own first-deploy fallback,
    // which returns early as soon as the app holds any assignment at all.
    const internal = JSON.stringify([
      { Address: "fdaa:0:1::3", Type: "private_v6" },
      { Address: "66.241.125.9", Type: "egress_v4" },
      { Address: "2a09:8280:1::5", Type: "egress_v6" },
    ]);
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "ips") return { stdout: internal };
      return a[0] === "apps" ? { stdout: "[]" } : {};
    });

    expect(await run(plan(), fly)).toEqual({ ok: true });
    expect(cmds()).toContain("ips allocate-v4 --shared -a bot");
    expect(cmds()).toContain("ips allocate-v6 -a bot");
  });

  it("gate: a failed `ips list` stops before deploying something unreachable", async () => {
    // Without an address the machine serves and https://<app>.fly.dev has no DNS record at all, so a
    // list we cannot read must not be treated as "probably fine" (#425).
    const { fly } = fakeFly((a) => {
      if (a[0] === "ips") return { code: 1 };
      return a[0] === "apps" ? { stdout: "[]" } : {};
    });

    expect(await run(plan(), fly)).toEqual({ ok: false, gate: expect.stringContaining("ips list") });
  });

  // Exit 0 with unreadable output is a THIRD answer, and every list gates on it rather than reading it
  // as "absent". flyctl has dropped `--json` before (superfly/flyctl#1967), and each collapse has its
  // own damage: a create misreported as a name clash, an unreachable deploy (#425).
  for (const [label, args] of [
    ["apps list", ["apps"]],
    ["ips list", ["ips"]],
  ] as const) {
    it(`gate: \`${label}\` exiting 0 with non-JSON is not read as "absent"`, async () => {
      const { fly, cmds } = fakeFly((a) => {
        if (a[0] === args[0]) return { stdout: "NAME\tSTATUS\nbot\tdeployed\n" }; // the pre-#1967 table
        return a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {};
      });

      expect(await run(plan(), fly)).toEqual({ ok: false, gate: expect.stringContaining(label) });
      // Gated BEFORE the write it would otherwise have guessed its way into.
      expect(cmds().some((c) => c.startsWith(`${args[0]} create`) || c.startsWith(`${args[0]} allocate`))).toBe(false);
    });
  }

  // What is fly's here is the URL the shared registrar is handed and the gate becoming this run's
  // outcome; WHICH channels register, and how manual/failed outcomes read, is deploy-channel-ingress.
  it("reads what the box registered at the fly URL, and a terminal failure becomes the run's gate", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" ? { stdout: "[]" } : {}));
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployFlyRun(
      plan({ channels: declaredChannels(["telegram", "feishu"]) }),
      fly,
      () => {},
      {},
      async () => true,
      boxReporting({
        telegram: vi.fn(async (): Promise<RegistrationOutcome> => "failed"), // the box's telegram webhook is NOT set
        feishu: registerFeishu,
      }),
    );

    // Exit 0 here would tell a coding agent "done" while the agent can't receive messages.
    expect(out).toEqual({
      ok: false,
      gate: expect.stringMatching(/webhook registration failed for: telegram/),
    });
    expect(registerFeishu).toHaveBeenCalledWith("https://bot.fly.dev", "feishu");
  });

  it("gate: an app that never answers /health stops BEFORE any webhook is registered", async () => {
    // `fly deploy` exits 0 on a machine that then crash-loops, and setWebhook does not verify the URL:
    // registering here would point a live channel at a dead address and report success.
    const { fly } = fakeFly((a) => (a[0] === "apps" ? { stdout: "[]" } : {}));
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(plan({ channels: declaredChannels(["telegram"]) }), fly, tg, async () => false);

    expect(out).toEqual({ ok: false, gate: expect.stringContaining("https://bot.fly.dev/health") });
    expect(tg).not.toHaveBeenCalled();
  });

  it("the secrets step runs once the app exists, before anything else is set up for it, on a store that stages", async () => {
    const { fly, calls } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
    const seen: string[] = [];
    const out = await run(
      plan({
        provideSecrets: async (store) => {
          seen.push(...(await store.names()));
          await store.write({ OPENAI_API_KEY: "sk-x" });
          return undefined;
        },
      }),
      fly,
    );
    expect(out).toEqual({ ok: true });
    const cmds = calls.map((c) => c.args.join(" "));
    // An app that cannot run without its values is given no address first.
    expect(cmds.indexOf("secrets list -a bot --json")).toBeGreaterThan(cmds.indexOf("apps create bot"));
    expect(cmds.indexOf("secrets list -a bot --json")).toBeLessThan(cmds.indexOf("ips list -a bot --json"));
    expect(cmds.indexOf("secrets set --stage -a bot OPENAI_API_KEY=-")).toBeLessThan(
      cmds.findIndex((c) => c.startsWith("deploy ")),
    );
    // A value goes over stdin, never argv.
    expect(calls.find((c) => c.args[1] === "set")?.input).toBe("sk-x");
  });

  it("idempotent re-run: an existing app is skipped, deploy still runs", async () => {
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "apps" && a[1] === "list") return { stdout: JSON.stringify([{ Name: "bot" }]) };
      return {};
    });
    const out = await run(plan(), fly);
    expect(out).toEqual({ ok: true });
    expect(cmds()).not.toContain("apps create bot");
    // The volume is `fly deploy`'s to create: only it can place one on a host that also fits the machine.
    expect(cmds().some((c) => c.startsWith("volumes"))).toBe(false);
    expect(cmds()).toContain(
      "deploy . -a bot -c fastagent/fly.toml --dockerfile fastagent/Dockerfile --remote-only --yes --ha=false",
    );
  });

  it("gate: not logged in with nobody to sign in → stops before any side effect, naming every way in", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "auth" ? { code: 1 } : {}));
    const out = await run(plan(), fly);
    expect(out).toEqual({
      ok: false,
      gate:
        "not logged in to Fly — run `fly auth login` in a terminal (it opens a browser), or set FLY_API_TOKEN in this " +
        "shell's environment, not in .secrets/production/.env (that file holds the deployment's values); then re-run. " +
        "From a coding agent, `fastagent deploy fly ../bot --run --json` hands the sign-in to its user",
    });
    expect(cmds()).toEqual(["auth whoami"]); // nothing after the gate
  });

  it("not logged in with someone to sign in: signed in, then the run goes on; a failed sign-in is the gate", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "auth" ? { code: 1 } : {}));
    const hostLogin = vi.fn(async () => undefined);
    await run(plan({ hostLogin }), fly);
    expect(hostLogin).toHaveBeenCalledOnce();
    expect(cmds()).toContain("apps list --json");

    const refused = fakeFly((a) => (a[0] === "auth" ? { code: 1 } : {}));
    const out = await run(plan({ hostLogin: async () => "the person did not approve" }), refused.fly);
    expect(out).toEqual({ ok: false, gate: "the person did not approve" });
    expect(refused.cmds()).toEqual(["auth whoami"]);
  });

  it("gate: a name the app lacks stops the run before the deploy, with the app already made", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
    const out = await run(plan({ provideSecrets: async () => "Fly has no value for: TELEGRAM_BOT_TOKEN" }), fly);
    expect(out).toEqual({ ok: false, gate: "Fly has no value for: TELEGRAM_BOT_TOKEN" });
    expect(cmds().some((c) => c.startsWith("deploy "))).toBe(false);
    // Stopped before it spent anything on an address the app cannot use yet.
    expect(cmds().some((c) => c.startsWith("ips "))).toBe(false);
  });

  it("gate: a failed `apps list` stops (not misreported as a name clash)", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "apps" && a[1] === "list" ? { code: 1 } : {}));
    const out = await run(plan(), fly);
    expect(out).toEqual({ ok: false, gate: expect.stringContaining("apps list") });
    expect(cmds()).not.toContain("apps create bot"); // never infer "absent" from an errored query
  });

  it("gate: a taken app name stops with the rename instruction", async () => {
    const { fly } = fakeFly((a) => {
      if (a[0] === "apps" && a[1] === "list") return { stdout: "[]" };
      if (a[0] === "apps" && a[1] === "create") return { code: 1 };
      return {};
    });
    const out = await run(plan(), fly);
    expect(out).toEqual({
      ok: false,
      gate: expect.stringMatching(/globally unique.*unique `app` in fly\.toml|payment information/s),
    });
  });
});

describe("deploy/secrets: deploymentSecrets (the runbook's list)", () => {
  it("the model's key first, then each declared name hinted by the file that declared it, and nothing a file merely holds", () => {
    const list = deploymentSecrets("OPENAI_API_KEY", [
      { name: "GH_TOKEN", declaredIn: "tools/gh.ts", optional: false },
    ]);
    expect(list).toEqual([
      { name: "OPENAI_API_KEY", hint: "your model provider key" },
      { name: "GH_TOKEN", hint: "required by tools/gh.ts" },
    ]);
  });
});
