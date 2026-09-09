import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../src/channels/discover.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import { AUTH_SEED_MAX_CHUNKS, ingressSessionId } from "../src/deploy/agentcore/plan.ts";
import {
  type AgentcoreRunPlan,
  deployAgentcoreRun,
  paramsFileContent,
  parseStackOutputs,
} from "../src/deploy/agentcore/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** A fake CLI: records every call, returns per-command scripted results (default code 0, empty out). */
function fakeCli(script: (args: string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const cli: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: opts?.captureStderr ? (r.stderr ?? "") : undefined };
  };
  return { cli, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const IDENTITY = JSON.stringify({ Account: "123456789012" });
const OUTPUTS = JSON.stringify([
  { OutputKey: "RuntimeArn", OutputValue: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc" },
  { OutputKey: "ForwarderUrl", OutputValue: "https://xyz.lambda-url.us-west-2.on.aws/" },
]);

/** Default happy-path aws script: identity + login password + stack outputs succeed. */
const happyAws = (args: string[]): { code?: number; stdout?: string } => {
  if (args[0] === "sts") return { stdout: IDENTITY };
  if (args[0] === "ecr" && args[1] === "get-login-password") return { stdout: "hunter2" };
  if (args[0] === "cloudformation" && args[1] === "describe-stacks") return { stdout: OUTPUTS };
  return {};
};

const NO_FORWARDER = { webhooks: false, forwarder: false, wakeAlarms: false };
const FORWARDER = { webhooks: true, forwarder: true, wakeAlarms: false };
const plan = (over: Partial<AgentcoreRunPlan> = {}): AgentcoreRunPlan => ({
  name: "my-agent",
  templatePath: "agentcore.template.yaml",
  dockerfilePath: "fastagent/Dockerfile",
  tag: "20260728",
  region: "us-west-2",
  secrets: {},
  missingSecrets: [],
  channels: [],
  topology: NO_FORWARDER,
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
  vi.unstubAllGlobals();
});

const run = (
  p: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
) => deployAgentcoreRun(p, aws, docker, () => {}, writeParams, writeZip, { telegram: tg });

describe("the deployment bucket (the agent's memory outlives the stack)", () => {
  const withForwarder = plan({ topology: FORWARDER });

  it("creates it when absent, locks it down, and hands the stack the bucket + content-hashed key", async () => {
    const { cli: aws, cmds } = fakeCli((a) =>
      a[0] === "s3api" && a[1] === "head-bucket" ? { code: 254 } : happyAws(a),
    );
    writeParams.mockClear();

    const out = await run(withForwarder, aws, fakeCli().cli);

    expect(out).toMatchObject({ ok: true });
    expect(cmds().find((c) => c.startsWith("s3api create-bucket"))).toContain("--bucket fa-my-agent-123456789012");
    expect(cmds().join("\n")).toContain("put-public-access-block");
    const upload = cmds().find((c) => c.startsWith("s3 cp"))!;
    expect(upload).toMatch(/s3 cp \/tmp\/forwarder\.zip s3:\/\/fa-my-agent-123456789012\/forwarder\/[0-9a-f]{16}\.zip/);
    const params = JSON.parse(writeParams.mock.calls[0]![0]) as string[];
    expect(params).toContain("ForwarderBucket=fa-my-agent-123456789012");
    expect(params.some((p) => /^ForwarderS3Key=forwarder\/[0-9a-f]{16}\.zip$/.test(p))).toBe(true);
  });

  it("skips CREATION when it exists, but re-converges its safety/durability properties every deploy", async () => {
    const { cli: aws, cmds } = fakeCli(happyAws); // head-bucket succeeds
    await run(withForwarder, aws, fakeCli().cli);
    expect(cmds().join("\n")).not.toContain("create-bucket");
    // A half-finished first run must not leave a world-readable, unversioned store of the agent's
    // credentials looking "done" forever after.
    expect(cmds().join("\n")).toContain("put-public-access-block");
    expect(cmds().some((c) => c.startsWith("s3 cp"))).toBe(true); // the code still uploads
  });

  it("gates when the deployment bucket cannot be secured", async () => {
    const { cli: aws, cmds } = fakeCli((a) =>
      a[1] === "put-public-access-block" ? { code: 1 } : a[1] === "head-bucket" ? { code: 254 } : happyAws(a),
    );
    const out = await run(withForwarder, aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false });
    expect((out as { gate: string }).gate).toContain("block public access");
    expect(cmds().join("\n")).not.toContain("cloudformation deploy");
  });

  it("omits LocationConstraint in us-east-1 (the one region whose create-bucket rejects it)", async () => {
    const { cli: aws, cmds } = fakeCli((a) =>
      a[0] === "s3api" && a[1] === "head-bucket" ? { code: 254 } : happyAws(a),
    );
    await run(plan({ topology: FORWARDER, region: "us-east-1" }), aws, fakeCli().cli);
    expect(cmds().find((c) => c.startsWith("s3api create-bucket"))).not.toContain("LocationConstraint");

    const { cli: other, cmds: otherCmds } = fakeCli((a) =>
      a[0] === "s3api" && a[1] === "head-bucket" ? { code: 254 } : happyAws(a),
    );
    await run(plan({ topology: FORWARDER, region: "eu-west-1" }), other, fakeCli().cli);
    expect(otherCmds().find((c) => c.startsWith("s3api create-bucket"))).toContain("LocationConstraint=eu-west-1");
  });

  it("gates on a failed upload — deploying a stack whose Lambda code is missing would 500 every webhook", async () => {
    const { cli: aws, cmds } = fakeCli((a) => (a[0] === "s3" && a[1] === "cp" ? { code: 1 } : happyAws(a)));
    const out = await run(withForwarder, aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false });
    expect((out as { gate: string }).gate).toContain("forwarder package");
    expect(cmds().join("\n")).not.toContain("cloudformation deploy");
  });

  it("an invoke-only deployment touches no bucket at all", async () => {
    const { cli: aws, cmds } = fakeCli(happyAws);
    writeParams.mockClear();
    await run(plan({ topology: NO_FORWARDER }), aws, fakeCli().cli);
    expect(cmds().join("\n")).not.toContain("s3");
    expect(JSON.parse(writeParams.mock.calls[0]![0] as string).join()).not.toContain("ForwarderBucket");
  });
});

