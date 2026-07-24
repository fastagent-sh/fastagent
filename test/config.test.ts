import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createPiAgentFromWorkspace, createPiModels, listModels, probeAuthSource, resolveModel } from "../src/index.ts";
import {
  defaultAuthPath,
  defaultSessionsDir,
  loadConfig,
  resolveAuthPath,
  resolveAuthPathOverride,
  resolveModelSpec,
  resolveSecretsDir,
  resolveSessionsDirOverride,
  resolveStateRoot,
  resolveWorkspace,
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

describe("config: loadConfig rereads a config rewritten in-process (ESM cache-bust)", () => {
  it("a write-back (the first-run picker) is visible to the next loadConfig — not the cached module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-fresh-"));
    const path = join(dir, "fastagent.config.mjs");
    await writeFile(path, "export default {\n};\n");
    expect((await loadConfig(dir)).config.model).toBeUndefined();
    // Simulate persistModelChoice: rewrite the file AFTER it was imported once. Without the mtime
    // cache-buster the second load returns the stale cached module and deploy's model-travel gate
    // contradicts the "saved model" line it just printed.
    await writeFile(path, 'export default {\n  model: "prov/m1",\n};\n');
    // Push mtime past any fs timestamp granularity — the assertion targets the cache-bust, not the fs.
    const t = new Date((await stat(path)).mtimeMs + 2000);
    await utimes(path, t, t);
    expect((await loadConfig(dir)).config.model).toBe("prov/m1");
  });
});

describe("config: resolveWorkspace (structural layout resolution)", () => {
  it("flat: a config at the dir root → root = workbench = dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-flat-"));
    await writeFile(join(dir, "fastagent.config.mjs"), "export default {};\n");
    const ws = resolveWorkspace(dir);
    expect(ws.layout).toBe("flat");
    expect(ws.root).toBe(dir);
    expect(ws.workbench).toBe(dir);
  });

  it("embedded: a config in ./.fastagent/ → root = the nested dir, workbench = the host dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-embedded-"));
    await mkdir(join(dir, ".fastagent"));
    await writeFile(join(dir, ".fastagent", "fastagent.config.mjs"), "export default {};\n");
    const ws = resolveWorkspace(dir);
    expect(ws.layout).toBe("embedded");
    expect(ws.root).toBe(join(dir, ".fastagent"));
    expect(ws.workbench).toBe(dir);
    // Invoked from INSIDE the embedded root: the SAME workspace resolves (workbench = the parent).
    const inner = resolveWorkspace(join(dir, ".fastagent"));
    expect(inner).toEqual(ws);
  });

  it("zero-config: no config anywhere → flat (a directory is an agent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-zero-"));
    const ws = resolveWorkspace(dir);
    expect(ws).toEqual({ root: dir, workbench: dir, layout: "flat" });
  });

  it("a config at BOTH roots is ambiguous → throws IDENTICALLY from both entry points", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-both-"));
    await writeFile(join(dir, "fastagent.config.mjs"), "export default {};\n");
    await mkdir(join(dir, ".fastagent"));
    await writeFile(join(dir, ".fastagent", "fastagent.config.mjs"), "export default {};\n");
    expect(() => resolveWorkspace(dir)).toThrow(/ambiguous/);
    // Entry-point-invariant: invoked from INSIDE .fastagent/, the same conflict must refuse the same
    // way — never silently resolve embedded just because of where the command ran.
    expect(() => resolveWorkspace(join(dir, ".fastagent"))).toThrow(/ambiguous/);
  });

  it("a config-less .fastagent/ that READS as a workspace fails loudly (never a silent flat downgrade)", async () => {
    // An embedded workspace whose config was deleted: resolving the host dir as "flat zero-config"
    // would silently lose persona/skills — refuse with the way out (restore config, or init fresh).
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-configless-"));
    await mkdir(join(dir, ".fastagent"));
    await writeFile(join(dir, ".fastagent", "persona.md"), "You are terse.\n");
    expect(() => resolveWorkspace(dir)).toThrow(/fastagent\.config.*fastagent init/s);
    // Same refusal from inside the directory.
    expect(() => resolveWorkspace(join(dir, ".fastagent"))).toThrow(/fastagent\.config.*fastagent init/s);
  });

  it("a .fastagent/ that does NOT read as a workspace stays zero-config flat (a directory is an agent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-unrelated-"));
    await mkdir(join(dir, ".fastagent"));
    await writeFile(join(dir, ".fastagent", "notes.txt"), "unrelated\n");
    expect(resolveWorkspace(dir)).toEqual({ root: dir, workbench: dir, layout: "flat" });
  });
});

