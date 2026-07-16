/** `fastagent tool <name> '<json>' [dir]`: run one tool's body directly with JSON args — no model. */
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { loadConfig, resolveAgentDir } from "../../engines/pi/config.ts";
import { resolveWorkspaceTools } from "../../engines/pi/create.ts";
import { reportModuleLoadFailures } from "../../engines/pi/report.ts";
import { failStartup, failUsage } from "../fail.ts";

export async function runTool(name: string, argsJson: string, dirArg: string): Promise<void> {
  const toolDir = resolve(dirArg);
  loadDotEnv(toolDir); // a tool may read a key from .env
  const { config } = await loadConfig(toolDir).catch(failStartup);
  // The same tool set dev/start mount (defaults + config.tools + discovered, deduped), so the runner
  // exercises exactly what gets served — a shadowed tool is surfaced, not silently run. Resolve agentDir
  // like the openers so `fastagent tool` finds the SAME tools/ as dev/start when config.agentDir is set.
  const agentDir = resolveAgentDir(toolDir, config);
  const { tools, toolCollisions, toolFailures } = await resolveWorkspaceTools(config, agentDir, toolDir).catch(
    failStartup,
  );
  for (const c of toolCollisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) is shadowed by a default/config tool — not mounted`,
    );
  }
  reportModuleLoadFailures(toolFailures);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    console.error(`unknown tool "${name}". available: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
    process.exit(1);
  }
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    failUsage(`invalid JSON args: ${argsJson}`); // malformed input syntax = usage error, exit 2
  }
  const result = await tool.execute(`cli-${name}`, args).catch(failStartup);
  const out =
    result?.details !== undefined
      ? result.details
      : (result?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}
