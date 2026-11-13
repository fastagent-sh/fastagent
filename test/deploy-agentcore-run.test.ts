import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../src/channels/discover.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import { ingressSessionId } from "../src/deploy/agentcore/plan.ts";
import { type AgentcoreRunPlan, deployAgentcoreRun } from "../src/deploy/agentcore/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import {
  type HostCliAnswer,
  type HostCliCall,
  awsRunner,
  recordHostCli,
  resetHostClis,
  spawnRunner,
} from "./host-cli-double.ts";

const IDENTITY = JSON.stringify({ Account: "123456789012" });
const OUTPUTS = JSON.stringify([
  { OutputKey: "RuntimeArn", OutputValue: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc" },
  { OutputKey: "ForwarderUrl", OutputValue: "https://xyz.lambda-url.us-west-2.on.aws/" },
]);

/** The CLI's answer for a stack that is not there — what a FIRST deploy reads. */
const NO_SUCH_STACK = {
  code: 254,
  stderr:
    "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id " +
    "fastagent-my-agent does not exist",
};

/**
 * Default happy-path aws script: identity + login password + stack outputs succeed, and the stack does not exist yet.
 * The two `describe-stacks` calls ask DIFFERENT questions (status before the build, outputs after the deploy) and get
 * different answers here — one reply for both would make every case a redeploy and leave the double unable to express
 * a first deploy at all.
 */
const happyAws = ({ args }: HostCliCall): HostCliAnswer => {
  if (args[0] === "sts") return { stdout: IDENTITY };
  if (args[0] === "ecr" && args[1] === "get-login-password") return { stdout: "hunter2" };
  if (args[0] === "secretsmanager" && args[1] === "describe-secret") {
    return { stdout: args.includes("ARN") ? `${SECRET_ARN}\n` : JSON.stringify({ ARN: SECRET_ARN }) };
  }
  if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
    return args.includes("Stacks[0].StackStatus") ? NO_SUCH_STACK : { stdout: OUTPUTS };
  }
  return {};
};

const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:fastagent/my-agent-AbCdEf";

const NO_WEBHOOKS = { webhooks: false };
const FORWARDER = { webhooks: true };
const plan = (over: Partial<AgentcoreRunPlan> = {}): AgentcoreRunPlan => ({
  name: "my-agent",
  templatePath: "agentcore.template.yaml",
  dockerfilePath: "Dockerfile",
  tag: "20260728",
  region: "us-west-2",
  provideSecrets: async () => undefined,
  ingressSecret: "ingress-secret",
  wakeSecret: "wake-secret",
  channels: [],
  topology: NO_WEBHOOKS,
  ...over,
});

const writeParams = vi.fn(async (_content: string) => "/tmp/params.json");
const writeZip = vi.fn(async (_bytes: Uint8Array) => "/tmp/forwarder.zip");

// The post-deploy probe rides the global fetch by default; answer the ok verdict so every existing
// flow proceeds — the probe's own describe overrides this per test.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true })),
  );
});
afterEach(() => {
  resetHostClis();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The runtime as the forwarder's probe reaches it: verified, and reporting how it pointed each webhook channel. */
const runtimeReporting = (webhooks: { channel: string; outcome: string }[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, webhooks })),
  );

/** Registration happens on the runtime now: a deploy's own registrar is called for Slack's page alone. */
const run = (
  p: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
) => deployAgentcoreRun(p, aws, docker, () => {}, writeParams, writeZip, { telegram: tg }, { intervalMs: 1 });

