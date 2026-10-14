/**
 * SHARED user-facing stop command: the chat channels (telegram, feishu/lark, slack) map an explicit "stop" ask onto
 * the session's `abort`.
 */
import { log } from "../../log.ts";
import type { Agent } from "../../protocol.ts";

/** Bare stop word for summon-body matching (Slack/Feishu); Telegram uses its native `/stop` command. */
export function isStopText(text: string): boolean {
  return /^(stop|cancel)[.!]?$/i.test(text.trim());
}

const STOPPED_NOTICE = "⏹ Stopped.";
const NOTHING_RUNNING_NOTICE = "Nothing is running.";

/** Dispatch `abort` for the session and map the outcome to the customer-facing line. */
export async function dispatchStop(agent: Agent, session: string, label: string): Promise<string> {
  try {
    const result = await agent.sessions.get(session).abort();
    if (result.ok) {
      const { runId, queued, compaction } = result.stopped;
      return runId !== undefined || queued.length > 0 || compaction ? STOPPED_NOTICE : NOTHING_RUNNING_NOTICE;
    }
    // A session nothing has run in yet has nothing to stop.
    if (result.error.code === "not_found") return NOTHING_RUNNING_NOTICE;
    log.warn(`${label} stop rejected for ${session}: ${result.error.code} — ${result.error.message}`);
    return `⚠️ Could not stop (${result.error.code}).`;
  } catch (error) {
    log.warn(`${label} stop failed for ${session}: ${String(error)}`);
    return "⚠️ Could not stop — see the server logs.";
  }
}
