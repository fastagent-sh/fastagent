/** AgentCore log discovery + tailing. */
import type { CliRunner } from "../runner.ts";
import { parseStackOutputs } from "./run.ts";

export type AgentcoreLogSource = "runtime" | "forwarder";

export interface AgentcoreLogsPlan {
  /** Deployment base name — stack `fastagent-<name>`, forwarder `fastagent-<name>-forwarder`. */
  name: string;
  source: AgentcoreLogSource;
  /** AWS CLI relative/ISO-8601 window (`10m`, `2h`, ...). */
  since?: string;
  follow: boolean;
}

export type AgentcoreLogsOutcome = { ok: true; logGroup: string } | { ok: false; gate: string };

/** Runtime id from `arn:...:runtime/<id>` — the id prefixes AgentCore's per-endpoint log group. */
function runtimeIdFromArn(arn: string): string | undefined {
  const marker = ":runtime/";
  const at = arn.lastIndexOf(marker);
  const id = at === -1 ? "" : arn.slice(at + marker.length);
  return id && !id.includes("/") ? id : undefined;
}

function parseLogGroupNames(stdout: string): string[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function tailAgentcoreLogs(
  plan: AgentcoreLogsPlan,
  aws: CliRunner,
  announce: (message: string) => void = () => {},
): Promise<AgentcoreLogsOutcome> {
  const stack = `fastagent-${plan.name}`;
  const outputsResult = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
    { capture: true },
  );
  if (outputsResult.code === 127) {
    return { ok: false, gate: "aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/" };
  }
  if (outputsResult.code !== 0) {
    return {
      ok: false,
      gate: `could not read AgentCore stack ${stack} — deploy it first, or fix the AWS account/region shown above`,
    };
  }
  const outputs = parseStackOutputs(outputsResult.stdout);

  let prefix: string;
  let exact: string | undefined;
  if (plan.source === "runtime") {
    const runtimeArn = outputs.RuntimeArn;
    const runtimeId = runtimeArn && runtimeIdFromArn(runtimeArn);
    if (!runtimeId) {
      return {
        ok: false,
        gate: `stack ${stack} has no valid RuntimeArn output — regenerate/deploy the AgentCore stack`,
      };
    }
    prefix = `/aws/bedrock-agentcore/runtimes/${runtimeId}-`;
  } else {
    // `ForwarderUrl` is the stack's INGRESS URL, NOT proof that a forwarder Lambda exists.
    exact = `/aws/lambda/fastagent-${plan.name}-forwarder`;
    prefix = exact;
  }

  const groupsResult = await aws(
    [
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      prefix,
      "--query",
      "logGroups[].logGroupName",
      "--output",
      "json",
    ],
    { capture: true },
  );
  if (groupsResult.code !== 0) {
    return { ok: false, gate: "could not discover the CloudWatch log group — see the AWS error above" };
  }
  const groups = parseLogGroupNames(groupsResult.stdout);
  if (!groups) {
    return { ok: false, gate: "AWS returned an invalid CloudWatch log-group response" };
  }
  const matches = groups.filter((group) => (exact ? group === exact : group.startsWith(prefix))).sort();
  if (matches.length === 0) {
    // Absent group = never used, EXCEPT when the stack has no forwarder at all — an invoke-only deployment would
    // otherwise be told to deliver a webhook it can never receive.
    if (plan.source === "forwarder" && !outputs.ForwarderUrl) {
      return {
        ok: false,
        gate: `stack ${stack} has neither a forwarder log group nor an ingress URL — this looks like an invoke-only deployment, which has Runtime logs only`,
      };
    }
    const trigger = plan.source === "runtime" ? "invoke the Runtime once" : "deliver one webhook or schedule fire";
    return {
      ok: false,
      gate: `no ${plan.source} log group exists yet — ${trigger}, then retry (AWS creates it on first use)`,
    };
  }
  // A generated stack has one Runtime endpoint.
  if (matches.length > 1) {
    return {
      ok: false,
      gate:
        `several Runtime log groups match this stack: ${matches.join(", ")} — tail the intended one directly: ` +
        `aws logs tail <group> --format short --follow`,
    };
  }

  const logGroup = matches[0] as string;
  announce(`${plan.source} → ${logGroup}`);
  const tailArgs = ["logs", "tail", logGroup, "--format", "short"];
  if (plan.since) tailArgs.push("--since", plan.since);
  if (plan.follow) tailArgs.push("--follow");
  const tailed = await aws(tailArgs);
  if (tailed.code !== 0) {
    return { ok: false, gate: `aws logs tail failed for ${logGroup} — see the AWS error above` };
  }
  return { ok: true, logGroup };
}