describe("deploy/agentcore/run: the coding-agent deploy journey", () => {
  it("happy path: identity → docker checks → ecr → login → buildx push → cfn deploy → outputs → webhook", async () => {
    const aws = recordHostCli("aws", happyAws);
    const docker = recordHostCli("docker");
    runtimeReporting([{ channel: "telegram", outcome: "registered" }]);
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
        topology: FORWARDER,
      }),
      awsRunner("."),
      spawnRunner("docker", "."),
      tg,
    );

    expect(out).toEqual({
      ok: true,
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc",
      url: "https://xyz.lambda-url.us-west-2.on.aws", // trailing slash stripped for the registrars
    });
    expect(aws.cmds()).toEqual([
      "sts get-caller-identity --output json",
      // The pre-flight region probe: cheap, and BEFORE the multi-minute build it would otherwise waste.
      "bedrock-agentcore-control list-agent-runtimes --max-items 1 --region us-west-2",
      // The role the runtime needs in this account: there, so nothing is created.
      "iam get-role --role-name AWSServiceRoleForBedrockAgentCoreRuntimeIdentity",
      // The stack is read ONCE, here: what it says (a redeploy that replaces state, or a failed first create) is
      // only actionable before the build, and step 7 reuses this answer instead of asking again.
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].StackStatus --output text",
      // The deployment's values, after the only reads that precede a write: the secret the stack reads exists (nothing
      // to create), and the step that fills it ran.
      "secretsmanager describe-secret --secret-id fastagent/my-agent --output json",
      "ecr describe-repositories --repository-names fastagent/my-agent",
      // The deployment bucket: created if absent, its safety/durability properties re-converged every
      // deploy, then the content-hashed forwarder package uploaded.
      "s3api head-bucket --bucket fa-my-agent-123456789012",
      "s3api put-public-access-block --bucket fa-my-agent-123456789012 --public-access-block-configuration " +
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
      expect.stringMatching(
        /^s3 cp \/tmp\/forwarder\.zip s3:\/\/fa-my-agent-123456789012\/forwarder\/[0-9a-f]{16}\.zip$/,
      ),
      "ecr get-login-password",
      "secretsmanager describe-secret --secret-id fastagent/my-agent --query ARN --output text",
      "cloudformation deploy --stack-name fastagent-my-agent --template-file agentcore.template.yaml " +
        "--capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides file:///tmp/params.json",
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].Outputs --output json",
      // The redeploy-immediacy step: a live ingress session would keep serving the OLD image.
      "bedrock-agentcore stop-runtime-session " +
        "--agent-runtime-arn arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc " +
        `--runtime-session-id ${ingressSessionId("my-agent")}`,
    ]);
    expect(docker.cmds()).toEqual([
      "version",
      "buildx version",
      "login --username AWS --password-stdin 123456789012.dkr.ecr.us-west-2.amazonaws.com",
      "buildx build --pull --platform linux/arm64 -t 123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728 --push -f Dockerfile .",
    ]);
    // The ECR password flows stdout→stdin between the runners, never argv.
    expect(docker.calls.find((c) => c.args[0] === "login")?.input).toBe("hunter2");
    // The runtime pointed Telegram itself; the deploy read what it made of it.
    expect(tg).not.toHaveBeenCalled();
    // Secrets ride the params FILE (0600 temp), never argv.
    const forwarderKey = aws
      .cmds()
      .find((c) => c.startsWith("s3 cp"))!
      .split(`s3://fa-my-agent-123456789012/`)[1]!;
    expect(writeParams).toHaveBeenCalledWith(
      `${JSON.stringify([
        "ImageUri=123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728",
        `SecretArn=${SECRET_ARN}`,
        "ForwarderBucket=fa-my-agent-123456789012",
        `ForwarderS3Key=${forwarderKey}`,
        "FastagentIngressSecret=ingress-secret",
        "FastagentWakeSecret=wake-secret",
      ])}\n`,
    );
  });

  it("gates on: no aws CLI / no credentials / no region / no docker / daemon down / no buildx", async () => {
    const aws = awsRunner(".");
    const docker = spawnRunner("docker", ".");

    const noCli = await run(plan(), aws, docker);
    expect(noCli).toMatchObject({ ok: false, gate: expect.stringContaining("aws CLI not found") });

    recordHostCli("aws", () => ({ code: 1 }));
    const noCreds = await run(plan(), aws, docker);
    expect(noCreds).toMatchObject({ ok: false, gate: expect.stringContaining("no working AWS credentials") });

    recordHostCli("aws", ({ args }) =>
      args[0] === "sts" ? { stdout: IDENTITY } : args[0] === "configure" ? { stdout: "" } : {},
    );
    const noRegion = await run(plan({ region: undefined }), aws, docker);
    expect(noRegion).toMatchObject({ ok: false, gate: expect.stringContaining("no AWS region") });

    recordHostCli("aws", happyAws);
    const noDocker = await run(plan(), aws, docker);
    expect(noDocker).toMatchObject({ ok: false, gate: expect.stringContaining("docker not found") });

    // Docker CLI present but the daemon is down: `docker version` exits non-zero non-127. Must gate
    // BEFORE any AWS side effect — not stumble into a generic build failure after creating ECR.
    const daemonAws = recordHostCli("aws", happyAws);
    recordHostCli("docker", ({ args }) => (args[0] === "version" ? { code: 1 } : {}));
    const noDaemon = await run(plan(), aws, docker);
    expect(noDaemon).toMatchObject({ ok: false, gate: expect.stringContaining("daemon not reachable") });
    expect(daemonAws.cmds().some((c) => c.startsWith("ecr"))).toBe(false);

    recordHostCli("docker", ({ args }) => (args[0] === "buildx" ? { code: 1 } : {}));
    const noBuildx = await run(plan(), aws, docker);
    expect(noBuildx).toMatchObject({ ok: false, gate: expect.stringContaining("buildx") });
  });
});
