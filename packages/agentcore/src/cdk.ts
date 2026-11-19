/**
 * The AWS resources an agent on AgentCore needs beside its runtime, as a CDK construct the AgentCore CLI's stack (or any
 * CDK app) adds: the Aurora DSQL cluster its instances are in, the EventBridge Scheduler group and roles its alarms run
 * on, read access to the Secrets Manager secret its values are in, and the variables `fastagent agentcore start` finds
 * them by. The secret is its owner's, created in the console or the CLI and referenced by name, as AWS advises: no value
 * passes through a template.
 *
 * Every synthesis, so every deploy, local or in CI, first asks the agent's own FastAgent whether the image would carry
 * this machine's secrets or state (and whether the definition has schedules), and stops when it would: in a process of
 * its own, since a construct is synchronous and the agent's FastAgent is its own installation, not this CDK app's.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { SESSION_ID_PATTERN } from "@fastagent-sh/client/agentcore/contract";
import type { ScheduleFact } from "@fastagent-sh/fastagent/platform";
import { Names, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnCluster } from "aws-cdk-lib/aws-dsql";
import { type IGrantable, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule, CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { universalTargetArn } from "./alarms.ts";
import {
  ALARM_GROUP_ENV,
  ALARM_INSTANCES_ENV,
  DEPLOY_SCHEDULE_NAME,
  DEPLOY_SESSION_ID,
  DSQL_ENDPOINT_ENV,
  SECRETS_ENV,
} from "./variables.ts";

/** The runtime the agent runs as: the AgentCore CLI's `application.runtime(name)`, or any CDK runtime construct. */
export type AgentRuntime = IGrantable & {
  addEnvironmentVariable(name: string, value: string): unknown;
} & ({ readonly runtimeArn: string } | { readonly agentRuntimeArn: string });

export interface FastAgentResourcesProps {
  runtime: AgentRuntime;
  /** The agent directory: the image's build context. */
  agentDir: string;
  /** The Secrets Manager secret holding the agent's values, as one JSON object of names to values. None: no values. */
  secretName?: string;
  /**
   * Session ids whose schedules (`src/schedules/`) are armed on deploy without waiting for a Caller to invoke them
   * first (33 to 256 letters, digits, `-` and `_`, starting with a letter or digit): for a single-instance or
   * schedule-only agent. Multi-user apps leave this empty so only real users' sessions run schedules.
   */
  instances?: readonly string[];
}

export class FastAgentResources extends Construct {
  /** The Aurora DSQL cluster: kept when the stack is deleted, with deletion protection, since it holds every session. */
  readonly cluster: CfnCluster;
  /** The EventBridge Scheduler group holding each session's alarm and `.deploy`. */
  readonly alarms: CfnScheduleGroup;
  /** The role EventBridge Scheduler assumes to invoke the runtime when an alarm fires. */
  readonly alarmRole: Role;

  constructor(scope: Construct, id: string, props: FastAgentResourcesProps) {
    super(scope, id);
    const instances = validateInstances(props.instances);
    const inspected = inspectAgent(props.agentDir);
    const { runtime } = props;
    const runtimeArn = "runtimeArn" in runtime ? runtime.runtimeArn : runtime.agentRuntimeArn;
    const stack = Stack.of(this);

    this.cluster = new CfnCluster(this, "Instances", { deletionProtectionEnabled: true });
    this.cluster.applyRemovalPolicy(RemovalPolicy.RETAIN);
    runtime.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({ actions: ["dsql:DbConnectAdmin"], resources: [this.cluster.attrResourceArn] }),
    );
    runtime.addEnvironmentVariable(DSQL_ENDPOINT_ENV, this.cluster.attrEndpoint);

