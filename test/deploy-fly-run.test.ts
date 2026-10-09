import { describe, expect, it, vi } from "vitest";
import { type FlyRunPlan, deployFlyRun } from "../src/deploy/fly/run.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import {
  assembleSecrets,
  applyCarriedEnv,
  deploymentSecrets,
  encodeCarriedEnv,
  missingValuesGate,
} from "../src/deploy/secrets.ts";
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
  secrets: {},
  missingSecrets: [],
  valueFile: "fastagent/.secrets/.env",
  channels: [],
  flyConfig: "fastagent/fly.toml",
  dockerfile: "fastagent/Dockerfile",
  ...over,
});

/** Healthy by default: every test but the readiness one is about the flyctl sequence, not the probe. */
const run = (
  p: FlyRunPlan,
  fly: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
  healthy: () => Promise<boolean> = async () => true,
) => deployFlyRun(p, fly, () => {}, { telegram: tg }, healthy);

describe("deploy/fly/run: the coding-agent deploy journey (benchmark)", () => {
  it("happy path: auth → create app+address → set secrets → deploy → telegram webhook", async () => {
    // Fresh account: apps/ips lists are empty, everything succeeds.
    const { fly, cmds } = fakeFly((a) => (a[0] === "apps" || a[0] === "ips" ? { stdout: "[]" } : {}));
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
      "ips list -a bot --json",
      "ips allocate-v4 --shared -a bot",
      "ips allocate-v6 -a bot",
      "secrets import --stage -a bot",
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
        /^not logged in: …\. This deploy registered no webhook.*re-run `fastagent deploy fly --run`/,
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
      { telegram: vi.fn() },
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
  it("registers at the fly URL, and a terminal failure becomes the run's gate", async () => {
    const { fly } = fakeFly((a) => (a[0] === "apps" ? { stdout: "[]" } : {}));
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployFlyRun(
      plan({ channels: declaredChannels(["telegram", "feishu"]) }),
      fly,
      () => {},
      {
        telegram: vi.fn(async (): Promise<RegistrationOutcome> => "failed"),
        feishu: // telegram registration ends with the webhook NOT set
          registerFeishu,
      },
      async () => true,
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

  it("secret values go over stdin (import), never argv", async () => {
    const { fly, calls } = fakeFly((a) => (a[0] === "apps" ? { stdout: "[]" } : {}));
    await run(plan({ secrets: { OPENAI_API_KEY: "sk-x", GH_TOKEN: "ghp_x" } }), fly);
    const importCall = calls.find((c) => c.args[0] === "secrets")!;
    expect(importCall.args.join(" ")).not.toContain("sk-x"); // not in argv
    expect(importCall.input).toBe("OPENAI_API_KEY=sk-x\nGH_TOKEN=ghp_x\n"); // on stdin
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
  it("an env-key model auth travels as its own secret (value from the value file)", () => {
    const r = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      values: new Map(Object.entries({ OPENAI_API_KEY: "sk-x" })),
    });
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "sk-x" });
    expect(r.missingSecrets).toEqual([]);
  });

  it("an env-key model auth the value file lacks is missing, like any declared name", () => {
    const r = assembleSecrets({ modelAuth: "OPENAI_API_KEY", values: new Map() });
    expect(r.missingSecrets).toEqual(["OPENAI_API_KEY"]);
  });

  it("a stored credential (OAuth or a logged-in key) carries nothing: the box logs in itself", () => {
    const r = assembleSecrets({ modelAuth: "OAuth", values: new Map() });
    expect(r).toEqual({ secrets: {}, missingSecrets: [] });
  });

  it("the WHOLE value file travels, declared or not — minus what the deployment sets itself", () => {
    const r = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      values: new Map(
        Object.entries({
          OPENAI_API_KEY: "k",
          FEISHU_ENCRYPT_KEY: "enc", // optional, declared nowhere: travels anyway
          HTTPS_PROXY: "http://proxy:8080",
          EMPTY: "", // an unset `.env` line is not a value
          // This machine's paths and the model (which rides the release manifest) never travel.
          PORT: "3000",
          FASTAGENT_STATE_DIR: "/Users/me/state",
          FASTAGENT_SECRETS_DIR: "/Users/me/secrets",
          FASTAGENT_MODEL: "openai/gpt-5",
          FASTAGENT_ENV_2: "stale",
          FASTAGENT_ENVIRONMENT: "dev",
          FASTAGENT_DEV: "1",
        }),
      ),
    });
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "k", FEISHU_ENCRYPT_KEY: "enc", HTTPS_PROXY: "http://proxy:8080" });
    expect(r.missingSecrets).toEqual([]);
  });

  it("a declared name is REQUIRED: absent from the value file → missingSecrets, listed once", () => {
    const declared = [
      { name: "GH_TOKEN", source: "tools/gh.ts" },
      { name: "GH_TOKEN", source: "channels/digest.ts" },
    ];
    const present = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      declared,
      values: new Map(Object.entries({ OPENAI_API_KEY: "k", GH_TOKEN: "ghp_x" })),
    });
    expect(present.secrets.GH_TOKEN).toBe("ghp_x");
    expect(present.missingSecrets).toEqual([]);
    const absent = assembleSecrets({
      modelAuth: "OPENAI_API_KEY",
      declared,
      values: new Map(Object.entries({ OPENAI_API_KEY: "k" })),
    });
    expect(absent.missingSecrets).toEqual(["GH_TOKEN"]);
  });

  it("the environment running deploy is NOT a source — only the value file is", () => {
    // A deployment must be reproducible from what it carries, and an exported variable is written down nowhere.
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "from-the-builders-shell";
    try {
      const r = assembleSecrets({
        modelAuth: "OPENAI_API_KEY",
        declared: [{ name: "GH_TOKEN", source: "tools/gh.ts" }],
        values: new Map([["OPENAI_API_KEY", "k"]]),
      });
      expect(r.secrets.GH_TOKEN).toBeUndefined();
      expect(r.missingSecrets).toEqual(["GH_TOKEN"]);
    } finally {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
    }
  });
});

