import { AgentError, connectAgent } from "@fastagent-sh/client";

/**
 * Example alert-webhook forwarder (e.g. from PagerDuty, Sentry, or Datadog) calling FastAgent over `POST /v1/invoke`:
 * - `conversation` keeps every alert update for the same incident in one durable thread.
 * - `idempotencyKey` deduplicates webhook retries / alert storms.
 * - `whenBusy: "steer"` injects new alert evidence into an active investigation without waiting.
 */
const baseUrl = process.env.FASTAGENT_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.FASTAGENT_API_KEY;
if (!apiKey) {
  console.error("Set FASTAGENT_API_KEY (and optionally FASTAGENT_URL) before running.");
  process.exit(2);
}

const incidentId = process.env.INCIDENT_ID ?? "inc-2026-0415";
const alertEventId = process.env.ALERT_EVENT_ID ?? `${incidentId}-evt-1`;
const alertSummary =
  process.env.ALERT_SUMMARY ??
  "5xx error rate spiked on https://fastagent.sh — probe the endpoint and inspect recent commits in fastagent-sh/fastagent.";

const agent = connectAgent(baseUrl, { apiKey });

try {
  const result = await agent.invoke(
    {
      conversation: `incident:${incidentId}`,
      idempotencyKey: alertEventId,
      whenBusy: "steer",
      content: `Alert ${alertEventId} for incident ${incidentId}:\n${alertSummary}`,
      metadata: { incidentId, alertEventId },
    },
    { wait: 300 },
  );
  console.log(`[triage] status=${result.status} session=${result.sessionId}`);
  console.log(result.answer?.text ?? "(no answer)");
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`AgentError (${error.code}, retryable=${error.retryable}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
