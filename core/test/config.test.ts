import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPiAgentFromWorkspace, resolveModel } from "../src/index.ts";
import { loadConfig, resolveModelSpec } from "../src/engines/pi/config.ts";
import { resolveTools } from "../src/engines/pi/create.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
    const m = resolveModel("openai-codex/gpt-5.5");
    expect(m.provider).toBe("openai-codex");
    expect(m.id).toBe("gpt-5.5");
  });

  it("bad format / unknown model throws a clear error", () => {
    expect(() => resolveModel("no-slash")).toThrow(/provider\/modelId/);
    expect(() => resolveModel("nope/nothing")).toThrow(/unknown model/);
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
