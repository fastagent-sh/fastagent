import { AgentError, connectAgent } from "@fastagent-sh/client";

/**
 * Trigger the `/daily-brief` prompt template from any external scheduler (GitHub Actions cron, Cloud Scheduler,
 * EventBridge, Railway Cron) using a single idempotent `POST /v1/invoke` call.
 */
const baseUrl = process.env.FASTAGENT_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.FASTAGENT_API_KEY;
if (!apiKey) {
  console.error("Set FASTAGENT_API_KEY (and optionally FASTAGENT_URL) before running.");
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const agent = connectAgent(baseUrl, { apiKey });

try {
  const msg = await agent.invoke(
    {
      conversation: "daily-brief",
      content: "/daily-brief",
      idempotencyKey: `daily-brief-${today}`,
      whenBusy: "reject",
    },
    { wait: 300 },
  );
  console.log(`[daily-brief] status=${msg.status} session=${msg.sessionId}`);
  console.log(msg.answer?.text ?? "(no answer)");
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`AgentError (${error.code}, retryable=${error.retryable}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
