import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createPiAgentFromWorkspace, createPiModels, listModels, probeAuthSource, resolveModel } from "../src/index.ts";
import {
  defaultAuthPath,
  defaultSessionsDir,
  loadConfig,
  resolveAuthPathOverride,
  resolveModelSpec,
  resolveSessionsDirOverride,
  resolveStateRoot,
} from "../src/engines/pi/config.ts";
import { resolveTools } from "../src/engines/pi/create.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("config: resolveSessionsDirOverride (start's sessions precedence)", () => {
  it("precedence --sessions-dir > FASTAGENT_SESSIONS_DIR > none; a given value resolves to absolute", () => {
    const env = { FASTAGENT_SESSIONS_DIR: "envdir" } as NodeJS.ProcessEnv;
    // the footgun this guards: a regression here silently drops sessions back to the in-tree default,
    // so a redeploy wipes conversations. Distinct, non-tautological assertions per precedence tier:
    expect(resolveSessionsDirOverride("flagdir", env)).toBe(resolve("flagdir")); // flag beats env
    expect(resolveSessionsDirOverride(undefined, env)).toBe(resolve("envdir")); // env when no flag
    expect(resolveSessionsDirOverride(undefined, {} as NodeJS.ProcessEnv)).toBeUndefined(); // neither → opener default
    expect(resolveSessionsDirOverride("/mnt/vol", {} as NodeJS.ProcessEnv)).toBe("/mnt/vol"); // absolute kept as-is
  });
});

describe("config: resolveStateRoot (the ONE machine-state root)", () => {
  it("env overrides; default is the absolute in-tree .fastagent; ~ expands", async () => {
    const env = { FASTAGENT_STATE_DIR: "/data" } as NodeJS.ProcessEnv;
    expect(resolveStateRoot("/app", env)).toBe("/data"); // env wins
    expect(resolveStateRoot("relative/dir", {} as NodeJS.ProcessEnv)).toBe(resolve("relative/dir", ".fastagent")); // absolute default
    const { homedir } = await import("node:os");
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "~/state" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), "state"),
    );
    // A RELATIVE override is an operator knob — anchored on cwd (its sibling knobs' convention), NOT on
    // `dir`; only the default is dir-anchored. So it ignores `dir` and resolves against process.cwd().
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "state" } as NodeJS.ProcessEnv)).toBe(resolve("state"));
  });

  it("sessions and auth defaults derive from the resolved root (one volume covers everything)", () => {
    const root = resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "/data" } as NodeJS.ProcessEnv);
    expect(defaultSessionsDir(root)).toBe("/data/sessions");
    expect(defaultAuthPath(root)).toBe("/data/auth.json");
  });
});

describe("models: createPiModels honors authPath (the project-level credential seam)", () => {
  it("reads a stored credential from the GIVEN file, not the global default or env", async () => {
    // Point createPiModels at a path and it must read THAT file. "stored credential" (not the
    // "ANTHROPIC_API_KEY" env label) proves the file at authPath won — so an empty project file
    // genuinely reads as not-configured, which is what the startup auth report keys on.
    const path = join(await mkdtemp(join(tmpdir(), "fa-auth-")), "auth.json");
    await writeFile(path, JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }));
    expect(await probeAuthSource(createPiModels({ authPath: path }), "anthropic/claude-sonnet-4-5")).toBe(
      "stored credential",
    );
  });
});

describe("config: resolveAuthPathOverride (auth-file precedence)", () => {
  it("precedence --auth-path > FASTAGENT_AUTH_PATH > none; a given value resolves to absolute", () => {
    const env = { FASTAGENT_AUTH_PATH: "envauth.json" } as NodeJS.ProcessEnv;
    expect(resolveAuthPathOverride("flagauth.json", env)).toBe(resolve("flagauth.json")); // flag beats env
    expect(resolveAuthPathOverride(undefined, env)).toBe(resolve("envauth.json")); // env when no flag
    expect(resolveAuthPathOverride(undefined, {} as NodeJS.ProcessEnv)).toBeUndefined(); // neither → opener default
    expect(resolveAuthPathOverride("/abs/auth.json", {} as NodeJS.ProcessEnv)).toBe("/abs/auth.json"); // absolute kept
  });

  it("expands a leading ~ to the home dir (a .env value never gets the shell's expansion)", async () => {
    const { homedir } = await import("node:os");
    const env = { FASTAGENT_AUTH_PATH: "~/.fastagent/auth.json" } as NodeJS.ProcessEnv;
    // the footgun this guards: a bare resolve("~/x") makes a literal `<cwd>/~` dir and the secret lands there
    expect(resolveAuthPathOverride(undefined, env)).toBe(join(homedir(), ".fastagent", "auth.json"));
    expect(resolveAuthPathOverride("~", {} as NodeJS.ProcessEnv)).toBe(homedir());
    expect(resolveSessionsDirOverride(undefined, { FASTAGENT_SESSIONS_DIR: "~/s" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), "s"),
    ); // symmetric: sessions had the same latent bug
  });
});

