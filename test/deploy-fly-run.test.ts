import { describe, expect, it, vi } from "vitest";
import {
  type FlyRunPlan,
  type FlyRunner,
  assembleFlySecrets,
  authSeedBytes,
  deployFlyRun,
} from "../src/deploy/fly-run.ts";

/** A fake flyctl: records every call, returns per-command scripted results (default code 0, empty out). */
function fakeFly(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const fly: FlyRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  };
  return { fly, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const plan = (over: Partial<FlyRunPlan> = {}): FlyRunPlan => ({
  appName: "bot",
  region: "iad",
  secrets: {},
  missingSecrets: [],
  channels: [],
  flyConfig: "fly.toml",
  ...over,
});

const run = (p: FlyRunPlan, fly: FlyRunner, tg = vi.fn(async () => {})) => deployFlyRun(p, fly, () => {}, tg);

describe("deploy/fly-run: the coding-agent deploy journey (benchmark)", () => {
  it("happy path: auth → create app+volume → set secrets → deploy → telegram webhook", async () => {
    // Fresh account: apps/volumes lists are empty, everything succeeds.
    const { fly, cmds } = fakeFly((a) => (a[0] === "apps" || a[0] === "volumes" ? { stdout: "[]" } : {}));
    const tg = vi.fn(async () => {});
    const out = await run(
      plan({ channels: ["telegram"], secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" } }),
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
      "secrets import --stage -a bot",
      "deploy -a bot -c fly.toml --remote-only --yes --ha=false",
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot.fly.dev"); // telegram end-to-end
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
    expect(cmds()).toContain("deploy -a bot -c fly.toml --remote-only --yes --ha=false");
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

describe("deploy/fly-run: assembleFlySecrets (credential wiring)", () => {
  it("an env-key model auth travels as its own secret (value from env)", () => {
    const r = assembleFlySecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: [],
      env: { OPENAI_API_KEY: "sk-x" },
    });
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "sk-x" });
    expect(r.needsModelCredential).toBe(false);
  });

  it("OAuth/stored auth (no env key) rides as a base64 FASTAGENT_AUTH_SEED", () => {
    const r = assembleFlySecrets({ modelAuth: "OAuth", authFile: Buffer.from('{"a":1}'), channels: [], env: {} });
    expect(r.secrets.FASTAGENT_AUTH_SEED).toBe(Buffer.from('{"a":1}').toString("base64"));
    expect(r.needsModelCredential).toBe(false);
  });

  it("no env key AND no auth file → needsModelCredential (its own login gate, NOT missingSecrets)", () => {
    const r = assembleFlySecrets({ modelAuth: undefined, authFile: undefined, channels: [], env: {} });
    expect(r.needsModelCredential).toBe(true);
    expect(r.missingSecrets).toEqual([]);
  });

  it("channel secrets come from env; never minted (a re-run is stable; a human-shared secret stays known)", () => {
    const env = { OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_SECRET_TOKEN: "sec" };
    const r = assembleFlySecrets({ modelAuth: "OPENAI_API_KEY", authFile: undefined, channels: ["telegram"], env });
    expect(r.secrets.TELEGRAM_SECRET_TOKEN).toBe("sec"); // from env, not a mint
    expect(r.missingSecrets).toEqual([]);
  });

  it("any absent channel secret — including a scaffold `generate` one — lands in missingSecrets (never minted)", () => {
    // github's webhook secret is human-shared: it MUST be operator-provided, not silently minted.
    const r = assembleFlySecrets({
      modelAuth: "OPENAI_API_KEY",
      authFile: undefined,
      channels: ["github", "telegram"],
      env: { OPENAI_API_KEY: "k" },
    });
    expect(r.missingSecrets).toEqual(["GITHUB_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"]);
    expect(r.secrets).toEqual({ OPENAI_API_KEY: "k" }); // no minted values
  });
});

describe("deploy/fly-run: authSeedBytes (the start-side seed guard)", () => {
  it("seeds only when the seed is set AND the auth file is absent (absent-only — no rollback)", () => {
    expect(authSeedBytes(undefined, false)).toBeUndefined(); // no seed → no-op
    expect(authSeedBytes(Buffer.from("hi").toString("base64"), true)).toBeUndefined(); // file present → never clobber
    expect(authSeedBytes(Buffer.from("hi").toString("base64"), false)?.toString()).toBe("hi"); // absent → materialize
  });
});
