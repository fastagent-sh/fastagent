/** `fastagent logs agentcore [agent]`: discover and tail the deployed AgentCore CloudWatch logs. */
import { resolve } from "node:path";
import { agentcoreName } from "../../deploy/agentcore/plan.ts";
import { type AgentcoreLogSource, tailAgentcoreLogs } from "../../deploy/agentcore/logs.ts";
import { awsRunner } from "../../deploy/runner.ts";
import { enterAgentEnv } from "../../env.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { deploymentName } from "../../deploy/deployment-name.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";

export interface AgentcoreLogsOptions {
  /** `--config <file>`: the instance's configuration, which names it. */
  config?: string;
  source?: string;
  since?: string;
  follow?: boolean;
}

export async function runLogs(host: string, dirArg: string, opts: AgentcoreLogsOptions): Promise<void> {
  // The host argument is DISPATCHED here, as in runDeploy.
  if (host !== "agentcore") failUsage(`logs: unsupported host "${host}" — only agentcore has remote logs`);
  const agentDir = agentDirOrExit(resolve(dirArg));
  selectAgentEnvironment("production");
  enterAgentEnv(agentDir);
  const source = opts.source ?? "runtime";
  if (source !== "runtime" && source !== "forwarder") {
    failUsage(`logs: --source must be "runtime" or "forwarder"`);
  }
  const outcome = await tailAgentcoreLogs(
    {
      name: agentcoreName(await deploymentName(agentDir, opts.config).catch(failStartup)),
      source: source as AgentcoreLogSource,
      since: opts.since,
      follow: opts.follow === true,
    },
    awsRunner(agentDir),
    (message) => console.error(`[fastagent] logs: ${message}`),
  );
  if (!outcome.ok) failStartup(new Error(`logs stopped: ${outcome.gate}`));
}
