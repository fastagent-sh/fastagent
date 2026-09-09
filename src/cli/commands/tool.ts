/** `fastagent tool <name> '<json>' [dir]`: run one tool's body directly with JSON args — no model. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { loadConfig } from "../../engines/pi/config.ts";

import { resolveAgentTools } from "../../engines/pi/create.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { turnContext } from "../../engines/pi/tool-context.ts";
import { failStartup, failUsage, gateSecretsOrExit, placementOrExit } from "../fail.ts";

export async function runTool(name: string, argsJson: string, dirArg: string): Promise<void> {
  // Argument shape first: malformed JSON is a USAGE error (exit 2), independent of whether the directory is an agent
  // (a runtime failure, exit 1).
  const args = parseToolArgs(argsJson);
  const { agentDir, workspace } = placementOrExit(resolve(dirArg));
  enterAgentEnv(agentDir); // a tool may read a key from .env — and fetch through the proxy it declares
  const { config } = await loadConfig(agentDir).catch(failStartup);
  // The same tool set dev/start mount (all coding tools + config.tools + discovered, deduped), so the runner
  // exercises exactly what gets served.
  const { tools, toolCollisions, toolFailures, toolSecrets } = await resolveAgentTools(
    config,
    agentDir,
    workspace,
  ).catch(failStartup);
  for (const c of toolCollisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) is shadowed by a default/config tool — not mounted`,
    );
  }
  // Reported BEFORE the name is looked up: a file that failed to import is missing from `tools`, so
  // "unknown tool" is exactly the case where the author most needs to hear that something blew up
  // rather than that they mistyped it.
  reportModuleLoadFailures(toolFailures);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    failStartup(new Error(`unknown tool "${name}". available: ${tools.map((t) => t.name).join(", ") || "(none)"}`));
  }
  // This command RUNS one tool body, so it takes the same guarantee dev/start take — for THAT tool
  // only (`owner`): running one tool by hand must not require the credentials of the tools it is not
  // running, and `fire` scopes the same way for one schedule.
  // The failures go to the gate as well, even though they were just printed: the gate's guarantee is
  // that a refusal never hides them, and it cannot know a caller already reported. A repeated line on
  // the refusal path is the cheaper failure than one that depends on this call site remembering.
  gateSecretsOrExit({ declared: toolSecrets, failures: toolFailures, owner: name });
  // Authored tools read cwd from turnContext; coding tools are already rooted at the workspace.
  const result = await turnContext.run({ cwd: workspace }, () => tool.execute(`cli-${name}`, args)).catch(failStartup);
  // What the MODEL receives, which is not what is printed below: the printed form is `details` (readable, indented),
  // the model's is the content text (compact JSON). Piping stdout through `wc -c` therefore answers the wrong
  // question, and there is nowhere else to ask this one — so the run that a tool author already does reports it.
  const modelText = (result?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  const out = result?.details !== undefined ? result.details : modelText;
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2)); // stdout stays DATA
  // No threshold warning: context windows run from 128k to 1M, so any fixed ceiling here would be invented. The
  // number is the signal; docs/api-reference.md carries the judgement. ~4 chars/token is the usual rough figure.
  console.error(
    `[fastagent] result: ${modelText.length} chars ≈ ${Math.ceil(modelText.length / 4)} tokens to the model`,
  );
}

/** Parse the CLI's JSON args blob; malformed input syntax is a usage error (exit 2). */
function parseToolArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    failUsage(`invalid JSON args: ${argsJson}`);
  }
}
