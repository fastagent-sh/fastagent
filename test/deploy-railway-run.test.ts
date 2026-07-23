import { describe, expect, it, vi } from "vitest";
import {
  type RailwayRunPlan,
  deployRailwayRun,
  isLinked,
  linkedName,
  parseDomainUrl,
  parseHasVolume,
} from "../src/deploy/railway/run.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** A fake railway CLI: records every call, returns per-command scripted results (default code 0, empty). */
function fakeRailway(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const railway: CliRunner = async (args, opts) => {
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
  intoLinked: false,
  ...over,
});

// `railway status --json` for a linked project — only the top-level `name` is used (for the gate/log).
// Mirrors the real 5.15.0 sample (keys {buckets, deletedAt, environments, id, name, services, workspace}).
const LINKED = JSON.stringify({ name: "bot", id: "proj-1" });
// A minted domain, as `railway domain --json` would return it (field name unknown → parser scans values).
const DOMAIN_JSON = JSON.stringify({ domain: "bot-production.up.railway.app" });

const run = (
  p: RailwayRunPlan,
  railway: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
) => deployRailwayRun(p, railway, () => {}, tg);

describe("deploy/railway/run: the coding-agent deploy journey (benchmark)", () => {
  it("fresh (unlinked): auth → init+add+volume → variables → up → domain → telegram webhook", async () => {
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" }; // unlinked → create
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
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
      "variables set FASTAGENT_STATE_DIR=/data --service bot", // first --service cmd, BEFORE the volume
      "variables set TELEGRAM_BOT_TOKEN --stdin --service bot",
      "variables set TELEGRAM_SECRET_TOKEN --stdin --service bot",
      "volume list --json",
      "volume add --mount-path /data",
      "up --ci --service bot",
      "domain --json --service bot", // bare `domain` only — NOT `domain list` (destructive on older CLIs)
    ]);
    expect(tg).toHaveBeenCalledWith("https://bot-production.up.railway.app");
  });

  it("gates when a webhook registration terminally fails — after attempting the remaining channels", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployRailwayRun(
      plan({ channels: ["telegram", "feishu"] }),
      railway,
      () => {},
      vi.fn(async (): Promise<RegistrationOutcome> => "failed"), // telegram registration ends with the webhook NOT set
      registerFeishu,
    );

    // Exit 0 here would tell a coding agent "done" while the agent can't receive messages.
    expect(out).toEqual({
      ok: false,
      gate: expect.stringMatching(/webhook registration failed for: telegram/),
    });
    expect(registerFeishu).toHaveBeenCalledWith("https://bot-production.up.railway.app", "feishu"); // one failure doesn't skip the rest
  });

  it("dispatches Feishu and Lark registration through the per-kind seam", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );

    const out = await deployRailwayRun(
      plan({ channels: ["feishu", "lark"] }),
      railway,
      () => {},
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      registerFeishu,
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(registerFeishu.mock.calls).toEqual([
      ["https://bot-production.up.railway.app", "feishu"],
      ["https://bot-production.up.railway.app", "lark"],
    ]);
  });

  it("dispatches Slack registration through the local onboarding seam", async () => {
    const { railway } = fakeRailway((args) => {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const registerSlack = vi.fn(async (_baseUrl: string): Promise<RegistrationOutcome> => "registered");

    const out = await deployRailwayRun(
      plan({ channels: ["slack"] }),
      railway,
      () => {},
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      undefined,
      registerSlack,
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(registerSlack).toHaveBeenCalledWith("https://bot-production.up.railway.app");
  });

  it("reports Slack's Events API URL as a manual non-gating registration step", async () => {
    const { railway } = fakeRailway((args) => {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const logs: string[] = [];

    const out = await deployRailwayRun(
      plan({ channels: ["slack"] }),
      railway,
      (message) => logs.push(message),
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(logs.join("\n")).toContain("https://bot-production.up.railway.app/slack");
    expect(logs.at(-1)).toMatch(/slack: webhook registration needs a one-time manual step/);
  });

  it("does not register a long-connection Lark channel as a webhook", async () => {
    const { railway } = fakeRailway((args) => {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const registerFeishu = vi.fn(
      async (_baseUrl: string, _kind: "feishu" | "lark"): Promise<RegistrationOutcome> => "registered",
    );
    const out = await deployRailwayRun(
      plan({ channels: ["lark"], longConnectionChannels: ["lark"] }),
      railway,
      () => {},
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
      registerFeishu,
    );
    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(registerFeishu).not.toHaveBeenCalled();
  });

  it("prints each Feishu-cloud Request URL when no registrar is supplied", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" };
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const logs: string[] = [];

    const out = await deployRailwayRun(
      plan({ channels: ["feishu", "lark"] }),
      railway,
      (message) => logs.push(message),
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
    );

    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(logs.join("\n")).toContain("https://bot-production.up.railway.app/feishu");
    expect(logs.join("\n")).toContain("https://bot-production.up.railway.app/lark");
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

  it("--into-linked: provisions INTO the linked project (skips init/add), reuses an existing volume", async () => {
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: LINKED }; // linked
      if (a[0] === "volume" && a[1] === "list") return { stdout: `[{"mountPath":"/data"}]` }; // volume present
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const out = await run(plan({ intoLinked: true }), railway);
    expect(out).toEqual({ ok: true, url: "https://bot-production.up.railway.app" });
    expect(cmds()).not.toContain("init --name bot"); // never re-create (would duplicate the project)
    expect(cmds()).not.toContain("add --service bot");
    expect(cmds()).not.toContain("volume add --mount-path /data"); // volume already present → not re-added
    expect(cmds()).toContain("up --ci --service bot");
    expect(cmds()).not.toContain("domain list --json --service bot"); // never the destructive list subcommand
  });

  it("--into-linked with a MISSING volume heals it (check-then-act) — no deploy without persistence", async () => {
    const { railway, cmds } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: LINKED };
      if (a[0] === "volume" && a[1] === "list") return { stdout: "[]" }; // NO volume
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const out = await run(plan({ intoLinked: true }), railway);
    expect(out.ok).toBe(true);
    expect(cmds()).not.toContain("init --name bot");
    expect(cmds()).toContain("volume add --mount-path /data"); // heals the missing volume
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

  it("gate: a linked dir with an UNREADABLE status is still refused (not mistaken for unlinked → duplicate)", async () => {
    // Non-empty status we can't parse — any non-empty output counts as linked. Refuse (don't init a
    // duplicate); the message admits the name is unreadable rather than claiming a specific project.
    const { railway, cmds } = fakeRailway((a) => (a[0] === "status" ? { stdout: "weird non-json output" } : {}));
    const out = await run(plan(), railway);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.gate).toMatch(/name unreadable|--into-linked/);
    expect(cmds()).toEqual(["whoami", "status --json"]); // no init
  });

  it("warns when --into-linked is passed on an UNLINKED dir (the flag would otherwise be a silent no-op)", async () => {
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" }; // unlinked
      if (a[0] === "domain") return { stdout: DOMAIN_JSON };
      return {};
    });
    const logs: string[] = [];
    await deployRailwayRun(
      plan({ intoLinked: true }),
      railway,
      (m) => logs.push(m),
      vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
    );
    expect(logs.join("\n")).toMatch(/--into-linked.*isn't linked|creating a fresh/i);
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

  it("gate: `railway add --service` failure gives PRECISE recovery (project made, service not)", async () => {
    // init OK (dir now linked) → add fails. A plain re-run would hit the linked-gate, and --into-linked
    // skips add → fails at the volume (no service). So the gate must name the exact manual recovery, not
    // just "fix and re-run" (which the deleted marker design had, and the redesign must not lose).
    const { railway } = fakeRailway((a) => {
      if (a[0] === "status") return { stdout: "" }; // unlinked → create path
      if (a[0] === "add") return { code: 1 }; // service creation fails after init
      return {};
    });
    const out = await run(plan(), railway);
    expect(out.ok).toBe(false);
    const gate = out.ok ? "" : out.gate;
    expect(gate).toContain("railway add --service bot"); // the exact manual step to run
    expect(gate).toMatch(/--into-linked/); // ...then --into-linked
    expect(gate).toMatch(/railway unlink/); // ...or unlink to restart
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

describe("deploy/railway/run: pure parsers", () => {
  it("isLinked: non-empty stdout = linked; empty = not (status exits 0 either way)", () => {
    expect(isLinked(LINKED)).toBe(true);
    expect(isLinked("weird non-json")).toBe(true); // any non-empty output counts as linked (refuse-safe)
    expect(isLinked("")).toBe(false); // unlinked: message → stderr, stdout empty
    expect(isLinked("   \n")).toBe(false);
  });

  it("linkedName: the top-level name when present; undefined when unparseable (still linked)", () => {
    expect(linkedName(LINKED)).toBe("bot");
    expect(linkedName("not json")).toBeUndefined();
    expect(linkedName(JSON.stringify({ id: "p1" }))).toBeUndefined(); // no name
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