describe("config: loadConfig validation", () => {
  it("rejects the retired agentDir key (layout is structural now, never configured)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentdir-retired-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { agentDir: "./agent" };\n`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "agentDir"/);
  });

  it("selfSchedule: accepts a boolean (opt-in to the wake tool), rejects a non-boolean", async () => {
    const ok = await mkdtemp(join(tmpdir(), "fa-selfsched-ok-"));
    await writeFile(join(ok, "fastagent.config.mjs"), `export default { selfSchedule: true };\n`);
    expect((await loadConfig(ok)).config.selfSchedule).toBe(true);

    const bad = await mkdtemp(join(tmpdir(), "fa-selfsched-bad-"));
    await writeFile(join(bad, "fastagent.config.mjs"), `export default { selfSchedule: "yes" };\n`);
    await expect(loadConfig(bad)).rejects.toThrow(/selfSchedule.*must be a boolean/);
  });
});

describe("config: resolveStateRoot / resolveSecretsDir (the machinery dirs)", () => {
  it("env overrides; default is the absolute in-tree .state; ~ expands", async () => {
    const env = { FASTAGENT_STATE_DIR: "/data" } as NodeJS.ProcessEnv;
    expect(resolveStateRoot("/app", env)).toBe("/data"); // env wins
    expect(resolveStateRoot("relative/dir", {} as NodeJS.ProcessEnv)).toBe(resolve("relative/dir", ".state")); // absolute default
    const { homedir } = await import("node:os");
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "~/state" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), "state"),
    );
    // A RELATIVE override is an operator knob — anchored on cwd (its sibling knobs' convention), NOT on
    // `dir`; only the default is dir-anchored. So it ignores `dir` and resolves against process.cwd().
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "state" } as NodeJS.ProcessEnv)).toBe(resolve("state"));
  });

  it("secrets: FASTAGENT_SECRETS_DIR wins; default is the in-tree .secrets; auth derives from it", () => {
    expect(resolveSecretsDir("/app", {} as NodeJS.ProcessEnv)).toBe("/app/.secrets");
    expect(resolveSecretsDir("/app", { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      "/data/.secrets",
    );
    expect(defaultAuthPath("/data/.secrets")).toBe("/data/.secrets/auth.json");
  });

  it("workspace root == $HOME → machinery nests under ~/.fastagent (never bare ~/.state / ~/.secrets)", async () => {
    const { homedir } = await import("node:os");
    expect(resolveStateRoot(homedir(), {} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".fastagent", ".state"));
    expect(resolveSecretsDir(homedir(), {} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".fastagent", ".secrets"));
  });

  it("sessions default derives from the resolved state root (one volume covers everything)", () => {
    const root = resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "/data/.state" } as NodeJS.ProcessEnv);
    expect(defaultSessionsDir(root)).toBe("/data/.state/sessions");
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

  it("resolveAuthPath falls back to the workspace project auth file (not the global default)", () => {
    expect(resolveAuthPath("/app", undefined, {} as NodeJS.ProcessEnv)).toBe("/app/.secrets/auth.json");
    expect(resolveAuthPath("/app", undefined, { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      "/data/.secrets/auth.json",
    );
    expect(resolveAuthPath("/app", "flag-auth.json", {} as NodeJS.ProcessEnv)).toBe(resolve("flag-auth.json"));
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

  it("thinkingLevel: a valid pi level loads; an invalid value throws (fail visibly, not a silent default)", async () => {
    const load = async (body: string) => {
      const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
      await writeFile(join(dir, "fastagent.config.mjs"), body);
      return loadConfig(dir);
    };
    const { config } = await load(`export default { thinkingLevel: "high" };`);
    expect(config.thinkingLevel).toBe("high");
    await expect(load(`export default { thinkingLevel: "hgih" };`)).rejects.toThrow(
      /"thinkingLevel" must be one of off, minimal, low, medium, high, xhigh, max/,
    );
    await expect(load(`export default { thinkingLevel: 3 };`)).rejects.toThrow(/"thinkingLevel" must be one of/);
  });

  it("unknown top-level keys throw instead of silently degrading to zero-config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { modle: "openai-codex/gpt-5.5" };`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "modle"/);
  });

  it("validates deploy.secrets / deploy.apt shape (env-name / package-name), rejects unknown deploy keys", async () => {
    // A fresh dir per case: ESM caches a module by URL, so re-writing one file wouldn't re-import.
    const load = async (body: string) => {
      const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
      await writeFile(join(dir, "fastagent.config.mjs"), body);
      return loadConfig(dir);
    };
    const { config } = await load(`export default { deploy: { secrets: ["GH_TOKEN"], apt: ["git", "ripgrep"] } };`);
    expect(config.deploy).toEqual({ secrets: ["GH_TOKEN"], apt: ["git", "ripgrep"] }); // valid
    await expect(load(`export default { deploy: { secrets: ["gh token"] } };`)).rejects.toThrow(
      /"deploy\.secrets\[0\]" must be an UPPER_SNAKE/,
    ); // not UPPER_SNAKE
    await expect(load(`export default { deploy: { apt: ["git; rm -rf /"] } };`)).rejects.toThrow(
      /"deploy\.apt\[0\]" must be a Debian package name/,
    ); // shell-injection shaped
    await expect(load(`export default { deploy: { image: "python" } };`)).rejects.toThrow(
      /unknown key "deploy\.image"/,
    ); // unknown deploy key
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

  it("L3 creates workspace state: .state/.secrets self-ignore for library callers as well as the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    await createPiAgentFromWorkspace(dir);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, ".state", ".gitignore"), "utf8")).toBe("*\n");
    // .secrets carries the traveling variant: template + protection stay committable.
    const secrets = await readFile(join(dir, ".secrets", ".gitignore"), "utf8");
    expect(secrets).toMatch(/^\*$/m);
    expect(secrets).toMatch(/^!\.env\.example$/m);
  });

  it("sessionsDir overrides the default <root>/.state/sessions (start's deploy posture)", async () => {
    // dev defaults sessions under <root>/.state/sessions; start points them elsewhere (a mounted
    // volume) so a redeploy that replaces the dir does not wipe conversations. Lock that the override
    // wins and the default lands under .state (the single opener both commands drive).
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const ext = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const overridden = await createPiAgentFromWorkspace(dir, { sessionsDir: ext });
    expect(overridden.sessionsDir).toBe(ext);
    const defaulted = await createPiAgentFromWorkspace(dir);
    expect(defaulted.sessionsDir).toBe(join(dir, ".state", "sessions"));
  });

  it("authPath defaults to the project-level <root>/.secrets/auth.json; the override wins", async () => {
    // The feature: each project carries its own credential (own OAuth refresh lifecycle), not a shared
    // global file. Lock that the opener defaults project-level and an explicit path (e.g. the shared
    // global one) overrides — the same precedence shape as sessionsDir.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const defaulted = await createPiAgentFromWorkspace(dir);
    expect(defaulted.authPath).toBe(join(dir, ".secrets", "auth.json"));
    const shared = join(tmpdir(), "shared-auth.json");
    const overridden = await createPiAgentFromWorkspace(dir, { authPath: shared });
    expect(overridden.authPath).toBe(shared);
  });

  it("self-ignores .secrets when auth defaults in-tree even though sessionsDir is on a volume", async () => {
    // The leak this guards: `start --sessions-dir /vol` overrides sessions but leaves the credential
    // file at the default <root>/.secrets/auth.json. The self-ignore must still fire so an adapted
    // (no root .gitignore) agent dir never ships OAuth/API-key state.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const vol = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    await createPiAgentFromWorkspace(dir, { sessionsDir: vol });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);
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

describe("rewriteConfigModel (first-run picker write-back)", async () => {
  const { rewriteConfigModel } = await import("../src/engines/pi/config.ts");

  it("uncomments the scaffold's commented model placeholder", () => {
    const src = 'export default {\n  // model: "openai-codex/gpt-5.5",\n  http: { port: 8787 },\n};\n';
    expect(rewriteConfigModel(src, "anthropic/claude-x")).toBe(
      'export default {\n  model: "anthropic/claude-x",\n  http: { port: 8787 },\n};\n',
    );
  });

  it("replaces an existing active model line", () => {
    const src = 'export default {\n  model: "old/one",\n};\n';
    expect(rewriteConfigModel(src, "new/two")).toBe('export default {\n  model: "new/two",\n};\n');
  });

  it("re-inserts the model line into a scaffold-shaped config whose line was hand-deleted", () => {
    // Deleting the model line is the natural "reset" gesture — the next pick must persist again.
    const src = "export default {\n  http: { port: 8787 },\n};\n";
    expect(rewriteConfigModel(src, "x/y")).toBe('export default {\n  model: "x/y",\n  http: { port: 8787 },\n};\n');
  });

  it("returns null for a hand-shaped config (no model line, no scaffold block shape)", () => {
    expect(rewriteConfigModel("export default { http: { port: 8787 } };\n", "x/y")).toBeNull(); // one-liner
    expect(rewriteConfigModel("export default defineConfig({\n});\n", "x/y")).toBeNull(); // wrapper call
  });
});
