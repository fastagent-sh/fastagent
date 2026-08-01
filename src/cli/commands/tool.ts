/** `fastagent tool <name> '<json>' [dir]`: run one tool's body directly with JSON args — no model. */
import { resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadDotEnv } from "../../env.ts";
import { loadConfig } from "../../engines/pi/config.ts";

import { resolveAgentTools } from "../../engines/pi/create.ts";
import { reportModuleLoadFailures } from "../../engines/pi/report.ts";
import { turnContext } from "../../engines/pi/tool-context.ts";
import { failStartup, failUsage, placementOrExit } from "../fail.ts";

export async function runTool(name: string, argsJson: string, dirArg: string): Promise<void> {
  // Argument shape first: malformed JSON is a USAGE error (exit 2), independent of whether the
  // directory is an agent (a runtime failure, exit 1).
  const args = parseToolArgs(argsJson);
  const { agentDir, workspace } = placementOrExit(resolve(dirArg));
  loadDotEnv(agentDir); // a tool may read a key from .env
  const { config } = await loadConfig(agentDir).catch(failStartup);
  // The same tool set dev/start mount (defaults + config.tools + discovered, deduped), so the runner
  // exercises exactly what gets served — a shadowed tool is surfaced, not silently run. Resolve the
  // placement like the openers, so `fastagent tool` finds the SAME tools/ as dev/start.
  const { tools, toolCollisions, toolFailures } = await resolveAgentTools(config, agentDir).catch(failStartup);
  for (const c of toolCollisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) is shadowed by a default/config tool — not mounted`,
    );
  }
  reportModuleLoadFailures(toolFailures);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    failStartup(new Error(`unknown tool "${name}". available: ${tools.map((t) => t.name).join(", ") || "(none)"}`));
  }
  // Two contexts, because the two tool families read different ones and this command must serve both
  // exactly as serving does: fastagent's own tools take cwd/session/activation from `turnContext`
  // (AsyncLocalStorage), and pi's default coding tools take the ExecutionEnv from the harness's TOOL
  // context — which no harness supplies here, so this stands in for it, rooted at the same workspace.
  const env = new NodeExecutionEnv({ cwd: workspace });
  const result = await turnContext
    .run({ cwd: workspace }, () => tool.execute(`cli-${name}`, args, undefined, undefined, { env }))
    .catch(failStartup);
  const out =
    result?.details !== undefined
      ? result.details
      : (result?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}

/** Parse the CLI's JSON args blob; malformed input syntax is a usage error (exit 2). */
function parseToolArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    failUsage(`invalid JSON args: ${argsJson}`);
  }
}
