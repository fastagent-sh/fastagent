import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentcoreStorage } from "../../src/deploy/agentcore/plan.ts";

const exec = promisify(execFile);

export function storageStackName(name: string): string {
  if (!/^live-probe-[0-9a-f]{8}$/.test(name)) throw new Error(`invalid AgentCore probe name: ${name}`);
  return `fastagent-${name}-storage`;
}

/** A separate test-owned stack keeps every probe's files fresh and makes interrupted setup recoverable. */
export async function createAgentcoreStorage(
  name: string,
  network: Omit<AgentcoreStorage, "efsAccessPointArn">,
): Promise<AgentcoreStorage> {
  const stack = storageStackName(name);
  if (!network.subnetIds?.length || !network.securityGroupIds?.length) {
    throw new Error("AgentCore probe network requires subnetIds and securityGroupIds");
  }
  const { stdout } = await exec("aws", [
    "ec2",
    "describe-subnets",
    "--subnet-ids",
    ...network.subnetIds,
    "--output",
    "json",
  ]);
  const { Subnets: subnets } = JSON.parse(stdout) as { Subnets: { SubnetId: string; AvailabilityZoneId: string }[] };
  // EFS permits one mount target per Availability Zone, even when it contains several selected subnets.
  const targets = [...new Map(subnets.map((s) => [s.AvailabilityZoneId, s.SubnetId])).values()];
  const template = {
    Resources: {
      Filesystem: {
        Type: "AWS::EFS::FileSystem",
        Properties: { Encrypted: true, ThroughputMode: "elastic", BackupPolicy: { Status: "DISABLED" } },
      },
      AccessPoint: {
        Type: "AWS::EFS::AccessPoint",
        Properties: {
          FileSystemId: { Ref: "Filesystem" },
          PosixUser: { Uid: "0", Gid: "0" },
          RootDirectory: { Path: "/workspace", CreationInfo: { OwnerUid: "0", OwnerGid: "0", Permissions: "0700" } },
        },
      },
      ...Object.fromEntries(
        targets.map((subnet, index) => [
          `MountTarget${index}`,
          {
            Type: "AWS::EFS::MountTarget",
            Properties: {
              FileSystemId: { Ref: "Filesystem" },
              SubnetId: subnet,
              SecurityGroups: network.securityGroupIds,
            },
          },
        ]),
      ),
    },
    Outputs: { Arn: { Value: { "Fn::GetAtt": ["AccessPoint", "Arn"] } } },
  };
  const dir = await mkdtemp(join(tmpdir(), "fastagent-probe-storage-"));
  try {
    const file = join(dir, "template.json");
    await writeFile(file, JSON.stringify(template));
    await exec("aws", ["cloudformation", "deploy", "--stack-name", stack, "--template-file", file]);
    const result = await exec("aws", [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--query",
      "Stacks[0].Outputs[0].OutputValue",
      "--output",
      "json",
    ]);
    return { ...network, efsAccessPointArn: JSON.parse(result.stdout) as string };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
