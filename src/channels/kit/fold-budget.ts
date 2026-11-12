/**
 * How much discussion a turn may fold into its message, and the fit of it: the budget a model's own context window
 * sets, in characters, and the newest-first cut with its notice.
 *
 * A fixed character count says nothing about the model that reads it: it is too much for a small window and a
 * thousand times too little for a large one. What bounds what a prompt may carry is the window, so the share a fold may
 * take is a share of that. The share and the characters a token stands for are judgements, not measurements; they sit
 * here so changing them is one edit, and so that a place's own bounds (a platform read's page, a line's length) stay the
 * tighter ones where they are.
 */
import type { Agent } from "../../agent-api.ts";
import { log } from "../../log.ts";

/** The part of a model's window one turn's folded discussion may take. */
const FOLD_SHARE = 0.1;
/**
 * Characters one token stands for, taken low: English runs near 4, Chinese near 1 to 2, and a budget that overstates the
 * tokens it spends is the safe side.
 */
const CHARS_PER_TOKEN = 2;
/** The window of a model that declares none, in tokens, and so what its budget is worked out from. */
const UNKNOWN_WINDOW_TOKENS = 128_000;

const budgetOfWindow = (windowTokens: number): number => Math.floor(windowTokens * FOLD_SHARE * CHARS_PER_TOKEN);

const unknownSaid = new Set<string>();

/**
 * The characters a turn in `sessionId` (none yet: a new conversation) may fold: the model the session names, or the
 * agent's default, and its window. Never rejects, as the discussion it serves never does: what the agent cannot say is
 * said in the log, and the budget of an unknown window is used.
 */
export async function foldBudget(
  agent: Pick<Agent, "info" | "sessions">,
  sessionId: string | undefined,
): Promise<number> {
  try {
    const [info, session] = await Promise.all([
      agent.info(),
      sessionId === undefined ? undefined : agent.sessions.get(sessionId),
    ]);
    const named = session?.model ?? info.defaultModel;
    const window =
      named && info.models.find((m) => m.provider === named.provider && m.modelId === named.modelId)?.contextWindow;
    if (window !== undefined) return budgetOfWindow(window);
    const which = named ? `${named.provider}/${named.modelId}` : "the agent's default";
    if (!unknownSaid.has(which)) {
      unknownSaid.add(which);
      log.warn(
        `[fastagent] no context window is known for ${which}: a turn folds discussion as for ${UNKNOWN_WINDOW_TOKENS} tokens`,
      );
    }
  } catch (error) {
    log.warn(
      `[fastagent] could not tell the model's context window; a turn folds discussion as for ${UNKNOWN_WINDOW_TOKENS} tokens: ${String(error)}`,
    );
  }
  return budgetOfWindow(UNKNOWN_WINDOW_TOKENS);
}

/**
 * Render `items` (oldest first) newest-first into `budget` characters, so what is closest to the ask is what is kept. What
 * the budget leaves out, and what a read never reached (`earlier`), is said in a line, never dropped silently.
 */
export function fitToBudget<T>(
  items: readonly T[],
  render: (item: T) => string,
  budget: number,
  earlier: boolean,
): { text: string; folded: T[] } {
  const lines: string[] = [];
  const folded: T[] = [];
  let used = 0;
  let cut = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T;
    const rendered = render(item);
    if (cut > 0 || used + rendered.length + 1 > budget) {
      cut++;
      continue;
    }
    used += rendered.length + 1;
    lines.unshift(rendered);
    folded.unshift(item);
  }
  if (cut > 0 || earlier) {
    lines.unshift(
      cut > 0
        ? `(${cut}${earlier ? "+" : ""} earlier message${cut === 1 && !earlier ? "" : "s"} here not shown)`
        : "(earlier messages here not shown)",
    );
  }
  return { text: folded.length > 0 || cut > 0 ? lines.join("\n") : "", folded };
}
