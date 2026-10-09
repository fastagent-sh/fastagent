import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enterAgentDirectory, reportAssembly, reportAuth } from "../src/cli/shared.ts";
import { setLogLevel } from "../src/log.ts";
import * as models from "../src/engines/pi/models.ts";
import { agentModels } from "../src/engines/pi/agent-models.ts";
import { GLOBAL_AUTH_PATH } from "../src/engines/pi/auth.ts";

// enterAgentDirectory installs the proxy fetch, and undici.install() swaps this process's fetch/Response/
// Headers/FormData/WebSocket with no way back. Keep the side effect out of the test process.
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

describe("reportAssembly (the startup report dev and start share)", () => {
  const opened = {
    agentDir: "/w/agent",
    contexts: [{ name: "app", kind: "local", readonly: false, location: "/w/app", notices: [] }],
    modelSpec: "p/m",
    models: agentModels("/w/agent", { authPath: "/w/agent/.secrets/auth.json" }),
    config: {},
    definition: {
      dir: "/w/agent",
      skills: [{ name: "release" }],
      collisions: [],
      diagnostics: [],
    },
    toolNames: ["fetch-url"],
    indirectTools: [],
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
    expect(spine.slice(0, 4)).toEqual(["agent", "works on", "model", "auth"]);
    expect(spine).toContain("prompt");
    expect(spine).toContain("skills");
    expect(spine).toContain("codingTools");
    expect(spine).toContain("tools");
    expect(spine).not.toContain("deferred"); // omitted when there are none
  });

  it("places each command's extras where that command puts them", async () => {
    const dev = await lines({ beforeModel: [["config", "/w/agent/fastagent.config.ts"]] });
    expect(dev.indexOf("config")).toBe(2); // after agent and its contexts, before model
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

describe("enterAgentDirectory: --no-input never reaches the picker", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.stdin.isTTY = undefined as unknown as boolean;
    process.stdout.isTTY = undefined as unknown as boolean;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** An agent with NO model set, so the picker is the only thing that could answer. */
  const modellessAgent = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "fastagent-prelude-"));
    dirs.push(dir);
    writeFileSync(join(dir, "fastagent.config.ts"), "export default {};\n");
    return dir;
  };

  // `dev`'s worker passes input:false so the supervisor's pick is not re-asked in a child process.
  // The guard is resolveFirstRunModel returning BEFORE isInteractive(), so a worker that inherits a
  // terminal still stays silent — which is exactly the case a TTY-less test would pass either way.
  it("returns without building a model runtime, even when stdin and stdout are terminals", async () => {
    // A model from the environment satisfies resolveFirstRunModel before it reads `input`, so leaving
    // FASTAGENT_MODEL set would pass this test without ever running the guard.
    vi.stubEnv("FASTAGENT_MODEL", undefined);
    const runtime = vi.spyOn(models, "createPiModelRuntime");
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    const dir = modellessAgent();
    // The directory half, which owns the picker: the full command then refuses the missing default at startup.
    expect(await enterAgentDirectory(dir, { input: false })).toEqual({ agentDir: dir });
    expect(runtime).not.toHaveBeenCalled();
  });
});

describe("reportAuth (which layer the line names)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(GLOBAL_AUTH_PATH, { force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * An agent's own credentials file and the global one behind it (this file's own HOME, test/setup.ts); `where` (if
   * given) gets the stored credential for provider `p`.
   */
  const layers = (where?: "primary" | "fallback") => {
    vi.stubEnv("FASTAGENT_AUTH_PATH", undefined);
    vi.stubEnv("FASTAGENT_SECRETS_DIR", undefined);
    const dir = mkdtempSync(join(tmpdir(), "fastagent-auth-layer-"));
    dirs.push(dir);
    const primary = join(dir, ".secrets", "auth.json");
    const fallback = GLOBAL_AUTH_PATH;
    mkdirSync(dirname(primary), { recursive: true });
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(primary, "{}\n");
    writeFileSync(fallback, "{}\n");
    if (where)
      writeFileSync(
        where === "primary" ? primary : fallback,
        `${JSON.stringify({ p: { type: "api_key", key: "k" } })}\n`,
      );
    return { dir, primary, fallback };
  };

  /** The single `auth:` line, at the default `info` level. */
  const authLine = async (agentDir: string): Promise<string> => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
    try {
      await reportAuth(agentModels(agentDir), "p/m", agentDir);
    } finally {
      spy.mockRestore();
    }
    return out.find((l) => l.includes("auth:")) ?? "";
  };

  it.each([false, true])(
    "production recovery names the selected files (explicit auth override: %s)",
    async (override) => {
      const held = layers("fallback");
      vi.stubEnv("FASTAGENT_ENVIRONMENT", "production");
      vi.stubEnv("FASTAGENT_RELEASE_FILE", undefined);
      const authPath = override ? join(held.dir, "custom-auth.json") : join(held.dir, ".secrets/production/auth.json");
      if (override) vi.stubEnv("FASTAGENT_AUTH_PATH", authPath);
      const out: string[] = [];
      vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
      await reportAuth(agentModels(held.dir), "p/m", held.dir);
      expect(out.join("\n")).toContain(`FASTAGENT_AUTH_PATH='${authPath}' fastagent login`);
      if (!override) expect(out.join("\n")).toContain(held.fallback);

      rmSync(GLOBAL_AUTH_PATH);
      out.length = 0;
      await reportAuth(agentModels(held.dir), "p/m", held.dir);
      expect(out.join("\n")).toContain(join(held.dir, ".secrets/production/.env"));
      expect(out.join("\n")).toContain(`FASTAGENT_AUTH_PATH='${authPath}' fastagent login`);
    },
  );

  it("names the fallback only when the fallback is the layer holding the credential", async () => {
    // Provider "p" is not a real pi provider, so nothing satisfies auth and the line reports what is STORED —
    // which is the read this test is about.
    const held = layers("fallback");
    expect(await authLine(held.dir)).toContain(held.fallback);

    const mine = layers("primary");
    expect(await authLine(mine.dir)).toContain(mine.primary);

    // Neither layer: the file to edit is the one `fastagent login` writes — the primary.
    const none = layers();
    const line = await authLine(none.dir);
    expect(line).toContain("(none found)");
    expect(line).toContain(none.primary);
  });

  it("does not name the fallback for a provider the project authenticates itself", async () => {
    // The runtime never reads the global file for it, so the line must not point there either.
    const held = layers("fallback");
    writeFileSync(
      join(held.dir, "models.json"),
      JSON.stringify({
        providers: {
          p: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m" }] },
        },
      }),
    );
    const line = await authLine(held.dir);
    expect(line).not.toContain(held.fallback);
    expect(line).toContain(held.primary);
  });
});