describe("config: listModels (fastagent models discovery)", () => {
  it("lists well-formed provider/modelId specs, sorted, that resolveModel accepts", () => {
    const models = createPiModels();
    const specs = listModels(models);
    expect(specs.length).toBeGreaterThan(0);
    // every entry is a "provider/modelId" and round-trips through resolveModel (the list is the
    // discovery surface for exactly what --model / config accepts).
    for (const spec of specs) {
      // provider (no slash) + "/" + non-empty modelId (which MAY contain slashes, e.g.
      // cloudflare-ai-gateway/workers-ai/@cf/...); resolveModel splits on the first slash.
      expect(spec).toMatch(/^[^/]+\/.+$/);
      expect(() => resolveModel(models, spec)).not.toThrow();
    }
    expect(specs).toEqual([...specs].sort()); // sorted
    expect(specs).toContain("openai-codex/gpt-5.5"); // the spec used across the repo
  });
});

describe("config: loadConfig", () => {
  it("loads the fastagent.config.ts default export, including tools passthrough", async () => {
    const { config, path } = await loadConfig(join(fixtures, "configured"));
    expect(path).toMatch(/fastagent\.config\.ts$/);
    expect(config.model).toBe("openai-codex/gpt-5.5");
    expect(config.http?.port).toBe(9999);
    expect(config.tools).toHaveLength(1);
    expect(config.tools![0]!.name).toBe("ping");
  });

  it("missing config file returns zero-config with undefined path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-empty-"));
    const { config, path } = await loadConfig(dir);
    expect(config).toEqual({});
    expect(path).toBeUndefined();
  });

  it("invalid config shape throws a clear error (fail visibly)", async () => {
    await expect(loadConfig(join(fixtures, "bad-config"))).rejects.toThrow(/must default-export/);
  });

  it("a config SYNTAX error names the file (not a raw SyntaxError + ESM stack)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: `); // truncated = parse error
    await expect(loadConfig(dir)).rejects.toThrow(/fastagent\.config\.mjs: /);
  });

  it("a config that imports a missing dep gets the same npm-install hint as tools/channels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `import "totally-not-installed-pkg";\nexport default {};`);
    await expect(loadConfig(dir)).rejects.toThrow(/fastagent\.config\.mjs: .*npm install/s);
  });

  it("validates http shape as well: non-numeric/out-of-range http.port throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { http: { port: "oops" } };`);
    await expect(loadConfig(dir)).rejects.toThrow(/"http\.port" must be an integer/);
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { http: { port: 99999 } };`);
    await expect(loadConfig(dir)).rejects.toThrow(/"http\.port" must be an integer/);
  });

  it("unknown top-level keys throw instead of silently degrading to zero-config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { modle: "openai-codex/gpt-5.5" };`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "modle"/);
  });

  it("unknown http subkeys throw instead of silently falling back to the default port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { http: { porrt: 9999 } };`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "http\.porrt"/);
  });

  it("multiple config files throw instead of silently choosing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.js"), `export default { model: "openai-codex/gpt-5.5" };`);
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.4" };`);
    await expect(loadConfig(dir)).rejects.toThrow(/multiple fastagent config files/);
  });

  it("invalid custom tool entries throw during config load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { tools: [{}] };`);
    await expect(loadConfig(dir)).rejects.toThrow(/tools\[0\].*name.*execute/);
  });

  it("rejects a `channels` key (channels are files under channels/, not a config entry)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { channels: (agent) => ({}) };`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "channels"/);
  });
});

describe("config: resolveTools (append-after-defaults semantics)", () => {
  it("without config.tools returns pi defaults; with config.tools appends after defaults instead of replacing", () => {
    const defaults = resolveTools({}, process.cwd());
    expect(defaults.length).toBeGreaterThan(0);

    const extra = { name: "ping" } as (typeof defaults)[number];
    const merged = resolveTools({ tools: [extra] }, process.cwd());
    expect(merged.map((t) => t.name)).toEqual([...defaults.map((t) => t.name), "ping"]);
  });
});

