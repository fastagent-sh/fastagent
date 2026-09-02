import { describe, expect, it, vi } from "vitest";
import { type FlyRunPlan, deployFlyRun } from "../src/deploy/fly/run.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { CONTROL_TOKEN_ENV } from "../src/channels/control.ts";
import { assembleSecrets, authSeedBytes, collectAuthSeed, deploymentSecrets } from "../src/deploy/secrets.ts";
import { declaredChannels } from "../src/channels/discover.ts";

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
  region: "iad",
  secrets: {},
  missingSecrets: [],
  channels: [],
  flyConfig: "fastagent/fly.toml",
  dockerfile: "fastagent/Dockerfile",
  ...over,
});

const run = (p: FlyRunPlan, fly: CliRunner, tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered")) =>
  deployFlyRun(p, fly, () => {}, { telegram: tg });

describe("deploy/fly/run: the coding-agent deploy journey (benchmark)", () => {
  it("happy path: auth → create app+volume+address → set secrets → deploy → telegram webhook", async () => {
    // Fresh account: apps/volumes/ips lists are empty, everything succeeds.
    const { fly, cmds } = fakeFly((a) =>
      a[0] === "apps" || a[0] === "volumes" || a[0] === "ips" ? { stdout: "[]" } : {},
    );
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
        secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" },
      }),
      fly,
      tg,
    );

    expect(out).toEqual({ ok: true });
    expect(cmds()).toEqual([
      "auth whoami",
      "apps list --json",
      "apps create bot",
      "volumes list -a bot --json",
      "volumes create data -a bot --region iad --size 1 --yes",
      "ips list -a bot --json",
      "ips allocate-v4 --shared -a bot",
      "ips allocate-v6 -a bot",
      "secrets import --stage -a bot",
      "deploy . -a bot -c fastagent/fly.toml --dockerfile fastagent/Dockerfile --remote-only --yes --ha=false",
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot.fly.dev"); // telegram end-to-end
  });

  it("an app that already has both families is not allocated a second address", async () => {
    // The shape `fly ips list --json` really returns (Address + Type), from a deployed app.
    const existing = JSON.stringify([
      { ID: "ip_x", Address: "66.241.124.150", Type: "shared_v4" },
      { ID: "ip_y", Address: "2a09:8280:1::1:2", Type: "v6" },
    ]);
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "ips") return { stdout: existing };
      return a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {};
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
        return a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {};
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
      return a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {};
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
      return a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {};
    });

    expect(await run(plan(), fly)).toEqual({ ok: false, gate: expect.stringContaining("ips list") });
  });

  // Exit 0 with unreadable output is a THIRD answer, and every list gates on it rather than reading it
  // as "absent". flyctl has dropped `--json` before (superfly/flyctl#1967), and each collapse has its
  // own damage: a second volume, a create misreported as a name clash, an unreachable deploy (#425).
  for (const [label, args] of [
    ["apps list", ["apps"]],
    ["volumes list", ["volumes"]],
    ["ips list", ["ips"]],
  ] as const) {
    it(`gate: \`${label}\` exiting 0 with non-JSON is not read as "absent"`, async () => {
      const { fly, cmds } = fakeFly((a) => {
        if (a[0] === args[0]) return { stdout: "NAME\tSTATUS\nbot\tdeployed\n" }; // the pre-#1967 table
        return a[0] === "apps" || a[0] === "volumes" || a[0] === "ips" ? { stdout: "[]" } : {};
      });

      expect(await run(plan(), fly)).toEqual({ ok: false, gate: expect.stringContaining(label) });
      // Gated BEFORE the write it would otherwise have guessed its way into.
      expect(cmds().some((c) => c.startsWith(`${args[0]} create`) || c.startsWith(`${args[0]} allocate`))).toBe(false);
    });
  }

  it("gate: `ips list` that exits 0 with unparseable output stops too", async () => {
    // The other half of the same rule: exit 0 does not mean the answer was readable, and silently
    // reading "no address" out of it would allocate a second one on every run.
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "ips") return { stdout: "NAME\tTYPE\n" };
      return a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {};
    });

    expect(await run(plan(), fly)).toEqual({ ok: false, gate: expect.stringContaining("unreadable") });
    expect(cmds().some((c) => c.startsWith("ips allocate"))).toBe(false);
  });

  it("dispatches Feishu and Lark registration through the per-kind seam", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployFlyRun(plan({ channels: declaredChannels(["feishu", "lark"]) }), fly, () => {}, {
      telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      feishu: registerFeishu,
    });

    expect(out).toEqual({ ok: true });
    expect(registerFeishu.mock.calls).toEqual([
      ["https://bot.fly.dev", "feishu"],
      ["https://bot.fly.dev", "lark"],
    ]);
  });

  it("does not register a long-connection Feishu channel as a webhook", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );
    const out = await deployFlyRun(plan({ channels: declaredChannels(["feishu"], "long-connection") }), fly, () => {}, {
      telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      feishu: registerFeishu,
    });
    expect(out).toEqual({ ok: true });
    expect(registerFeishu).not.toHaveBeenCalled();
  });

  it("gates when a webhook registration terminally fails — after attempting the remaining channels", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployFlyRun(plan({ channels: declaredChannels(["telegram", "feishu"]) }), fly, () => {}, {
      telegram: vi.fn(async (): Promise<RegistrationOutcome> => "failed"),
      feishu: // telegram registration ends with the webhook NOT set
        registerFeishu,
    });

    // Exit 0 here would tell a coding agent "done" while the agent can't receive messages.
    expect(out).toEqual({
      ok: false,
      gate: expect.stringMatching(/webhook registration failed for: telegram/),
    });
    expect(registerFeishu).toHaveBeenCalledWith("https://bot.fly.dev", "feishu"); // one failure doesn't skip the rest
  });

  it("a 'manual' registration outcome does not gate — but is re-surfaced as the run's last line", async () => {
    // e.g. the Lark cloud-lag 404: re-running can never change it, so gating would spin an agent forever.
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const logs: string[] = [];

    const out = await deployFlyRun(plan({ channels: declaredChannels(["lark"]) }), fly, (m) => logs.push(m), {
      telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      feishu: vi.fn(async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "manual"),
    });

    expect(out).toEqual({ ok: true });
    expect(logs.at(-1)).toMatch(/lark: webhook registration needs a one-time manual step/);
  });

  it("dispatches Slack registration through the local onboarding seam", async () => {
    const { fly } = fakeFly((args) => (args[0] === "apps" || args[0] === "volumes" ? { stdout: "[]" } : {}));
    const registerSlack = vi.fn(async (_baseUrl: string): Promise<RegistrationOutcome> => "registered");

    const out = await deployFlyRun(plan({ channels: declaredChannels(["slack"]) }), fly, () => {}, {
      telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      feishu: undefined,
      slack: registerSlack,
    });

    expect(out).toEqual({ ok: true });
    expect(registerSlack).toHaveBeenCalledWith("https://bot.fly.dev");
  });

  it("reports Slack's Events API URL as a manual non-gating registration step", async () => {
    const { fly } = fakeFly((args) => (args[0] === "apps" || args[0] === "volumes" ? { stdout: "[]" } : {}));
    const logs: string[] = [];

    const out = await deployFlyRun(
      plan({ channels: declaredChannels(["slack"]) }),
      fly,
      (message) => logs.push(message),
      {
        telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      },
    );

    expect(out).toEqual({ ok: true });
    expect(logs.join("\n")).toContain("https://bot.fly.dev/slack");
    expect(logs.at(-1)).toMatch(/slack: webhook registration needs a one-time manual step/);
  });

  it("mixed outcomes: manual notices are logged AND the failed channels still gate", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const logs: string[] = [];

    const out = await deployFlyRun(
      plan({ channels: declaredChannels(["telegram", "lark"]) }),
      fly,
      (m) => logs.push(m),
      {
        telegram: vi.fn(async (): Promise<RegistrationOutcome> => "failed"),
        feishu: vi.fn(async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "manual"),
      },
    );

    expect(logs.at(-1)).toMatch(/lark: webhook registration needs a one-time manual step/);
    expect(out).toEqual({
      ok: false,
      gate: expect.stringMatching(/webhook registration failed for: telegram/),
    });
  });

  it("prints each Feishu-cloud Request URL when no registrar is supplied", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const logs: string[] = [];

    const out = await deployFlyRun(
      plan({ channels: declaredChannels(["feishu", "lark"]) }),
      fly,
      (message) => logs.push(message),
      {
        telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      },
    );

    expect(out).toEqual({ ok: true });
    expect(logs.join("\n")).toContain("https://bot.fly.dev/feishu");
    expect(logs.join("\n")).toContain("https://bot.fly.dev/lark");
  });

  it("secret values go over stdin (import), never argv", async () => {
    const { fly, calls } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    await run(plan({ secrets: { OPENAI_API_KEY: "sk-x", FASTAGENT_AUTH_SEED: "b64" } }), fly);
    const importCall = calls.find((c) => c.args[0] === "secrets")!;
    expect(importCall.args.join(" ")).not.toContain("sk-x"); // not in argv
    expect(importCall.input).toBe("OPENAI_API_KEY=sk-x\nFASTAGENT_AUTH_SEED=b64\n"); // on stdin
  });

  it("idempotent re-run: existing app + volume are skipped, deploy still runs", async () => {
    const { fly, cmds } = fakeFly((a) => {
      if (a[0] === "apps" && a[1] === "list") return { stdout: JSON.stringify([{ Name: "bot" }]) };
      if (a[0] === "volumes" && a[1] === "list") return { stdout: JSON.stringify([{ name: "data" }]) };
      return {};
    });
    const out = await run(plan(), fly);
    expect(out).toEqual({ ok: true });
    expect(cmds()).not.toContain("apps create bot");
    expect(cmds()).not.toContain("volumes create data -a bot --region iad --size 1 --yes");
    expect(cmds()).toContain(
      "deploy . -a bot -c fastagent/fly.toml --dockerfile fastagent/Dockerfile --remote-only --yes --ha=false",
    );
  });

  it("gate: not logged in → stops before any side effect", async () => {
    const { fly, cmds } = fakeFly((a) => (a[0] === "auth" ? { code: 1 } : {}));
    const out = await run(plan(), fly);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/fly auth login|FLY_API_TOKEN/) });
    expect(cmds()).toEqual(["auth whoami"]); // nothing after the gate
  });

  it("gate: a missing secret value stops before creating infra", async () => {
    const { fly, cmds } = fakeFly();
    const out = await run(plan({ missingSecrets: ["TELEGRAM_BOT_TOKEN"] }), fly);
    expect(out).toEqual({ ok: false, gate: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(cmds()).toEqual(["auth whoami"]); // no apps create
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
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/globally unique|taken/) });
  });
});

