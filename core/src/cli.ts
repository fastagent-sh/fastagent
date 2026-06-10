#!/usr/bin/env node
/**
 * fastagent CLI —— config 的消费者(产品入口,取代手写 entry 脚本)。
 *
 * v1 只有 `dev`:本地起 agent(默认全局 skills、pi OAuth、HTTP channel)。
 *   fastagent dev [dir] [--port N] [--model provider/modelId]
 * 后续:`build`(bundleAgentDefinition 套壳)、`start`(只认产物的生产姿态)。
 *
 * 进程级副作用(代理 dispatcher、.env 装载)归这里——CLI 就是应用入口。
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { createInvokeHandler } from "./channels/http.ts";
import { loadConfig, pickModelSpec, resolveModel } from "./engines/pi/config.ts";
import { createPiAgentFromDefinition } from "./engines/pi/driver.ts";
import { piDefaultTools } from "./engines/pi/tools.ts";

function usage(code: number): never {
  console.error(`usage: fastagent dev [dir] [--port N] [--model provider/modelId]

  dev   在 dir(缺省 .)装配 agent 定义并起本地 HTTP channel
        model 优先级: --model > fastagent.config.ts > FASTAGENT_MODEL`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) usage(0);
const [command, dirArg] = positionals;
if (command !== "dev") usage(1);

const dir = resolve(dirArg ?? ".");

// .env (secrets) → process.env. Only a missing file is normal; surface anything else.
try {
  process.loadEnvFile(join(dir, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
// 本地走代理才能到被墙 provider(Node fetch 不读 HTTPS_PROXY)。
setGlobalDispatcher(new EnvHttpProxyAgent());

const { config, path: configPath } = await loadConfig(dir);
const modelSpec = pickModelSpec(values.model, config);
if (!modelSpec) {
  console.error(`缺 model:用 --model、fastagent.config.ts 的 model、或 FASTAGENT_MODEL 环境变量指定(如 "openai-codex/gpt-5.5")`);
  process.exit(1);
}

const { agent, definition } = await createPiAgentFromDefinition(dir, {
  model: resolveModel(modelSpec),
  // config.tools 追加在 pi 默认工具之后;无 config.tools 则走 FromDefinition 默认。
  ...(config.tools ? { tools: [...piDefaultTools(dir), ...config.tools] } : {}),
});

console.error(`[fastagent] dir:    ${definition.dir}`);
console.error(`[fastagent] config: ${configPath ?? "(zero-config)"}`);
console.error(`[fastagent] model:  ${modelSpec}`);
console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
console.error(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
for (const c of definition.collisions) {
  console.error(`[fastagent] warn: skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
}
for (const d of definition.diagnostics) {
  console.error(`[fastagent] warn: ${d.code}: ${d.message} (${d.path})`);
}

const port = Number(values.port ?? config.http?.port ?? 8787);
createServer(createInvokeHandler(agent)).listen(port, () => {
  console.error(`[fastagent] http channel on :${port}`);
  console.error(`  curl -N -X POST localhost:${port}/invoke -d '{"session":"s1","text":"hi"}'`);
});
