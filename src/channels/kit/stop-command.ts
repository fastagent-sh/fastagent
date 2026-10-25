/**
 * SHARED user-facing stop command: the chat channels (telegram, feishu/lark, slack) map an explicit "stop" ask onto
 * the session's `abort`.
 */
import { log } from "../../log.ts";
import type { Agent } from "../../agent-api.ts";

/** Bare stop word for summon-body matching (Slack/Feishu); Telegram uses its native `/stop` command. */
export function isStopText(text: string): boolean {
  return /^(stop|cancel)[.!]?$/i.test(text.trim());
}

const STOPPED_NOTICE = "⏹ Stopped.";
const NOTHING_RUNNING_NOTICE = "Nothing is running.";

/**
 * Dispatch `abort` for the place's session (none: nothing was ever said there) and map the outcome to the
 * customer-facing line. `abort` waits until what it stopped has ended, so a caller must not await this on the path
 * that acknowledges its platform's webhook.
 */
export async function dispatchStop(agent: Agent, sessionId: string | undefined, label: string): Promise<string> {
  if (sessionId === undefined) return NOTHING_RUNNING_NOTICE;
  const result = await agent.abort(sessionId);
  if (result.ok) {
    const { taken, queued } = result.stopped;
    return taken.length > 0 || queued.length > 0 ? STOPPED_NOTICE : NOTHING_RUNNING_NOTICE;
  }
  if ("unknown" in result) {
    log.warn(`${label} stop for ${sessionId} did not answer: ${result.unknown.reason}`);
    return "⚠️ Could not tell whether it stopped — check again in a moment.";
  }
  if (result.error.code === "not_found") return NOTHING_RUNNING_NOTICE;
  log.warn(`${label} stop rejected for ${sessionId}: ${result.error.code} — ${result.error.message}`);
  return `⚠️ Could not stop (${result.error.code}).`;
}
