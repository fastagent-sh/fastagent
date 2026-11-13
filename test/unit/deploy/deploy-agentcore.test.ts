import { declaredChannels } from "../../../src/channels/discover.ts";
import { describe, expect, it } from "vitest";
import {
  type AgentcorePlanInput,
  MOUNT,
  SECRETS_DIR,
  agentcoreTemplateFile,
  FORWARDER_FILE,
  forwarderSource,
  ingressSessionId,
  planAgentcoreDeploy,
} from "../../../src/deploy/agentcore/plan.ts";

const baseInput = (over: Partial<AgentcorePlanInput> = {}): AgentcorePlanInput => ({
  config: "{}",
  name: "my-agent",
  channels: [],
  runtime: "node",
  hasLockfile: false,
  agent: "my-agent",
  ...over,
});

describe("deploy agentcore: the plan", () => {
  it("minimal shape (no channel, no schedule): the forwarder is still there — it carries the wake alarms", () => {
    const plan = planAgentcoreDeploy(baseInput());
    expect(plan.artifacts.map((a) => a.path)).toEqual([
      agentcoreTemplateFile("my-agent"),
      FORWARDER_FILE,
      ".fastagent/deploy/fastagent.packages",
      "Dockerfile",
      ".dockerignore",
    ]);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::BedrockAgentCore::Runtime");
    expect(template).toContain("AgentRuntimeName: my_agent");
    expect(template).toContain(`SessionStorage: { MountPath: ${MOUNT} }`);
    expect(template).not.toContain("EfsAccessPoint");
    expect(template).toContain('FASTAGENT_AGENTCORE: "1"');
    expect(template).toContain('PORT: "8080"');
    expect(template).toContain(`FASTAGENT_ROOT: "${MOUNT}"`);
    expect(template).toContain(`FASTAGENT_STATE_DIR: "${MOUNT}/.state"`);
    expect(template).toContain(`FASTAGENT_SECRETS_DIR: "${SECRETS_DIR}"`);
    expect(template).toContain("AWS::Lambda::Function");
    expect(template).not.toContain("AWS::Scheduler::Schedule");
    expect(template).not.toContain("WEBHOOKS_ENABLED"); // no channel: the forwarder relays no webhook
    expect(plan.runbook.join("\n")).toContain("stop-runtime-session");
    // A first use of AgentCore in an account needs its role before the stack; the manual path says so as `--run` does.
    expect(plan.runbook.join("\n")).toContain(
      "aws iam create-service-linked-role --aws-service-name runtime-identity.bedrock-agentcore.amazonaws.com",
    );
    // A manual deploy passes the ingress secret, and activates the container THROUGH THE FORWARDER: that is what
    // tells it where to set its alarms (an invoke-agent-runtime call goes through IAM and carries no address).
    expect(plan.runbook.join("\n")).toContain("FastagentIngressSecret=<another random string>");
    expect(plan.runbook.join("\n")).toContain(
      `curl -fsS -X POST "<ForwarderUrl>/__fastagent/probe" -d '{"auth":"<FastagentIngressSecret>"}'`,
    );
    expect(plan.runbook.join("\n")).toContain("fastagent deploy agentcore");
    expect(plan.runbook.join("\n")).toContain("fastagent logs agentcore --follow");
    expect(plan.runbook.join("\n")).toContain("--source forwarder");
    // The only state this host does not reclaim: a turn's reply is a log line, and CloudWatch keeps log data
    // indefinitely until someone sets a retention policy. The runbook has to say so — nothing else will.
    expect(plan.runbook.join("\n")).toContain("aws logs put-retention-policy");
  });

  it("a route channel brings the forwarder (Lambda + URL + permission) and the webhook step", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) }));
    expect(plan.artifacts.map((a) => a.path)).toContain(FORWARDER_FILE);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(template).toContain("Type: AWS::Lambda::Url");
    expect(template).toContain("AuthType: NONE");
    // BOTH url permissions — post-Oct-2025 Function URLs 403 with only InvokeFunctionUrl.
    expect(template).toContain("Action: lambda:InvokeFunctionUrl");
    expect(template).toContain("Action: lambda:InvokeFunction\n");
    // Background turns refresh short-lived S3 capabilities through this same authenticated URL.
    expect(template).toContain("INGRESS_SECRET: !Ref FastagentIngressSecret");
    expect(template).toContain("Action: lambda:GetFunctionUrlConfig");
    // CommonJS on purpose — CFN inline code lands as index.js where ESM import is a syntax error.
    expect(forwarderSource()).toContain('require("@aws-sdk/client-bedrock-agentcore")');
    expect(forwarderSource()).toContain("exports.handler");
    expect(forwarderSource()).not.toMatch(/^import /m);
    expect(template).toContain(`INGRESS_SESSION_ID: ${ingressSessionId("my-agent")}`);
    // Values are read from one Secrets Manager secret, never a parameter per name.
    expect(template).toContain("FASTAGENT_SECRET_ARN: !Ref SecretArn");
    expect(template).not.toContain("FastagentEnv");
    expect(template).not.toContain("TelegramBotToken");
    expect(plan.runbook.join("\n")).toContain("makes the runtime point telegram at <ForwarderUrl>");
    // The redeploy-immediacy step is in the manual runbook too (— --run automates it).
    expect(plan.runbook.join("\n")).toContain("stop-runtime-session");
    expect(plan.runbook.join("\n")).toContain("fastagent logs agentcore --source forwarder --follow");
    // A second log source is a second unbounded group: the Lambda's own, which defaults to never expiring just
    // like the runtime's. "Every log has a layer that bounds it" is false here unless BOTH are named.
    expect(plan.runbook.join("\n")).toContain(
      "aws logs put-retention-policy --log-group-name /aws/lambda/fastagent-my-agent-forwarder --retention-in-days 14",
    );
    // The shipped artifact IS the forwarder source (it becomes the Lambda package verbatim).
    const forwarder = plan.artifacts.find((a) => a.path === FORWARDER_FILE)!;
    expect(forwarder.content).toBe(forwarderSource());
    expect(forwarder.content).toContain("InvokeAgentRuntimeCommand");
  });
});
