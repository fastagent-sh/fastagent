/**
 * The AWS resources an agent on AgentCore needs beside its runtime, as a CDK construct the AgentCore CLI's stack (or any
 * CDK app) adds: the Aurora DSQL cluster its instances are in, read access to the Secrets Manager secret its values are
 * in, and the variables `fastagent agentcore start` finds both by. The secret is its owner's, created in the console or
 * the CLI and referenced by name, as AWS advises: no value passes through a template.
 *
 * Every synthesis, so every deploy, local or in CI, first asks the agent's own FastAgent whether the image would carry
 * this machine's secrets or state, and stops when it would: in a process of its own, since a construct is synchronous
 * and the agent's FastAgent is its own installation, not this CDK app's.
 */
import { execFileSync } from "node:child_process";
import { RemovalPolicy } from "aws-cdk-lib";
import { CfnCluster } from "aws-cdk-lib/aws-dsql";
import { type IGrantable, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { DSQL_ENDPOINT_ENV, SECRETS_ENV } from "./variables.ts";

/** The runtime the agent runs as: the AgentCore CLI's `application.runtime(name)`, or any that takes both. */
export interface AgentRuntime extends IGrantable {
  addEnvironmentVariable(name: string, value: string): unknown;
}

export interface FastAgentResourcesProps {
  runtime: AgentRuntime;
  /** The agent directory: the image's build context. */
  agentDir: string;
  /** The Secrets Manager secret holding the agent's values, as one JSON object of names to values. None: no values. */
  secretName?: string;
}

export class FastAgentResources extends Construct {
  /** The Aurora DSQL cluster: kept when the stack is deleted, with deletion protection, since it holds every session. */
  readonly cluster: CfnCluster;

  constructor(scope: Construct, id: string, props: FastAgentResourcesProps) {
    super(scope, id);
    refuseLeakingBuild(props.agentDir);
    const { runtime } = props;
    this.cluster = new CfnCluster(this, "Instances", { deletionProtectionEnabled: true });
    this.cluster.applyRemovalPolicy(RemovalPolicy.RETAIN);
    runtime.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({ actions: ["dsql:DbConnectAdmin"], resources: [this.cluster.attrResourceArn] }),
    );
    runtime.addEnvironmentVariable(DSQL_ENDPOINT_ENV, this.cluster.attrEndpoint);
    if (props.secretName !== undefined) {
      Secret.fromSecretNameV2(this, "Values", props.secretName).grantRead(runtime);
      runtime.addEnvironmentVariable(SECRETS_ENV, props.secretName);
    }
  }
}

/** Run where the agent is, so `@fastagent-sh/fastagent` is the agent's own; the directory is its first argument. */
const LEAK_CHECK = `
let platform;
try {
  platform = await import("@fastagent-sh/fastagent/platform");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.error("the agent in " + process.argv[1] + " has no @fastagent-sh/fastagent installed: run npm ci there first");
  process.exit(1);
}
const leaks = await platform.buildContextLeaks(process.argv[1]);
for (const leak of leaks) console.error(leak);
process.exit(leaks.length === 0 ? 0 : 1);
`;

/** Stop the synthesis when the agent's FastAgent finds the image would carry what it must not, saying what. */
function refuseLeakingBuild(agentDir: string): void {
  try {
    execFileSync(process.execPath, ["--input-type=module", "--eval", LEAK_CHECK, agentDir], {
      cwd: agentDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(said || `checking what the image would carry failed: ${(error as Error).message}`);
  }
}