describe("deploy/agentcore/run: the coding-agent deploy journey", () => {
  it("happy path: identity → docker checks → ecr → login → buildx push → cfn deploy → outputs → webhook", async () => {
    const { cli: aws, cmds: awsCmds } = fakeCli(happyAws);
    const { cli: docker, cmds: dockerCmds, calls: dockerCalls } = fakeCli();
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({
        channels: declaredChannels(["telegram"]),
        topology: FORWARDER,
        secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" },
      }),
      aws,
      docker,
      tg,
    );

    expect(out).toEqual({
      ok: true,
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc",
      url: "https://xyz.lambda-url.us-west-2.on.aws", // trailing slash stripped for the registrars
    });
    expect(awsCmds()).toEqual([
      "sts get-caller-identity --output json",
      // The pre-flight region probe: cheap, and BEFORE the multi-minute build it would otherwise waste.
      "bedrock-agentcore-control list-agent-runtimes --max-items 1 --region us-west-2",
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
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].StackStatus --output text",
      "cloudformation deploy --stack-name fastagent-my-agent --template-file agentcore.template.yaml " +
        "--capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides file:///tmp/params.json",
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].Outputs --output json",
      // The redeploy-immediacy step: a live ingress session would keep serving the OLD image.
      "bedrock-agentcore stop-runtime-session " +
        "--agent-runtime-arn arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc " +
        `--runtime-session-id ${ingressSessionId("my-agent")}`,
    ]);
    expect(dockerCmds()).toEqual([
      "version",
      "buildx version",
      "login --username AWS --password-stdin 123456789012.dkr.ecr.us-west-2.amazonaws.com",
      // `-f` is unconditional: the artifacts sit under the agent prefix and the context is the
      // workspace above it, so the context's own Dockerfile is never the one to build.
      "buildx build --platform linux/arm64 -t 123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728 --push -f fastagent/Dockerfile .",
    ]);
    // The ECR password flows stdout→stdin between the runners, never argv.
    expect(dockerCalls.find((c) => c.args[0] === "login")?.input).toBe("hunter2");
    expect(tg).toHaveBeenCalledWith("https://xyz.lambda-url.us-west-2.on.aws");
    // Secrets ride the params FILE (0600 temp), never argv.
    const forwarderKey = awsCmds()
      .find((c) => c.startsWith("s3 cp"))!
      .split(`s3://fa-my-agent-123456789012/`)[1]!;
    expect(writeParams).toHaveBeenCalledWith(
      `${JSON.stringify([
        "ImageUri=123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728",
        "ForwarderBucket=fa-my-agent-123456789012",
        `ForwarderS3Key=${forwarderKey}`,
        "TelegramBotToken=t",
        "TelegramSecretToken=s",
        "FastagentAuthSeed=",
        "FastagentAuthSeed2=",
        "FastagentAuthSeed3=",
        "FastagentAuthSeed4=",
      ])}\n`,
    );
  });

  it("gates on: no aws CLI / no credentials / no region / no docker / daemon down / no buildx", async () => {
    const { cli: docker } = fakeCli();
    const noCli = await run(plan(), fakeCli(() => ({ code: 127 })).cli, docker);
    expect(noCli).toMatchObject({ ok: false, gate: expect.stringContaining("aws CLI not found") });

    const noCreds = await run(plan(), fakeCli(() => ({ code: 1 })).cli, docker);
    expect(noCreds).toMatchObject({ ok: false, gate: expect.stringContaining("no working AWS credentials") });

    const noRegion = await run(
      plan({ region: undefined }),
      fakeCli((a) => (a[0] === "sts" ? { stdout: IDENTITY } : a[0] === "configure" ? { stdout: "" } : {})).cli,
      docker,
    );
    expect(noRegion).toMatchObject({ ok: false, gate: expect.stringContaining("no AWS region") });

    const noDocker = await run(plan(), fakeCli(happyAws).cli, fakeCli(() => ({ code: 127 })).cli);
    expect(noDocker).toMatchObject({ ok: false, gate: expect.stringContaining("docker not found") });

    // Docker CLI present but the daemon is down: `docker version` exits non-zero non-127. Must gate
    // BEFORE any AWS side effect — not stumble into a generic build failure after creating ECR.
    const daemonDown = fakeCli(happyAws);
    const noDaemon = await run(plan(), daemonDown.cli, fakeCli((a) => (a[0] === "version" ? { code: 1 } : {})).cli);
    expect(noDaemon).toMatchObject({ ok: false, gate: expect.stringContaining("daemon not reachable") });
    expect(daemonDown.cmds().some((c) => c.startsWith("ecr"))).toBe(false);

    const noBuildx = await run(
      plan(),
      fakeCli(happyAws).cli,
      fakeCli((a) => (a[0] === "buildx" ? { code: 1 } : {})).cli,
    );
    expect(noBuildx).toMatchObject({ ok: false, gate: expect.stringContaining("buildx") });
  });

  it("resolves the region via `aws configure get region` when the env gave none", async () => {
    const { cli: aws, cmds } = fakeCli((a) => (a[0] === "configure" ? { stdout: "eu-west-1\n" } : happyAws(a)));
    const out = await run(plan({ region: undefined }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true });
    expect(cmds()).toContain("configure get region");
  });

  it("gates missing secret values BEFORE any side effect", async () => {
    const { cli: aws, cmds } = fakeCli(happyAws);
    const out = await run(plan({ missingSecrets: ["TELEGRAM_BOT_TOKEN"] }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(cmds().some((c) => c.startsWith("ecr create") || c.startsWith("cloudformation"))).toBe(false);
  });

  it("skips ECR create when the repository exists; creates it when describe fails", async () => {
    const exists = fakeCli(happyAws);
    await run(plan(), exists.cli, fakeCli().cli);
    expect(exists.cmds().some((c) => c.startsWith("ecr create-repository"))).toBe(false);

    const absent = fakeCli((a) => (a[0] === "ecr" && a[1] === "describe-repositories" ? { code: 254 } : happyAws(a)));
    await run(plan(), absent.cli, fakeCli().cli);
    expect(absent.cmds()).toContain("ecr create-repository --repository-name fastagent/my-agent");
  });

  it("a ROLLBACK_COMPLETE stack (failed first create) is deleted + awaited before re-creating", async () => {
    const { cli: aws, cmds } = fakeCli((a) => {
      if (a[0] === "cloudformation" && a[1] === "describe-stacks" && a.includes("Stacks[0].StackStatus")) {
        return { stdout: "ROLLBACK_COMPLETE\n" };
      }
      return happyAws(a);
    });
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true });
    expect(cmds()).toContain("cloudformation delete-stack --stack-name fastagent-my-agent");
    expect(cmds()).toContain("cloudformation wait stack-delete-complete --stack-name fastagent-my-agent");
  });

  it("gates an auth seed beyond the chunk ceiling and any other >2048-char secret", async () => {
    const tooBigSeed = await run(
      plan({ secrets: { FASTAGENT_AUTH_SEED: "x".repeat(8001) } }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
    );
    expect(tooBigSeed).toMatchObject({ ok: false, gate: expect.stringContaining("auth.json is too large") });

    const tooBigSecret = await run(
      plan({ secrets: { SOME_BLOB: "x".repeat(2049) } }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
    );
    expect(tooBigSecret).toMatchObject({ ok: false, gate: expect.stringContaining("SOME_BLOB") });
  });

  it("announces account/principal/region/image and flags an unavailable region BEFORE any side effect", async () => {
    const logs: string[] = [];
    const { cli: aws, calls } = fakeCli((a) => {
      if (a[0] === "sts") {
        return { stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:root" }) };
      }
      if (a[0] === "bedrock-agentcore-control") {
        return { code: 254, stderr: "SSL validation failed for https://bedrock-agentcore-control.ca-west-1…" };
      }
      return happyAws(a);
    });
    const out = await deployAgentcoreRun(
      plan({ region: "ca-west-1" }),
      aws,
      fakeCli().cli,
      (m) => logs.push(m),
      writeParams,
      writeZip,
      { telegram: async () => "registered" },
    );

    expect(out).toMatchObject({ ok: true }); // the region probe WARNS, it never refuses the deploy
    const header = logs[0]!;
    expect(header).toBe(
      "account 123456789012 (arn:aws:iam::123456789012:root), region ca-west-1 (from the environment), " +
        "image fastagent/my-agent:20260728",
    );
    expect(logs[1]).toContain("root user");
    expect(logs[2]).toContain("could not confirm AgentCore is available in ca-west-1");
    expect(logs[2]).toContain("SSL validation failed"); // the CLI's own reason, not our guess
    // "Before any side effect" is the whole point: nothing was created by the time it printed.
    const spoken = calls.findIndex((c) => c.args[0] === "bedrock-agentcore-control");
    expect(calls.slice(0, spoken).every((c) => c.args[0] === "sts" || c.args[0] === "configure")).toBe(true);
  });

  it("stays quiet about the principal when the identity carries no Arn, and names where the region came from", async () => {
    const logs: string[] = [];
    // No AWS_REGION: the region (and so the source label an operator reads to answer "where did this come from?")
    // is the one `aws configure get region` gave.
    const aws = fakeCli((a) => (a[0] === "configure" ? { stdout: "eu-west-1\n" } : happyAws(a)));
    await deployAgentcoreRun(
      plan({ region: undefined }),
      aws.cli,
      fakeCli().cli,
      (m) => logs.push(m),
      writeParams,
      writeZip,
      { telegram: async () => "registered" },
    );
    expect(logs[0]).toBe(
      "account 123456789012, region eu-west-1 (from aws configure), image fastagent/my-agent:20260728",
    );
    expect(aws.cmds()).toContain("bedrock-agentcore-control list-agent-runtimes --max-items 1 --region eu-west-1");
    expect(logs.join("\n")).not.toContain("root user");
    expect(logs.join("\n")).not.toContain("could not confirm");
  });

  it("a failed cfn deploy gates with the stack-events pointer", async () => {
    const { cli: aws } = fakeCli((a) => (a[0] === "cloudformation" && a[1] === "deploy" ? { code: 1 } : happyAws(a)));
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("describe-stack-events") });
  });

  it("declared channels without a ForwarderUrl output gate (an edited template must not half-deploy)", async () => {
    const { cli: aws } = fakeCli((a) =>
      a[0] === "cloudformation" && a[1] === "describe-stacks"
        ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
        : happyAws(a),
    );
    const out = await run(plan({ channels: declaredChannels(["telegram"]), topology: FORWARDER }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("ForwarderUrl") });
  });

  it("a stop failing with NotFound is a quiet advisory (first deploy has no session)", async () => {
    const logs: string[] = [];
    const { cli: aws } = fakeCli((a) =>
      a[0] === "bedrock-agentcore" && a[1] === "stop-runtime-session"
        ? { code: 254, stderr: "An error occurred (ResourceNotFoundException): session does not exist" }
        : happyAws(a),
    );
    const out = await deployAgentcoreRun(
      plan({ topology: FORWARDER }),
      aws,
      fakeCli().cli,
      (m) => logs.push(m),
      writeParams,
      writeZip,
      { telegram: async () => "registered" },
    );
    expect(out).toMatchObject({ ok: true });
    expect(logs.join("\n")).toContain("no ingress session to stop");
    expect(logs.join("\n")).not.toContain("PREVIOUS");
  });

  it("any OTHER stop failure GATES — the probe would otherwise 'verify' the old image still serving", async () => {
    // The probe reaches the same fixed ingress session id; if the stop cannot be confirmed, a
    // session still running the previous image would answer it and the deploy would claim a
    // verification it never performed. Unable to guarantee freshness = unable to verify = gate.
    const probe = vi.fn();
    vi.stubGlobal("fetch", probe);
    const { cli: aws } = fakeCli((a) =>
      a[0] === "bedrock-agentcore" && a[1] === "stop-runtime-session"
        ? { code: 254, stderr: "An error occurred (AccessDeniedException): not authorized" }
        : happyAws(a),
    );
    const out = await deployAgentcoreRun(
      plan({ topology: FORWARDER }),
      aws,
      fakeCli().cli,
      () => {},
      writeParams,
      writeZip,
      { telegram: async () => "registered" },
    );
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("stop-runtime-session") });
    expect((out as { gate: string }).gate).toContain("AccessDeniedException");
    expect(probe).not.toHaveBeenCalled(); // no probe against a session of unknown vintage
  });

  it("a pure-invoke deployment also stops its fixed writer to activate the new image", async () => {
    const { cli: aws, cmds } = fakeCli((a) =>
      a[0] === "cloudformation" && a[1] === "describe-stacks" && a.includes("Stacks[0].Outputs")
        ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
        : happyAws(a),
    );
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true, runtimeArn: "arn:x" });
    expect(cmds().some((c) => c.includes("stop-runtime-session"))).toBe(true);
  });

  it("a stop failure does NOT gate a pure-invoke deployment — it has no probe to protect", async () => {
    // The gate exists because the probe reaches the same fixed session id. Without a forwarder there
    // is no probe, so the only cost is immediacy (the platform reclaims the session anyway) and
    // failing an already-applied deploy would be a false failure a re-run reproduces.
    const logs: string[] = [];
    const { cli: aws } = fakeCli((a) =>
      a[0] === "bedrock-agentcore" && a[1] === "stop-runtime-session"
        ? { code: 254, stderr: "An error occurred (AccessDeniedException): not authorized" }
        : a[0] === "cloudformation" && a[1] === "describe-stacks" && a.includes("Stacks[0].Outputs")
          ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
          : happyAws(a),
    );
    const out = await deployAgentcoreRun(plan(), aws, fakeCli().cli, (m) => logs.push(m), writeParams, writeZip, {
      telegram: async () => "registered",
    });
    expect(out).toMatchObject({ ok: true, runtimeArn: "arn:x" });
    expect(logs.join("\n")).toContain("AccessDeniedException");

    // The WORDING follows the answer, not the topology: a first deploy has no session to stop, so
    // "the previous image may keep serving" would name a container that never existed.
    const first: string[] = [];
    const { cli: awsFirst } = fakeCli((a) =>
      a[0] === "bedrock-agentcore" && a[1] === "stop-runtime-session"
        ? { code: 254, stderr: "An error occurred (ResourceNotFoundException): session does not exist" }
        : a[0] === "cloudformation" && a[1] === "describe-stacks" && a.includes("Stacks[0].Outputs")
          ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
          : happyAws(a),
    );
    await deployAgentcoreRun(plan(), awsFirst, fakeCli().cli, (m) => first.push(m), writeParams, writeZip, {
      telegram: async () => "registered",
    });
    expect(first.join("\n")).toContain("no ingress session to stop");
    expect(first.join("\n")).not.toContain("previous image");
  });

  it("a failed telegram registration gates AFTER the deploy (the app itself deployed)", async () => {
    const { cli: aws } = fakeCli(happyAws);
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "failed");
    const out = await run(plan({ channels: declaredChannels(["telegram"]) }), aws, fakeCli().cli, tg);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("telegram") });
  });
});

