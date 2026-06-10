#!/usr/bin/env node
/**
 * fastagent CLI — the consumer of fastagent.config.ts (product entry point,
 * replacing hand-written entry scripts).
 *
 * v1 has only `dev`: run an agent locally (default global skills, pi OAuth, HTTP channel).
 *   fastagent dev [dir] [--port N] [--model provider/modelId]
 * Next: `build` (bundleAgentDefinition wrapper), `start` (production posture, artifact-only).
 *
 * Process-level side effects (proxy dispatcher, .env loading) belong here — the CLI
 * is the application entry point.
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

  dev   assemble the agent definition in dir (default .) and start a local HTTP channel
        model precedence: --model > fastagent.config.ts > FASTAGENT_MODEL`);
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
// Node's fetch does not honor HTTPS_PROXY by itself; route through the local proxy
// so blocked providers are reachable.
setGlobalDispatcher(new EnvHttpProxyAgent());

const { config, path: configPath } = await loadConfig(dir);
const modelSpec = pickModelSpec(values.model, config);
if (!modelSpec) {
  console.error(
    `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
  );
  process.exit(1);
}

const { agent, definition } = await createPiAgentFromDefinition(dir, {
  model: resolveModel(modelSpec),
  // config.tools are appended after pi default tools; without config.tools the
  // FromDefinition default applies.
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