describe("deploy/secrets: deploymentSecrets (the runbook's list)", () => {
  it("required names first, hinted by their source, then everything else the value file carries", () => {
    const list = deploymentSecrets(
      "OPENAI_API_KEY",
      [{ name: "GH_TOKEN", source: "tools/gh.ts" }],
      new Map(Object.entries({ OPENAI_API_KEY: "k", GH_TOKEN: "x", EXTRA: "y", FASTAGENT_STATE_DIR: "/s" })),
      "fastagent/.secrets/.env",
    );
    expect(list).toEqual([
      { name: "OPENAI_API_KEY", hint: "your model provider key" },
      { name: "GH_TOKEN", hint: "required by tools/gh.ts" },
      { name: "EXTRA", hint: "from fastagent/.secrets/.env" },
    ]);
  });
});

describe("deploy/secrets: the FASTAGENT_ENV carrier (a host whose artifact must not name the variables)", () => {
  it("round-trips any value across chunks; a variable the platform set itself wins", () => {
    const encoded = encodeCarriedEnv({ A: "x=y", B: '"quoted"', C: "ünïcode $HOME", D: "carried" });
    const env: NodeJS.ProcessEnv = { FASTAGENT_ENV: encoded.slice(0, 5), FASTAGENT_ENV_2: encoded.slice(5), D: "box" };
    applyCarriedEnv(env);
    expect(env).toMatchObject({ A: "x=y", B: '"quoted"', C: "ünïcode $HOME", D: "box" });
    expect(encodeCarriedEnv({})).toBe("");
    const untouched: NodeJS.ProcessEnv = { X: "1" };
    applyCarriedEnv(untouched);
    expect(untouched).toEqual({ X: "1" });
  });

  it("a payload that is not an object of strings fails visibly", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
    expect(() => applyCarriedEnv({ FASTAGENT_ENV: enc(["A"]) })).toThrow(/not an object/);
    expect(() => applyCarriedEnv({ FASTAGENT_ENV: enc({ A: 1 }) })).toThrow(/A is not a string/);
  });
});

describe("deploy/secrets: missingValuesGate (one refusal, every host)", () => {
  it("names the file this deploy actually read, not a hardcoded path", () => {
    // `FASTAGENT_SECRETS_DIR` moves the value file, and four hosts each spelling the message would each have to
    // remember that. The gate takes the resolved name so it cannot point at a file deploy never opened.
    expect(missingValuesGate([], "fastagent/.secrets/.env")).toBeUndefined();
    const gate = missingValuesGate(["GH_TOKEN", "X_API_KEY"], "/data/.secrets/.env");
    expect(gate).toContain("GH_TOKEN, X_API_KEY");
    expect(gate).toContain("/data/.secrets/.env");
    expect(gate).not.toMatch(/\n/); // one line: it is printed straight into an Error
  });
});
