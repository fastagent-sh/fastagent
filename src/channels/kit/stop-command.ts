/**
 * SHARED user-facing stop command: the chat channels (telegram, feishu/lark, slack) map an explicit "stop" ask onto
 * the session's `cancel`.
 */
import { log } from "../../log.ts";
import { type Agent, AgentError } from "../../agent-api.ts";

/** Bare stop word for summon-body matching (Slack/Feishu); Telegram uses its native `/stop` command. */
export function isStopText(text: string): boolean {
  return /^(stop|cancel)[.!]?$/i.test(text.trim());
}

const STOPPED_NOTICE = "⏹ Stopped.";
const NOTHING_RUNNING_NOTICE = "Nothing is running.";

/**
 * Dispatch `cancel` for the place's session (none: nothing was ever said there) and map its answer to the
 * customer-facing line: the asker is told, and the failure goes to the log.
 */
export async function dispatchStop(
  agent: Pick<Agent, "sessions">,
  sessionId: string | undefined,
  label: string,
): Promise<string> {
  if (sessionId === undefined) return NOTHING_RUNNING_NOTICE;
  try {
    const { stopped } = await agent.sessions.cancel(sessionId);
    return stopped.length > 0 ? STOPPED_NOTICE : NOTHING_RUNNING_NOTICE;
  } catch (error) {
    if (error instanceof AgentError && error.code === "not_found") return NOTHING_RUNNING_NOTICE;
    const code = error instanceof AgentError ? error.code : "internal";
    log.warn(
      `${label} stop failed for ${sessionId}: ${code} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return `⚠️ Could not stop (${code}).`;
  }
}