describe("deploy/agentcore/run: helpers", () => {
  it("parseStackOutputs tolerates garbage and partial shapes", () => {
    expect(parseStackOutputs("not json")).toEqual({});
    // A stack with no Outputs answers `null`, which must read as "no RuntimeArn" (the driver gates).
    expect(parseStackOutputs("null")).toEqual({});
    expect(parseStackOutputs(JSON.stringify([{ OutputKey: "A", OutputValue: "1" }, { OutputKey: 2 }]))).toEqual({
      A: "1",
    });
  });

  it("paramsFileContent: maps env names, chunks a long auth seed in order, clears every unused chunk", () => {
    expect(paramsFileContent("img:1", { OPENAI_API_KEY: "sk", FASTAGENT_AUTH_SEED: "b64" })).toBe(
      `${JSON.stringify([
        "ImageUri=img:1",
        "OpenaiApiKey=sk",
        "FastagentAuthSeed=b64",
        "FastagentAuthSeed2=",
        "FastagentAuthSeed3=",
        "FastagentAuthSeed4=",
      ])}\n`,
    );

    // A real OAuth-size seed (2756+) rides across the chunks, reassemblable in order.
    const seed = "a".repeat(2000) + "b".repeat(2000) + "c".repeat(756);
    const chunked = JSON.parse(paramsFileContent("img:1", { FASTAGENT_AUTH_SEED: seed })) as string[];
    expect(chunked).toEqual([
      "ImageUri=img:1",
      `FastagentAuthSeed=${"a".repeat(2000)}`,
      `FastagentAuthSeed2=${"b".repeat(2000)}`,
      `FastagentAuthSeed3=${"c".repeat(756)}`,
      "FastagentAuthSeed4=",
    ]);
    for (const param of chunked) expect(param.length).toBeLessThanOrEqual(2048 + "FastagentAuthSeed0=".length);

    // Switching to an API key clears a previously deployed seed rather than leaving it behind.
    const cleared = JSON.parse(paramsFileContent("img:1", { OPENAI_API_KEY: "sk" })) as string[];
    expect(cleared.filter((param) => param.startsWith("FastagentAuthSeed"))).toEqual([
      "FastagentAuthSeed=",
      "FastagentAuthSeed2=",
      "FastagentAuthSeed3=",
      "FastagentAuthSeed4=",
    ]);
    expect(cleared.filter((param) => param.startsWith("FastagentAuthSeed"))).toHaveLength(AUTH_SEED_MAX_CHUNKS);
  });
});

