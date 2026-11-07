import { describe, expect, it } from "vitest";
import { awsCli } from "../src/deploy/agentcore/aws-cli.ts";
import { RUNTIME_IDENTITY_ROLE, ensureServiceLinkedRole } from "../src/deploy/agentcore/slr.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

const NO_ROLE = {
  code: 254,
  stderr: "An error occurred (NoSuchEntity) when calling the GetRole operation: Role not found",
};
const TAKEN = {
  code: 254,
  stderr:
    "An error occurred (InvalidInput) when calling the CreateServiceLinkedRole operation: Service role name " +
    "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity has been taken in this account, please try a different suffix.",
};
const DENIED = {
  code: 254,
  stderr: "An error occurred (AccessDenied) when calling the CreateServiceLinkedRole operation: not authorized",
};
const CANNOT_READ = {
  code: 254,
  stderr: "An error occurred (AccessDenied) when calling the GetRole operation: not authorized to perform: iam:GetRole",
};

/** An `aws` that answers `iam get-role` and `iam create-service-linked-role` as scripted; every call is kept. */
function fakeIam(answers: { read: { code: number; stderr?: string }; create?: { code: number; stderr?: string } }) {
  const calls: string[] = [];
  const runner: CliRunner = async (args, opts) => {
    calls.push(args.join(" "));
    const reply = args[1] === "get-role" ? answers.read : (answers.create ?? { code: 0 });
    return { code: reply.code, stdout: "", stderr: opts?.captureStderr ? (reply.stderr ?? "") : undefined };
  };
  return { cli: awsCli(runner), calls };
}

const READ = "iam get-role --role-name AWSServiceRoleForBedrockAgentCoreRuntimeIdentity";
const CREATE = "iam create-service-linked-role --aws-service-name runtime-identity.bedrock-agentcore.amazonaws.com";

describe("ensureServiceLinkedRole: the role AgentCore's runtime needs, before the build", () => {
  it("a role that is there is left alone, and nothing is said or created", async () => {
    const { cli, calls } = fakeIam({ read: { code: 0 } });
    const logs: string[] = [];
    expect(await ensureServiceLinkedRole(cli, RUNTIME_IDENTITY_ROLE, (m) => logs.push(m))).toBeUndefined();
    expect(calls).toEqual([READ]);
    expect(logs).toEqual([]);
  });

  it("an absent role is created, once, and said", async () => {
    const { cli, calls } = fakeIam({ read: NO_ROLE });
    const logs: string[] = [];
    expect(await ensureServiceLinkedRole(cli, RUNTIME_IDENTITY_ROLE, (m) => logs.push(m))).toBeUndefined();
    expect(calls).toEqual([READ, CREATE]);
    expect(logs).toEqual(["creating the service-linked role AWSServiceRoleForBedrockAgentCoreRuntimeIdentity…"]);
  });

  it("an absent role that cannot be created stops the deploy, naming the command for someone who can", async () => {
    const { cli } = fakeIam({ read: NO_ROLE, create: DENIED });
    const gate = await ensureServiceLinkedRole(cli, RUNTIME_IDENTITY_ROLE, () => {});
    expect(gate).toContain("AWSServiceRoleForBedrockAgentCoreRuntimeIdentity");
    expect(gate).toContain("AccessDenied");
    expect(gate).toContain(`\`aws ${CREATE}\``);
    expect(gate).toContain("iam:CreateServiceLinkedRole");
    expect(gate).not.toMatch(/\n/);
  });

  it("a role another deploy made in between is there, which is all that is wanted", async () => {
    // The answer is real: IAM says the name is taken only after it has authorized the call.
    const { cli } = fakeIam({ read: NO_ROLE, create: TAKEN });
    expect(await ensureServiceLinkedRole(cli, RUNTIME_IDENTITY_ROLE, () => {})).toBeUndefined();
  });

  it("a read it may not make warns and goes on, and creates nothing: a deployer who cannot read is not refused", async () => {
    // Creating unconditionally instead would refuse a deployer without CreateServiceLinkedRole in every account where
    // the role has long existed, since IAM authorizes before it says the role is there.
    const { cli, calls } = fakeIam({ read: CANNOT_READ, create: DENIED });
    const logs: string[] = [];
    expect(await ensureServiceLinkedRole(cli, RUNTIME_IDENTITY_ROLE, (m) => logs.push(m))).toBeUndefined();
    expect(calls).toEqual([READ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("warn: could not check for the service-linked role");
    expect(logs[0]).toContain("iam:GetRole");
  });
});
