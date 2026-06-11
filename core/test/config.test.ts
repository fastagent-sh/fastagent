import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPiAgentFromWorkspace, loadConfig, resolveModel, resolveTools } from "../src/index.ts";
import { resolveModelSpec } from "../src/engines/pi/config.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("config: loadConfig", () => {
  it("装载 fastagent.config.ts 的 default export(含 tools 数组透传)", async () => {
    const { config, path } = await loadConfig(join(fixtures, "configured"));
    expect(path).toMatch(/fastagent\.config\.ts$/);
    expect(config.model).toBe("openai-codex/gpt-5.5");
    expect(config.http?.port).toBe(9999);
    expect(config.tools).toHaveLength(1);
    expect(config.tools![0]!.name).toBe("ping");
  });

  it("无配置文件 → zero-config({},path undefined)", async () => {
    const { config, path } = await loadConfig("/tmp");
    expect(config).toEqual({});
    expect(path).toBeUndefined();
  });

  it("形状不对 → 抛清晰错误(fail visibly)", async () => {
    await expect(loadConfig(join(fixtures, "bad-config"))).rejects.toThrow(/must default-export/);
  });

  it("http 形状也校验（http.port 非数字 → 抛）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { http: { port: "oops" } };`);
    await expect(loadConfig(dir)).rejects.toThrow(/"http\.port" must be a number/);
  });

  it("未知键 → 抛（typo 不得静默退化成 zero-config）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-config-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { modle: "openai-codex/gpt-5.5" };`);
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key "modle"/);
  });
});

describe("config: resolveTools(append-after-defaults 语义)", () => {
  it("无 config.tools → pi 默认工具;有 → 追加在默认之后不替换", () => {
    const defaults = resolveTools({}, process.cwd());
    expect(defaults.length).toBeGreaterThan(0);

    const extra = { name: "ping" } as (typeof defaults)[number];
    const merged = resolveTools({ tools: [extra] }, process.cwd());
    expect(merged.map((t) => t.name)).toEqual([...defaults.map((t) => t.name), "ping"]);
  });
});

describe("config: resolveModel", () => {
  it('解析 "provider/modelId"', () => {
    const m = resolveModel("openai-codex/gpt-5.5");
    expect(m.provider).toBe("openai-codex");
    expect(m.id).toBe("gpt-5.5");
  });

  it("坏格式 / 未知 model → 抛清晰错误", () => {
    expect(() => resolveModel("no-slash")).toThrow(/provider\/modelId/);
    expect(() => resolveModel("nope/nothing")).toThrow(/unknown model/);
  });
});

describe("L3: createPiAgentFromWorkspace(config 驱动装配收口引擎侧)", () => {
  it("装配 config + definition,返回入口点需要的全部信息;flag 赢 config", async () => {
    const dir = join(fixtures, "configured");
    const ws = await createPiAgentFromWorkspace(dir);
    expect(ws.modelSpec).toBe("openai-codex/gpt-5.5"); // 来自 config
    expect(ws.configPath).toMatch(/fastagent\.config\.ts$/);
    expect(ws.config.http?.port).toBe(9999);
    expect(typeof ws.agent.invoke).toBe("function");
    expect(ws.definition.dir).toContain("configured");

    const overridden = await createPiAgentFromWorkspace(dir, { model: "openai-codex/gpt-5.4" });
    expect(overridden.modelSpec).toBe("openai-codex/gpt-5.4"); // flag 赢
  });

  it("无任何 model 来源 → 启动时抛清晰错误(fail visibly)", async () => {
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

describe("config: resolveModelSpec(优先级 flag > config > env)", () => {
  it("flag 赢 config 赢 env", () => {
    const env = { FASTAGENT_MODEL: "e/m" } as NodeJS.ProcessEnv;
    expect(resolveModelSpec("f/m", { model: "c/m" }, env)).toBe("f/m");
    expect(resolveModelSpec(undefined, { model: "c/m" }, env)).toBe("c/m");
    expect(resolveModelSpec(undefined, {}, env)).toBe("e/m");
    expect(resolveModelSpec(undefined, {}, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