describe("config: resolveModel", () => {
  it('parses "provider/modelId"', () => {
    const m = resolveModel(createPiModels(), "openai-codex/gpt-5.5");
    expect(m.provider).toBe("openai-codex");
    expect(m.id).toBe("gpt-5.5");
  });

  it("bad format / unknown model throws a clear error", () => {
    const models = createPiModels();
    expect(() => resolveModel(models, "no-slash")).toThrow(/provider\/modelId/);
    expect(() => resolveModel(models, "nope/nothing")).toThrow(/unknown model/);
  });
});

describe("L3: createPiAgentFromWorkspace (config-driven assembly boundary on the engine side)", () => {
  it("assembles config + definition and returns everything the entrypoint needs; flag beats config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-configured-"));
    await writeFile(join(dir, "AGENTS.md"), "# Test Agent\nBe concise.\n");
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", http: { port: 9999 } };`,
    );

    const ws = await createPiAgentFromWorkspace(dir);
    expect(ws.modelSpec).toBe("openai-codex/gpt-5.5"); // from config
    expect(ws.configPath).toMatch(/fastagent\.config\.mjs$/);
    expect(ws.config.http?.port).toBe(9999);
    expect(typeof ws.agent.invoke).toBe("function");
    expect(ws.definition.dir).toBe(dir);

    const overridden = await createPiAgentFromWorkspace(dir, { model: "openai-codex/gpt-5.4" });
    expect(overridden.modelSpec).toBe("openai-codex/gpt-5.4"); // flag wins
  });

  it("L3 creates workspace state: .fastagent/.gitignore exists for library callers as well as the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    await createPiAgentFromWorkspace(dir);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("sessionsDir overrides the default <dir>/.fastagent/sessions (start's deploy posture)", async () => {
    // dev defaults sessions under <dir>/.fastagent/sessions; start points them elsewhere (a mounted
    // volume) so a redeploy that replaces the dir does not wipe conversations. Lock that the override
    // wins and the default lands under .fastagent (the single opener both commands drive).
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const ext = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const overridden = await createPiAgentFromWorkspace(dir, { sessionsDir: ext });
    expect(overridden.sessionsDir).toBe(ext);
    const defaulted = await createPiAgentFromWorkspace(dir);
    expect(defaulted.sessionsDir).toBe(join(dir, ".fastagent", "sessions"));
  });

  it("authPath defaults to the project-level <dir>/.fastagent/auth.json; the override wins", async () => {
    // The feature: each project carries its own credential (own OAuth refresh lifecycle), not a shared
    // global file. Lock that the opener defaults project-level and an explicit path (e.g. the shared
    // global one) overrides — the same precedence shape as sessionsDir.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const defaulted = await createPiAgentFromWorkspace(dir);
    expect(defaulted.authPath).toBe(join(dir, ".fastagent", "auth.json"));
    const shared = join(tmpdir(), "shared-auth.json");
    const overridden = await createPiAgentFromWorkspace(dir, { authPath: shared });
    expect(overridden.authPath).toBe(shared);
  });

  it("self-ignores .fastagent when auth defaults in-tree even though sessionsDir is on a volume", async () => {
    // The leak this guards: `start --sessions-dir /vol` overrides sessions but leaves the credential
    // file at the default <dir>/.fastagent/auth.json. The self-ignore must still fire so an adapted
    // (no root .gitignore) agent dir never ships OAuth/API-key state.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const vol = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    await createPiAgentFromWorkspace(dir, { sessionsDir: vol });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("missing every model source throws a clear startup error (fail visibly)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const saved = process.env.FASTAGENT_MODEL;
    delete process.env.FASTAGENT_MODEL;
    try {
      await expect(createPiAgentFromWorkspace(dir)).rejects.toThrow(/missing model/);
    } finally {
      if (saved !== undefined) process.env.FASTAGENT_MODEL = saved;
    }
  });
});

describe("config: resolveModelSpec (precedence flag > env > config)", () => {
  it("flag beats env, env beats config", () => {
    const env = { FASTAGENT_MODEL: "e/m" } as NodeJS.ProcessEnv;
    expect(resolveModelSpec("f/m", { model: "c/m" }, env)).toBe("f/m");
    expect(resolveModelSpec(undefined, { model: "c/m" }, env)).toBe("e/m");
    expect(resolveModelSpec(undefined, { model: "c/m" }, {} as NodeJS.ProcessEnv)).toBe("c/m");
    expect(resolveModelSpec(undefined, {}, env)).toBe("e/m");
    expect(resolveModelSpec(undefined, {}, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
