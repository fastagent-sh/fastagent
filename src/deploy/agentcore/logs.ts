/** AgentCore log discovery, tailing, and reading back the one line the forwarder writes per fire. */
import type { CliRunner } from "../runner.ts";
import { forwarderLogGroup } from "./plan.ts";
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

/**
 * What the forwarder said about one routine fire, read back from its log.
 *
 * `delivered` carries the container's answer (its own reply body rides along); `failed` is the call that never
 * came back at all. They are kept apart because a reader that only knows the first one mistakes the second for
 * silence — which is the mistake `invokeLogged` exists to prevent (deploy/agentcore/forwarder.js), and which a
 * live probe then made anyway by matching only the status-code shape and timing out with "the forwarder logged N
 * lines, none of them a routine-fire".
 */
export type ForwarderFireLine =
  | { kind: "delivered"; occurrence: string; status: number; body: string }
  | { kind: "failed"; occurrence: string; message: string };

/**
 * Parse ONE CloudWatch message into what the forwarder meant by it, or `undefined` when the line is about
 * something else (an ordinary Lambda `START`/`REPORT`, a webhook, another routine).
 *
 * HERE RATHER THAN IN THE PROBE, because this is string work with no AWS in it: `test/live/**` is excluded from
 * `npm test`, so a defect in it is found by paying for a deployment. The one that was found that way was an
 * anchored pattern — `$` is end-of-input in JavaScript, unlike Perl and Python, and every CloudWatch message
 * carries a trailing newline, so it matched nothing real on every run. NOTHING HERE IS ANCHORED, at either end:
 * the message arrives with a timestamp and request id in front of it and a newline after it.
 *
 * NO REGEX FOR THE HEAD. A routine name is a filename, so `a+b.ts` is a legal one and would otherwise have to be
 * escaped into the pattern — a guard nobody can see working, since both call sites pass plain names. Looking for
 * a literal is what the reader means anyway, and it is why the name in the line cannot be read as a pattern.
 *
 * The FORMAT has one producer (`forwarder.js`), and `test/agentcore-forwarder.test.ts` feeds that producer's own
 * output through this function — so the two cannot drift apart without a red offline test.
 */
export function parseFireLine(message: string, routine: string): ForwarderFireLine | undefined {
  const marker = `routine-fire ${routine} (`;
  const at = message.indexOf(marker);
  if (at === -1) return undefined;
  const afterName = message.slice(at + marker.length);
  const close = afterName.indexOf("): ");
  // PAST THIS POINT THE LINE IS OURS, so nothing below may return `undefined`: the caller reads that as "this
  // line was about something else" and keeps waiting. A fire it cannot read is the one thing it must not wait
  // out — that misreading is the whole defect this function was extracted over, and the format growing a third
  // tail (a retry, a skip) is exactly how it would come back.
  if (close === -1) {
    throw new Error(`a routine-fire line for "${routine}" has no occurrence: ${message.trim().slice(0, 300)}`);
  }
  const occurrence = afterName.slice(0, close);
  // The newline CloudWatch appends cannot reach the body below, because `.` does not cross one. A `.trim()`
  // here would look like that guard while being unobservable — the offline test wraps its input the way
  // CloudWatch does, so a body pattern that DID cross the newline is what turns red.
  const tail = afterName.slice(close + "): ".length);
  const failed = /^invoke failed: (.*)/.exec(tail);
  if (failed) return { kind: "failed", occurrence, message: failed[1] as string };
  const delivered = /^(\d+) (.*)/.exec(tail);
  if (!delivered) {
    throw new Error(`unrecognized routine-fire line for "${routine}": ${message.trim().slice(0, 300)}`);
  }
  return { kind: "delivered", occurrence, status: Number(delivered[1]), body: delivered[2] as string };
}

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
    exact = forwarderLogGroup(plan.name);
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
    const trigger = plan.source === "runtime" ? "invoke the Runtime once" : "deliver one webhook or routine run";
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
