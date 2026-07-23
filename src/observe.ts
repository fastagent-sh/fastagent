/**
 * The turn trace: wrap an Agent to tee each turn's loop — prompt, reasoning, tool calls (name + args)
 * with results, reply, terminal — to the log at DEBUG level. Pass-through: events are forwarded
 * untouched; this only adds a readable line per step. Engine-neutral (the contract only).
 *
 * It is wired in BOTH `dev` and `start`; the level decides visibility. dev runs at debug, so the trace
 * (including end-user content — prompt, tool args/results, reply) shows; start runs at info, so the
 * trace is gated out entirely, keeping that content and its volume out of production logs. That gating
 * is why the trace is debug-level rather than a switch soldered to the command path.
 */
import type { Agent, AgentEvent, Json, Prompt, Scope } from "./agent.ts";
import { log } from "./log.ts";

const PREVIEW = 200;

/** One line, whitespace-collapsed, truncated — a log stays scannable. */
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
}

const preview = (v: Json): string => oneLine(typeof v === "string" ? v : JSON.stringify(v));

export function logAgentLoop(agent: Agent, sink: (line: string) => void = (line) => log.debug(line)): Agent {
  return {
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      const s = scope.session;
      sink(`[agent] ▶ turn session=${s} ← ${oneLine(prompt.text)}`);
      const toolName = new Map<string, string>(); // tool_ended carries no name — remember it from tool_started
      let thinking = "";
      let reply = "";
      for await (const e of agent.invoke(scope, prompt)) {
        if (e.type === "text") {
          reply += e.delta;
        } else if (e.type === "thinking") {
          thinking += e.delta;
        } else if (e.type === "tool_started") {
          toolName.set(e.id, e.name);
          sink(`[agent]   tool → ${e.name}(${preview(e.args)})`);
        } else if (e.type === "tool_ended") {
          sink(`[agent]   tool ${e.isError ? "✗" : "✓"} ${toolName.get(e.id) ?? e.id} → ${preview(e.content)}`);
        } else if (e.type === "retrying") {
          sink(`[agent]   retrying (${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms): ${oneLine(e.reason)}`);
        } else if (e.type === "completed") {
          if (thinking.trim() !== "") sink(`[agent]   thinking: ${oneLine(thinking)}`);
          sink(`[agent]   reply: ${oneLine(reply) || "(empty)"}`);
          sink(`[agent] ■ completed session=${s}`);
        } else if (e.type === "failed") {
          sink(`[agent] ■ failed session=${s}: ${e.details} (retryable=${e.retryable})`);
        }
        yield e;
      }
    },
  };
}