describe("deploy/secrets: assembleSecrets (credential wiring)", () => {
  it("an env-key model auth travels as its own secret (value from env)", () => {
    const r = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: [],
      env: { OPENAI_API_KEY: "sk-x" },
    });
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "sk-x" });
    expect(r.needsModelCredential).toBe(false);
  });

  it("OAuth/stored auth (no env key) rides as a base64 FASTAGENT_AUTH_SEED", () => {
    const r = assembleSecrets({ modelAuth: "OAuth", authFile: Buffer.from('{"a":1}'), channels: [], env: {} });
    expect(r.secrets.FASTAGENT_AUTH_SEED).toBe(Buffer.from('{"a":1}').toString("base64"));
    expect(r.needsModelCredential).toBe(false);
  });

  it("no env key AND no auth file → needsModelCredential (its own login gate, NOT missingSecrets)", () => {
    const r = assembleSecrets({ modelAuth: undefined, authFile: undefined, channels: [], env: {} });
    expect(r.needsModelCredential).toBe(true);
    expect(r.missingSecrets).toEqual([]);
  });

  it("a definition-carried model key (models.json) satisfies the gate without carrying a secret", () => {
    // The regression this pins: a models.json endpoint has no env-key name and no auth.json, so it fell
    // into needsModelCredential and `--run` stopped with two impossible remedies — `fastagent login`
    // has no flow for a custom provider, and there is no provider env key to set. The key is already
    // inside the definition, which the image ships.
    const r = assembleSecrets({
      modelAuth: "configured API key",
      modelKeyInDefinition: true,
      authFile: undefined,
      channels: [],
      env: {},
    });
    expect(r.needsModelCredential).toBe(false);
    expect(r.secrets).toEqual({}); // nothing to carry — and nothing invented
    expect(r.missingSecrets).toEqual([]);
  });

  it("channel secrets come from env; never minted (a re-run is stable; a human-shared secret stays known)", () => {
    const env = { OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_SECRET_TOKEN: "sec" };
    const r = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["telegram"]),
      env,
    });
    expect(r.secrets.TELEGRAM_SECRET_TOKEN).toBe("sec"); // from env, not a mint
    expect(r.missingSecrets).toEqual([]);
  });

  it("any absent required channel secret — including a scaffold `generate` one — lands in missingSecrets", () => {
    // github's webhook secret is human-shared: it MUST be operator-provided, not silently minted.
    const r = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["github", "telegram"]),
      env: { OPENAI_API_KEY: "k" },
    });
    expect(r.missingSecrets).toEqual(["GITHUB_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"]);
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "k" }); // no minted values
  });

  it("Slack rotation credentials are optional for manual apps and travel together when onboarded", () => {
    const base = {
      OPENAI_API_KEY: "k",
      SLACK_BOT_TOKEN: "access",
      SLACK_SIGNING_SECRET: "signing",
    };
    const manual = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["slack"]),
      env: base,
    });
    expect(manual.missingSecrets).toEqual([]);
    expect(manual.secrets.SLACK_BOT_REFRESH_TOKEN).toBeUndefined();

    const rotating = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["slack"]),
      env: {
        ...base,
        SLACK_BOT_REFRESH_TOKEN: "refresh",
        SLACK_BOT_TOKEN_EXPIRES_AT: "2000000000000",
        SLACK_CLIENT_ID: "client",
        SLACK_CLIENT_SECRET: "secret",
      },
    });
    expect(rotating.missingSecrets).toEqual([]);
    expect(rotating.secrets).toMatchObject({
      SLACK_BOT_REFRESH_TOKEN: "refresh",
      SLACK_BOT_TOKEN_EXPIRES_AT: "2000000000000",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
    });

    const partial = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["slack"]),
      env: { ...base, SLACK_BOT_REFRESH_TOKEN: "refresh" },
    });
    expect(partial.missingSecrets).toEqual(["SLACK_BOT_TOKEN_EXPIRES_AT", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]);
  });

  it("Feishu/Lark Encrypt Keys are optional: absent never gates deploy; present values still travel", () => {
    for (const [kind, prefix] of [
      ["feishu", "FEISHU"],
      ["lark", "LARK"],
    ] as const) {
      const baseEnv = {
        OPENAI_API_KEY: "k",
        [`${prefix}_APP_ID`]: "app",
        [`${prefix}_APP_SECRET`]: "secret",
        [`${prefix}_VERIFICATION_TOKEN`]: "token",
      };
      const absent = assembleSecrets({
        modelAuth: "OPENAI_API_KEY",
        authFile: undefined,
        channels: declaredChannels([kind]),
        env: baseEnv,
      });
      expect(absent.missingSecrets).toEqual([]);
      expect(absent.secrets[`${prefix}_ENCRYPT_KEY`]).toBeUndefined();

      const present = assembleSecrets({
        modelAuth: "OPENAI_API_KEY",
        authFile: undefined,
        channels: declaredChannels([kind]),
        env: { ...baseEnv, [`${prefix}_ENCRYPT_KEY`]: "encrypt" },
      });
      expect(present.missingSecrets).toEqual([]);
      expect(present.secrets[`${prefix}_ENCRYPT_KEY`]).toBe("encrypt");
    }
  });

  it("config deploy.secrets (extraSecrets) carry from env like channel secrets; absent → missingSecrets (G4)", () => {
    const present = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: [],
      extraSecrets: ["GH_TOKEN"],
      env: { OPENAI_API_KEY: "k", GH_TOKEN: "ghp_x" },
    });
    expect(present.secrets.GH_TOKEN).toBe("ghp_x"); // value from the local env
    expect(present.missingSecrets).toEqual([]);
    const absent = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: [],
      extraSecrets: ["GH_TOKEN"],
      env: { OPENAI_API_KEY: "k" },
    });
    expect(absent.missingSecrets).toEqual(["GH_TOKEN"]); // declared but no local value → gates --run

    // Dedup: an extraSecret that repeats a channel secret is not listed twice in missingSecrets.
    const dup = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: declaredChannels(["telegram"]),
      extraSecrets: ["TELEGRAM_BOT_TOKEN"],
      env: { OPENAI_API_KEY: "k" },
    });
    expect(dup.missingSecrets.filter((n) => n === "TELEGRAM_BOT_TOKEN")).toHaveLength(1);
  });

  it("the control token carries when set and NEVER gates — unset, the box mints one and still serves", () => {
    const base = {
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: [] as const,
      env: { OPENAI_API_KEY: "k" },
    };
    const absent = assembleSecrets({ ...base, channels: [], extraSecrets: [CONTROL_TOKEN_ENV] });
    expect(absent.missingSecrets).toEqual([]); // a deploy that worked before this existed still runs
    const present = assembleSecrets({
      ...base,
      channels: [],
      extraSecrets: [CONTROL_TOKEN_ENV],
      env: { OPENAI_API_KEY: "k", [CONTROL_TOKEN_ENV]: "t0ken" },
    });
    expect(present.secrets[CONTROL_TOKEN_ENV]).toBe("t0ken");
    // The runbook lists it as optional for the same reason — required would gate every host.
    const listed = deploymentSecrets("OPENAI_API_KEY", [], [CONTROL_TOKEN_ENV]);
    expect(listed.find((s) => s.name === CONTROL_TOKEN_ENV)?.required).toBe(false);
  });
});

