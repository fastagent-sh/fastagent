import { createHash } from "node:crypto";
import { AgentError, connectAgentCore, connectAgentCoreAuth } from "@fastagent-sh/client-agentcore";

/**
 * Call an AgentCore-deployed FastAgent from your backend using AWS IAM credentials (`InvokeAgentRuntime`).
 * Each end user maps deterministically to a valid AgentCore sessionId (33–256 chars), giving them
 * an isolated microVM and durable Aurora DSQL partition.
 */
function agentCoreSessionForUser(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  return `user-${hash}`;
}

const runtimeArn = process.env.FASTAGENT_AGENTCORE_ARN;
if (!runtimeArn) {
  console.error("Set FASTAGENT_AGENTCORE_ARN before running.");
  process.exit(2);
}

const userId = process.env.USER_ID ?? "user-42";
const connection = {
  runtimeArn,
  sessionId: agentCoreSessionForUser(userId),
  ...(process.env.AGENTCORE_QUALIFIER ? { qualifier: process.env.AGENTCORE_QUALIFIER } : {}),
};

const agent = connectAgentCore(connection);
const auth = connectAgentCoreAuth(connection);

try {
  const providers = await auth.providers();
  const ready = providers.filter((p) => p.authenticated).map((p) => p.provider);
  console.log(`[agentcore] user=${userId} instance=${connection.sessionId} readyProviders=${ready.join(",") || "none"}`);

  const reply = await agent.invoke(
    {
      conversation: "default",
      content: process.env.PROMPT ?? "Draft a short status brief with 2 highlights and 1 action item.",
    },
    { wait: 120 },
  );
  console.log(`[agentcore] status=${reply.status} session=${reply.sessionId}`);
  console.log(reply.answer?.text ?? "(no answer)");
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`AgentError (${error.code}, retryable=${error.retryable}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