describe("the post-deploy probe (verify restore + construction before registration)", () => {
  it("names the secrets it carries — the list is no longer only what the author typed", async () => {
    // A mounted tool/channel/schedule declares its own names, so what `--run` reads from THIS machine
    // and puts on the runtime has to be visible on this host too.
    const logs: string[] = [];
    await deployAgentcoreRun(
      plan({ secrets: { OPENAI_API_KEY: "sk", X_API_KEY: "x" } }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
      (m) => logs.push(m),
      writeParams,
      writeZip,
      { telegram: vi.fn(async (): Promise<RegistrationOutcome> => "registered") },
    );
    expect(logs.join("\n")).toContain("2 secret(s): OPENAI_API_KEY, X_API_KEY");
  });

  it("POSTs the reserved probe path with the ingress secret BEFORE registration and proceeds on ok:true", async () => {
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string | URL, init?: RequestInit) => {
        requests.push({ url: String(u), body: String(init?.body) });
        return Response.json({ ok: true });
      }),
    );
    const logs: string[] = [];
    const registered: string[] = [];
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => {
      registered.push("telegram");
      return "registered";
    });
    const out = await deployAgentcoreRun(
      plan({
        channels: declaredChannels(["telegram"]),
        topology: FORWARDER,
        secrets: { FASTAGENT_INGRESS_SECRET: "s3cret" },
      }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
      (m) => logs.push(m),
      writeParams,
      writeZip,
      { telegram: tg },
    );
    expect(out).toMatchObject({ ok: true });
    // The reserved path (works on EVERY forwarder topology — a schedule-only URL 404s /health), with
    // the deploy's own credential in the body, never argv.
    expect(requests[0]?.url).toBe("https://xyz.lambda-url.us-west-2.on.aws/__fastagent/probe");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ auth: "s3cret" });
    // The probe ran BEFORE the registrar: registration verifies the URL, so the container must
    // already be restored + constructed when the platform's challenge arrives.
    expect(logs.findIndex((l) => l.includes("probing"))).toBeLessThan(
      logs.findIndex((l) => l.includes("registering telegram")),
    );
    expect(registered).toEqual(["telegram"]);
  });

  it("gates IMMEDIATELY with the runtime's OWN error text on an ok:false verdict", async () => {
    // The verdict rides a transport-200 structured reply (channels/agentcore.ts) precisely because
    // the forwarder rewrites non-200 transports into an opaque 502 — and construction rejections are
    // cached per session, so polling cannot change the answer: one round trip, one gate.
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: false, error: "channel construction failed: FEISHU_APP_SECRET is not set" }),
    );
    const out = await deployAgentcoreRun(
      plan({ topology: FORWARDER }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
      () => {},
      writeParams,
      writeZip,
      { telegram: async () => "registered", feishu: undefined, slack: undefined },
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5_000, intervalMs: 1_000 },
    );
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("FEISHU_APP_SECRET is not set") });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // deterministic — no pointless polling
  });

  it("retries a non-200 forwarder answer to the deadline, then gates with the LAST answer", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden\n", { status: 403 }));
    const out = await deployAgentcoreRun(
      plan({ topology: FORWARDER }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
      () => {},
      writeParams,
      writeZip,
      { telegram: async () => "registered", feishu: undefined, slack: undefined },
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20, intervalMs: 1 },
    );
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("403 forbidden") });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it("a forwarder URL that never answers gates with the reachability message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const out = await deployAgentcoreRun(
      plan({ topology: FORWARDER }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
      () => {},
      writeParams,
      writeZip,
      { telegram: async () => "registered", feishu: undefined, slack: undefined },
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20, intervalMs: 1 },
    );
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("never answered") });
  });

  it("a forwarder topology whose stack LOST the ForwarderUrl output gates — even with no channels", async () => {
    // schedule-only / selfSchedule-only: a forwarder topology without first-party channels. The probe is
    // their ONLY construction check, so a missing URL must be a gate, not a silent skip + success.
    const probe = vi.fn();
    vi.stubGlobal("fetch", probe);
    const { cli: aws } = fakeCli((a) =>
      a[0] === "cloudformation" && a[1] === "describe-stacks"
        ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
        : happyAws(a),
    );
    const out = await run(plan({ topology: FORWARDER }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("ForwarderUrl") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("a pure-invoke deployment (no forwarder) legitimately has no URL and skips the probe", async () => {
    const probe = vi.fn();
    vi.stubGlobal("fetch", probe);
    const { cli: aws } = fakeCli((a) =>
      a[0] === "cloudformation" && a[1] === "describe-stacks"
        ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
        : happyAws(a),
    );
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true });
    expect(probe).not.toHaveBeenCalled();
  });
});
