import { describe, expect, it, vi } from "vitest";
import {
  type RailwayRunPlan,
  type RailwayRunner,
  deployRailwayRun,
  parseDomainUrl,
  parseHasVolume,
  parseLinked,
} from "../src/deploy/railway-run.ts";

/** A fake railway CLI: records every call, returns per-command scripted results (default code 0, empty). */
function fakeRailway(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const railway: RailwayRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  };
  return { railway, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const plan = (over: Partial<RailwayRunPlan> = {}): RailwayRunPlan => ({
  name: "bot",
  mountPath: "/data",
  secrets: {},
  missingSecrets: [],
  channels: [],
  ...over,
});

const run = (p: RailwayRunPlan, railway: RailwayRunner, tg = vi.fn(async () => {})) =>
  deployRailwayRun(p, railway, () => {}, tg);

// A minted domain, as `railway domain --json` would return it (field name unknown → parser scans values).
const DOMAIN_JSON = JSON.stringify({ domain: "bot-production.up.railway.app" });

describe("deploy/railway-run: the coding-agent deploy journey (benchmark)", () => {
  it("fresh: auth → init+add+volume → variables → up → domain → telegram webhook", async () => {
    // Unlinked (status stdout empty); everything succeeds; bare `railway domain` returns/mints the URL.
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" }; // unlinked
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const tg = vi.fn(async () => {});
    const out = await run(
      plan({ channels: ["telegram"], secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" } }),
      railway,
      tg,
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(cmds()).toEqual([
      "whoami",
      "status --json",
      "init --name bot",
      "add --service bot",
      "volume list --json",
      "volume add --mount-path /data",
      "variables set FASTAGENT_STATE_DIR=/data --service bot",
      "variables set TELEGRAM_BOT_TOKEN --stdin --service bot",
      "variables set TELEGRAM_SECRET_TOKEN --stdin --service bot",
      "up --ci --service bot",
      "domain --json --service bot", // bare `domain` only — NOT `domain list` (destructive on older CLIs)
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot-production.up.railway.app");
  });

  it("secret values go over stdin (variable set --stdin), never argv", async () => {
    const { railway, calls } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    await run(plan({ secrets: { OPENAI_API_KEY: "sk-x", FASTAGENT_AUTH_SEED: "b64" } }), railway);
    const setKey = calls.find((c) => c.args[0] === "variables" && c.args[2] === "OPENAI_API_KEY")!;
    expect(setKey.args.join(" ")).not.toContain("sk-x"); // not in argv
    expect(setKey.args).toContain("--stdin");
    expect(setKey.input).toBe("sk-x"); // on stdin
  });

  it("redeploy: a linked project skips init/add, reuses the existing volume, still sets vars + up", async () => {
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: JSON.stringify({ project: "bot", service: "bot" }) }; // linked
      if (a[0] === "volume" && a[1] === "list") return { stdout: `[{"mountPath":"/data"}]` }; // volume present
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const out = await run(plan(), railway);
    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(cmds()).not.toContain("init --name bot"); // re-running init would DUPLICATE the project/service
    expect(cmds()).not.toContain("add --service bot");
    expect(cmds()).not.toContain("volume add --mount-path /data"); // volume already present → not re-added
    expect(cmds()).toContain("up --ci --service bot"); // redeploy still happens
    expect(cmds()).not.toContain("domain list --json --service bot"); // never the destructive list subcommand
  });

  it("linked but volume MISSING (half-provisioned prior run) → volume is re-created, not silently skipped", async () => {
    // add succeeded, volume add failed on a prior run: status is linked yet no volume. parseLinked=true
    // must NOT be read as "fully provisioned" — else the deploy has no persistence (silent state loss).
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: JSON.stringify({ project: "bot" }) }; // linked
      if (a[0] === "volume" && a[1] === "list") return { stdout: "[]" }; // NO volume
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const out = await run(plan(), railway);
    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(cmds()).not.toContain("init --name bot"); // still skips creation (avoid dup project)
    expect(cmds()).toContain("volume add --mount-path /data"); // ...but heals the missing volume
  });

  it("gate: not logged in → stops before any side effect", async () => {
    const { railway, cmds } = fakeRailway((a) => (a[0] === "whoami" ? { code: 1 } : {}));
    const out = await run(plan(), railway);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/railway login|RAILWAY_API_KEY/) });
    expect(cmds()).toEqual(["whoami"]); // nothing after the gate
  });

  it("gate: a missing secret value stops before creating infra", async () => {
    const { railway, cmds } = fakeRailway();
    const out = await run(plan({ missingSecrets: ["TELEGRAM_BOT_TOKEN"] }), railway);
    expect(out).toEqual({ ok: false, gate: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(cmds()).toEqual(["whoami"]); // no init
  });

  it("gate: `railway init` failure surfaces the workspace hint", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "init") return { code: 1 };
      return {};
    });
    const out = await run(plan(), railway);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/workspace/) });
  });

  it("gate: an unreadable domain stops with the manual instruction (no silent success)", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "domain") return { stdout: "not-json" }; // `railway domain --json` returns unreadable output
      return {};
    });
    const out = await run(plan({ channels: ["telegram"] }), railway);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/railway domain/) });
  });
});

describe("deploy/railway-run: pure parsers", () => {
  it("parseLinked: JSON on stdout = linked; empty/non-JSON = not (status exits 0 either way)", () => {
    expect(parseLinked(JSON.stringify({ project: "x" }))).toBe(true);
    expect(parseLinked("")).toBe(false); // unlinked prints its message to stderr, stdout empty
    expect(parseLinked("No linked project found")).toBe(false);
  });

  it("parseDomainUrl: finds a *.railway.app host anywhere in the JSON, as https; else undefined", () => {
    expect(parseDomainUrl(JSON.stringify({ domain: "bot-production.up.railway.app" }))).toBe(
      "https://bot-production.up.railway.app",
    );
    expect(parseDomainUrl(JSON.stringify([{ domain: "a.up.railway.app" }]))).toBe("https://a.up.railway.app");
    // Robust to format, not just field name: a value carrying scheme/path still yields the bare host.
    expect(parseDomainUrl(JSON.stringify({ url: "https://bot.up.railway.app/" }))).toBe("https://bot.up.railway.app");
    expect(parseDomainUrl("[]")).toBeUndefined();
    expect(parseDomainUrl("not json")).toBeUndefined();
  });

  it("parseHasVolume: true iff the mount path appears in the volume list JSON (shape-agnostic)", () => {
    expect(parseHasVolume(`[{"mountPath":"/data"}]`, "/data")).toBe(true);
    expect(parseHasVolume(`[{"mountPath":"/other"}]`, "/data")).toBe(false);
    expect(parseHasVolume("[]", "/data")).toBe(false); // no volume → (re)create it
    expect(parseHasVolume("", "/data")).toBe(false); // failed/empty list → treat as absent
  });
});
