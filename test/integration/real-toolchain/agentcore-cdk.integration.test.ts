/**
 * The construct an AgentCore project's stack adds (`@fastagent-sh/agentcore/cdk`), synthesized with the real aws-cdk-lib:
 * the resources an agent needs beside its runtime, and the synthesis that stops, before any AWS resource changes, when
 * the image would carry this machine's secrets. It asks the agent's own FastAgent in a process of its own, hence this tier.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { App, CfnResource, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { type IPrincipal, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { describe, expect, it } from "vitest";
import { FastAgentResources } from "../../../packages/agentcore/src/cdk.ts";
import { DOCKER_TARGET, containerArtifacts } from "../../../packages/fastagent/src/deploy/container.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";

const RUNTIME_ARN = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/support-a1b2c3d4e5";

class FakeRuntime extends Construct {
  readonly runtimeArn = RUNTIME_ARN;
  readonly grantPrincipal: IPrincipal;
  readonly variables: Record<string, string> = {};
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const role = new Role(this, "ExecutionRole", {
      assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    new CfnResource(this, "Resource", { type: "AWS::BedrockAgentCore::Runtime" });
    this.grantPrincipal = role.grantPrincipal;
  }
  addEnvironmentVariable(name: string, value: string): void {
    this.variables[name] = value;
  }
}

/** A runtime as the AgentCore CLI's stack hands one over: a Construct with an ARN, a role, and environment variables. */
function runtimeIn(stack: Stack) {
  const runtime = new FakeRuntime(stack, "Runtime");
  return { variables: runtime.variables, runtime };
}

describe("FastAgentResources", () => {
  it("adds the database and read access to the agent's secret, by name, with no EventBridge Scheduler resources", async () => {
    const dir = await fauxAgent("fa-agentcore-cdk-");
    const generated = containerArtifacts({ target: DOCKER_TARGET, name: "support", hasLockfile: true });
    await writeFile(join(dir, ".dockerignore"), generated.find((a) => a.path === ".dockerignore")?.content ?? "");
    const stack = new Stack(new App(), "Agent", { env: { account: "123456789012", region: "ap-southeast-1" } });
    const { runtime, variables } = runtimeIn(stack);
    new FastAgentResources(stack, "FastAgent", { runtime, agentDir: dir, secretName: "support" });
    const template = Template.fromStack(stack);

    template.hasResource("AWS::DSQL::Cluster", {
      Properties: { DeletionProtectionEnabled: true },
      DeletionPolicy: "Retain",
    });
    template.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
    template.resourceCountIs("AWS::Scheduler::Schedule", 0);
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (
          policy as {
            Properties: {
              PolicyDocument: { Statement: { Action: unknown; Resource: unknown; Condition?: unknown }[] };
            };
          }
        ).Properties.PolicyDocument.Statement,
    );
    expect(statements.map((statement) => statement.Action)).toEqual(
      expect.arrayContaining(["dsql:DbConnectAdmin", expect.arrayContaining(["secretsmanager:GetSecretValue"])]),
    );
    expect(statements.map((s) => s.Resource)).not.toContain("*");
    expect(Object.keys(variables)).toEqual(["FASTAGENT_DSQL_ENDPOINT", "FASTAGENT_SECRETS"]);
    expect(variables.FASTAGENT_SECRETS).toBe("support");
    expect(JSON.stringify(template.toJSON())).not.toMatch(/SecretString|GenerateSecretString/);
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
  });

  it("stops the synthesis when the image would carry this machine's secrets, naming the file", async () => {
    const dir = await fauxAgent("fa-agentcore-cdk-leak-");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "ANTHROPIC_API_KEY=sk-1\n");
    await writeFile(join(dir, ".dockerignore"), "node_modules\n");
    const stack = new Stack(new App(), "Agent");
    const { runtime } = runtimeIn(stack);
    expect(() => new FastAgentResources(stack, "FastAgent", { runtime, agentDir: dir })).toThrow(
      /\.dockerignore \(kept\) does not exclude `\.secrets\/\.env`.* — the build context would BAKE SECRETS INTO THE IMAGE/,
    );
  });

  it("stops the synthesis when there is no .dockerignore at all, which leaves out nothing", async () => {
    const dir = await fauxAgent("fa-agentcore-cdk-unignored-");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "ANTHROPIC_API_KEY=sk-1\n");
    const stack = new Stack(new App(), "Agent");
    const { runtime } = runtimeIn(stack);
    expect(() => new FastAgentResources(stack, "FastAgent", { runtime, agentDir: dir })).toThrow(
      /there is no \.dockerignore, so the build would upload .*`\.secrets\/\.env`.*: this machine.s secrets and state/,
    );
  });

  it("stops the synthesis for a Dockerfile.dockerignore alone, which the upload to CodeBuild does not read", async () => {
    const dir = await fauxAgent("fa-agentcore-cdk-beside-");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "ANTHROPIC_API_KEY=sk-1\n");
    await writeFile(join(dir, "Dockerfile.dockerignore"), "**/.secrets/**\n");
    const stack = new Stack(new App(), "Agent");
    const { runtime } = runtimeIn(stack);
    expect(() => new FastAgentResources(stack, "FastAgent", { runtime, agentDir: dir })).toThrow(
      /there is no \.dockerignore, so the build would upload .*`\.secrets\/\.env`/,
    );
  });
});
