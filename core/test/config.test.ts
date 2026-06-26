import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createPiAgentFromWorkspace, createPiModels, listModels, resolveModel } from "../src/index.ts";
import { loadConfig, resolveModelSpec, resolveSessionsDirOverride } from "../src/engines/pi/config.ts";
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
