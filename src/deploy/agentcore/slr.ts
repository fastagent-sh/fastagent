/**
 * The service-linked role AgentCore's runtime needs in the account, checked before a deploy builds anything. Without it
 * CloudFormation fails at the runtime, minutes after the image push, with a bare `AccessDenied` that names nothing.
 *
 * Read first, create only when it is absent: IAM authorizes `CreateServiceLinkedRole` before it says a role already
 * exists, so creating unconditionally would refuse a deployer who lacks that permission in every account where the role
 * is long since there. A read that cannot be answered warns and goes on, as the region probe does.
 */
import type { AwsCli } from "./aws-cli.ts";

export interface ServiceLinkedRole {
  /** The service principal the role is created for. */
  service: string;
  /** The role's name, which is what `iam get-role` takes. */
  name: string;
}

export const RUNTIME_IDENTITY_ROLE: ServiceLinkedRole = {
  service: "runtime-identity.bedrock-agentcore.amazonaws.com",
  name: "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity",
};

/** A gate line when the role is absent and cannot be made, else undefined. */
export async function ensureServiceLinkedRole(
  cli: AwsCli,
  role: ServiceLinkedRole,
  log: (message: string) => void,
): Promise<string | undefined> {
  const found = await cli.present(["iam", "get-role", "--role-name", role.name]);
  if ("ok" in found) return undefined;
  if ("unreadable" in found) {
    log(
      `warn: could not check for the service-linked role ${role.name} (${found.unreadable.split("\n")[0]}) — if the ` +
        `account has never used AgentCore and this principal may not create it, cloudformation deploy fails at the ` +
        `runtime, after the image build`,
    );
    return undefined;
  }
  log(`creating the service-linked role ${role.name}…`);
  const created = await cli.write(["iam", "create-service-linked-role", "--aws-service-name", role.service]);
  if ("done" in created) return undefined;
  // Made by another deploy between the read and the write: it is there, which is all that is wanted.
  if ("refused" in created && /has been taken/i.test(created.refused)) return undefined;
  const why = "refused" in created ? created.refused : "it was not found";
  return (
    `the service-linked role ${role.name} that AgentCore's runtime needs does not exist in this account, and it could ` +
    `not be created (${why}) — have someone with iam:CreateServiceLinkedRole run ` +
    `\`aws iam create-service-linked-role --aws-service-name ${role.service}\`, then re-run`
  );
}
