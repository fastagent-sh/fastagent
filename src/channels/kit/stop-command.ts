/**
 * SHARED user-facing stop command: the chat channels (telegram, feishu/lark, slack) map an explicit "stop" ask onto
 * the session control plane's `abort`.
 */
import { log } from "../../log.ts";
import { NO_ACTIVE_RUN_CODE, type SessionControl } from "../../session.ts";

/** Bare stop word for summon-body matching (Slack/Feishu); Telegram uses its native `/stop` command. */
export function isStopText(text: string): boolean {
  return /^(stop|cancel)[.!]?$/i.test(text.trim());
}

const STOPPED_NOTICE = "⏹ Stopped.";
const NOTHING_RUNNING_NOTICE = "Nothing is running.";
const STOP_UNAVAILABLE_NOTICE =
  "⚠️ Stop isn't enabled on this deployment (set sessionControl: true in fastagent.config).";

/** Dispatch `abort` for the session and map the outcome to the customer-facing line. */
export async function dispatchStop(
  control: SessionControl | undefined,
  session: string,
  label: string,
): Promise<string> {
  if (!control) return STOP_UNAVAILABLE_NOTICE;
  try {
    const result = await control.sessions.get(session).abort();
    if (result.ok) return STOPPED_NOTICE;
    if (result.error.code === NO_ACTIVE_RUN_CODE) return NOTHING_RUNNING_NOTICE;
    log.warn(`${label} stop rejected for ${session}: ${result.error.code} — ${result.error.message}`);
    return `⚠️ Could not stop (${result.error.code}).`;
  } catch (error) {
    log.warn(`${label} stop failed for ${session}: ${String(error)}`);
    return "⚠️ Could not stop — see the server logs.";
  }
}