    const groupName = Names.uniqueResourceName(this, {
      maxLength: 64,
      separator: "-",
      allowedSpecialCharacters: "-_",
    });
    this.alarms = new CfnScheduleGroup(this, "Alarms", { name: groupName });
    const groupArn = `arn:${stack.partition}:scheduler:${stack.region}:${stack.account}:schedule-group/${groupName}`;
    const schedulesArn = `arn:${stack.partition}:scheduler:${stack.region}:${stack.account}:schedule/${groupName}/*`;

    this.alarmRole = new Role(this, "AlarmRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": stack.account,
            "aws:SourceArn": groupArn,
          },
        },
      }),
    });
    this.alarmRole.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [runtimeArn, `${runtimeArn}/*`],
      }),
    );

    const rearmActive = inspected.schedules.length > 0 || instances.length > 0;
    const rearmDigest = createHash("sha256")
      .update(JSON.stringify({ schedules: inspected.schedules, instances }))
      .digest("hex")
      .slice(0, 16);
    const deploySchedule = new CfnSchedule(this, "DeployAlarm", {
      groupName,
      name: DEPLOY_SCHEDULE_NAME,
      scheduleExpression: "rate(1 minute)",
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      state: rearmActive ? "ENABLED" : "DISABLED",
      description: rearmActive ? `fastagent rearm ${rearmDigest}` : "fastagent alarm target",
      target: {
        arn: universalTargetArn(stack.partition),
        roleArn: this.alarmRole.roleArn,
        input: JSON.stringify({
          AgentRuntimeArn: runtimeArn,
          RuntimeSessionId: DEPLOY_SESSION_ID,
          ContentType: "application/json",
          Payload: JSON.stringify({ rearm: true }),
        }),
      },
    });
    deploySchedule.addDependency(this.alarms);
    deploySchedule.node.addDependency(this.alarmRole);
    if (runtime instanceof Construct) deploySchedule.node.addDependency(runtime);

    runtime.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "scheduler:GetSchedule",
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
        ],
        resources: [schedulesArn],
      }),
    );
    runtime.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [this.alarmRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }),
    );
    runtime.addEnvironmentVariable(ALARM_GROUP_ENV, groupName);
    if (instances.length > 0) {
      runtime.addEnvironmentVariable(ALARM_INSTANCES_ENV, instances.join(","));
    }

    if (props.secretName !== undefined) {
      Secret.fromSecretNameV2(this, "Values", props.secretName).grantRead(runtime);
      runtime.addEnvironmentVariable(SECRETS_ENV, props.secretName);
    }
  }
}

function validateInstances(instances: readonly string[] | undefined): string[] {
  if (instances === undefined) return [];
  const unique = [...new Set(instances)];
  for (const id of unique) {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(
        `FastAgentResources instances: "${id}" is not an AgentCore session id (33 to 256 letters, digits, "-" and "_", starting with a letter or digit)`,
      );
    }
  }
  return unique;
}

/** Run where the agent is, so `@fastagent-sh/fastagent` is the agent's own; the directory is its first argument. */
const INSPECT_AGENT = `
let platform;
try {
  platform = await import("@fastagent-sh/fastagent/platform");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.error("the agent in " + process.argv[1] + " has no @fastagent-sh/fastagent installed: run npm ci there first");
  process.exit(1);
}
const leaks = await platform.buildContextLeaks(process.argv[1]);
if (leaks.length > 0) {
  for (const leak of leaks) console.error(leak);
  process.exit(1);
}
const facts = await platform.agentFacts(process.argv[1]);
process.stdout.write(JSON.stringify({ schedules: facts.schedules }));
`;

/** Stop the synthesis when the agent's FastAgent finds the image would carry what it must not, and read its shape. */
function inspectAgent(agentDir: string): { schedules: ScheduleFact[] } {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", INSPECT_AGENT, agentDir], {
      cwd: agentDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return JSON.parse(stdout) as { schedules: ScheduleFact[] };
  } catch (error) {
    const said = String((error as { stderr?: Buffer | string }).stderr ?? "").trim();
    throw new Error(said || `checking what the image would carry failed: ${(error as Error).message}`);
  }
}
