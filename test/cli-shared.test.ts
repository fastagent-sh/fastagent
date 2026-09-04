import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enterAgentCommand, loginWithKeyCheck, reportAssembly } from "../src/cli/shared.ts";
import { setLogLevel } from "../src/log.ts";
import { LoginCancelled, type LoginMethod } from "../src/engines/pi/login.ts";
import * as models from "../src/engines/pi/models.ts";

/** Record every flow call's (provider, method) and pop canned results/verdicts in order. */
function fakes(
  results: Array<{ provider: string; method: LoginMethod }>,
  verdicts: Array<"ok" | "rejected" | "unknown">,
) {
  const flowCalls: Array<{ provider?: string; method?: LoginMethod }> = [];
  const verifyCalls: string[] = [];
  return {
    flowCalls,
    verifyCalls,
    flow: async (_io: unknown, options: { provider?: string; method?: LoginMethod }) => {
      flowCalls.push({ provider: options.provider, method: options.method });
      return results[flowCalls.length - 1] as { provider: string; method: LoginMethod };
    },
    verify: async (provider: string) => {
      verifyCalls.push(provider);
      return verdicts[verifyCalls.length - 1] as "ok" | "rejected" | "unknown";
    },
  };
}

describe("loginWithKeyCheck (the rejected-key retry loop)", () => {
  it("rejected → re-asks ONLY the key (provider+method pinned), exits on ok", async () => {
    const f = fakes(
      [
        { provider: "deepseek", method: "api_key" },
        { provider: "deepseek", method: "api_key" },
      ],
      ["rejected", "ok"],
    );
    const result = await loginWithKeyCheck(undefined, "/tmp/auth.json", "deepseek/chat", f);
    expect(result).toEqual({ provider: "deepseek", method: "api_key" });
    // First pass: nothing pinned (user picks provider/method); retry pins BOTH so only the key is re-asked.
    expect(f.flowCalls).toEqual([
      { provider: undefined, method: undefined },
      { provider: "deepseek", method: "api_key" },
    ]);
    expect(f.verifyCalls).toEqual(["deepseek", "deepseek"]);
  });

  it("unknown keeps the key and exits (no retry); OAuth skips verification entirely", async () => {
    const unknown = fakes([{ provider: "p", method: "api_key" }], ["unknown"]);
    await loginWithKeyCheck("p", "/tmp/auth.json", undefined, unknown);
    expect(unknown.flowCalls).toHaveLength(1); // no re-prompt on unverifiable

    const oauth = fakes([{ provider: "openai-codex", method: "oauth" }], []);
    await loginWithKeyCheck(undefined, "/tmp/auth.json", undefined, oauth);
    expect(oauth.verifyCalls).toEqual([]); // completing the flow already proved the credential
  });

  it("cancel inside the retry propagates (caller's cancel policy decides)", async () => {
    const f = fakes([{ provider: "p", method: "api_key" }], ["rejected"]);
    const flow = async (io: unknown, options: { provider?: string; method?: LoginMethod }) => {
      if (options.method === "api_key") throw new LoginCancelled("cancelled"); // the re-prompt round
      return f.flow(io, options);
    };
    await expect(
      loginWithKeyCheck(undefined, "/tmp/auth.json", undefined, { flow, verify: f.verify }),
    ).rejects.toBeInstanceOf(LoginCancelled);
  });
});

describe("reportAssembly (the startup report dev and start share)", () => {
  const opened = {
    agentDir: "/w/agent",
    workspace: "/w",
    modelSpec: "p/m",
    authPath: "/w/agent/.secrets/auth.json",
    config: {},
    definition: {
      dir: "/w/agent",
      contextFiles: [{ path: "AGENTS.md" }],
      skills: [{ name: "release" }],
      collisions: [],
      diagnostics: [],
    },
    toolNames: ["fetch-url"],
    deferredToolNames: [],
    toolCollisions: [],
    toolFailures: [],
  } as unknown as Parameters<typeof reportAssembly>[0];

  /** The report writes through the leveled logger; `info` is the posture both commands report at. */
  const lines = async (extras?: Parameters<typeof reportAssembly>[1]): Promise<string[]> => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
    setLogLevel("info");
    try {
      await reportAssembly(opened, extras);
    } finally {
      spy.mockRestore();
      setLogLevel("info"); // restore the default the other suites rely on — the level is a module singleton
    }
    // Lines arrive as `INFO  [fastagent] <label>: <value>`; the label is what this pins.
    return out.map(
      (l) =>
        l
          .replace(/^\S+\s+\[fastagent\]\s+/, "")
          .split(":")[0]
          ?.trim() ?? "",
    );
  };

  it("prints ONE spine, in order — the thing the two commands each used to write out by hand", async () => {
    // `auth` is reportAuth's line; it reads real credentials, so only its position is pinned here.
    const spine = await lines();
    expect(spine.slice(0, 3)).toEqual(["agent", "workspace", "model"]);
    expect(spine).toContain("context");
    expect(spine).toContain("skills");
    expect(spine).toContain("codingTools");
    expect(spine).toContain("tools");
    expect(spine).not.toContain("deferred"); // omitted when there are none
  });

  it("places each command's extras where that command puts them", async () => {
    const dev = await lines({ beforeModel: [["config", "/w/agent/fastagent.config.mjs"]] });
    expect(dev.indexOf("config")).toBe(2); // after agent/workspace, before model
    expect(dev.indexOf("config")).toBeLessThan(dev.indexOf("model"));

    const start = await lines({
      afterTools: [
        ["state", "/w/agent/.state"],
        ["sessions", "/w/s"],
      ],
    });
    expect(start.indexOf("state")).toBeGreaterThan(start.indexOf("codingTools"));
    expect(start.slice(-2)).toEqual(["state", "sessions"]);
    expect(start).not.toContain("config"); // start's report has never named it
  });
});

describe("enterAgentCommand: --no-input never reaches the picker", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.stdin.isTTY = undefined as unknown as boolean;
    process.stdout.isTTY = undefined as unknown as boolean;
    vi.restoreAllMocks();
  });

  /** An agent with NO model set, so the picker is the only thing that could answer. */
  const modellessAgent = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "fastagent-prelude-"));
    dirs.push(dir);
    writeFileSync(join(dir, "fastagent.config.mjs"), "export default {};\n");
    return dir;
  };

  // `dev`'s worker passes input:false so the supervisor's pick is not re-asked in a child process.
  // The guard is resolveFirstRunModel returning BEFORE isInteractive(), so a worker that inherits a
  // terminal still stays silent — which is exactly the case a TTY-less test would pass either way.
  it("returns without building a model runtime, even when stdin and stdout are terminals", async () => {
    const runtime = vi.spyOn(models, "createPiModelRuntime");
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    const dir = modellessAgent();
    const placement = await enterAgentCommand(dir, { input: false });

    expect(placement.agentDir).toBe(dir);
    expect(runtime).not.toHaveBeenCalled();
  });
});