describe("deploy/secrets: authSeedBytes (the start-side seed guard)", () => {
  it("seeds only when the seed is set AND the auth file is absent (absent-only — no rollback)", () => {
    expect(authSeedBytes(undefined, false)).toBeUndefined(); // no seed → no-op
    expect(authSeedBytes(Buffer.from("hi").toString("base64"), true)).toBeUndefined(); // file present → never clobber
    expect(authSeedBytes(Buffer.from("hi").toString("base64"), false)?.toString()).toBe("hi"); // absent → materialize
  });

  it("collectAuthSeed reassembles a chunked seed in order and stops at the first gap", () => {
    expect(collectAuthSeed({})).toBeUndefined();
    expect(collectAuthSeed({ FASTAGENT_AUTH_SEED: "abc" })).toBe("abc");
    expect(collectAuthSeed({ FASTAGENT_AUTH_SEED: "a", FASTAGENT_AUTH_SEED_2: "b", FASTAGENT_AUTH_SEED_3: "c" })).toBe(
      "abc",
    );
    // A gap ends collection (the writer fills contiguously); an empty continuation reads as absent.
    expect(collectAuthSeed({ FASTAGENT_AUTH_SEED: "a", FASTAGENT_AUTH_SEED_3: "c" })).toBe("a");
    expect(collectAuthSeed({ FASTAGENT_AUTH_SEED: "a", FASTAGENT_AUTH_SEED_2: "" })).toBe("a");
  });
});
