/**
 * Dev observability (dev, not start): wrap an Agent to trace each turn's loop to the log — prompt,
 * reasoning, tool calls (name + args) with results, reply, terminal event. Pass-through: events are
 * forwarded untouched; this only tees a readable line per step. Engine-neutral (the contract only).
 */
import type { Agent, AgentEvent, Json, Prompt, Scope } from "./agent.ts";

const PREVIEW = 200;

/** One line, whitespace-collapsed, truncated — a log stays scannable. */
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
}

const preview = (v: Json): string => oneLine(typeof v === "string" ? v : JSON.stringify(v));

export function logAgentLoop(agent: Agent, log: (line: string) => void = (line) => console.error(line)): Agent {
  return {
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      const s = scope.session;
      log(`[agent] ▶ turn session=${s} ← ${oneLine(prompt.text)}`);
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
          log(`[agent]   tool → ${e.name}(${preview(e.args)})`);
        } else if (e.type === "tool_ended") {
          log(`[agent]   tool ${e.isError ? "✗" : "✓"} ${toolName.get(e.id) ?? e.id} → ${preview(e.content)}`);
        } else if (e.type === "completed") {
          if (thinking.trim() !== "") log(`[agent]   thinking: ${oneLine(thinking)}`);
          log(`[agent]   reply: ${oneLine(reply) || "(empty)"}`);
          log(`[agent] ■ completed session=${s}`);
        } else if (e.type === "failed") {
          log(`[agent] ■ failed session=${s}: ${e.details} (retryable=${e.retryable})`);
        }
        yield e;
      }
    },
  };
}
