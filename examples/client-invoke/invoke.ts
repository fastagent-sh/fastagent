import { AgentError, connectAgent } from "@fastagent-sh/client";

const baseUrl = process.env.FASTAGENT_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.FASTAGENT_API_KEY;
if (!apiKey) {
  console.error("Set FASTAGENT_API_KEY (and optionally FASTAGENT_URL) before running.");
  process.exit(2);
}

const agent = connectAgent(baseUrl, { apiKey });

try {
  // 1. Single-call invoke with a caller-named conversation (great for cron, webhooks, scale-to-zero)
  const first = await agent.invoke(
    { conversation: "demo-customer-42", content: "Check order ORD-9231." },
    { wait: 120 },
  );
  console.log(`[invoke] status=${first.status} session=${first.sessionId}`);
  console.log(first.answer?.text ?? "(no answer)");

  // 2. Follow up in the exact same conversation while streaming live deltas
  console.log("\n[stream] follow-up:");
  for await (const event of agent.invokeStream({
    conversation: "demo-customer-42",
    content: "Am I eligible for a refund?",
  })) {
    if (event.type === "delta" && event.channel === "text") {
      process.stdout.write(event.text);
    }
    if (event.type === "done") {
      process.stdout.write(`\n[done] status=${event.message.status}\n`);
    }
  }
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`AgentError (${error.code}, retryable=${error.retryable}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
