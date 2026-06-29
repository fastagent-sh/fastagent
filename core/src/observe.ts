/**
 * Dev observability (dev, not start): wrap an Agent to trace each turn's loop to the log — prompt,
 * reasoning, tool calls (name + args) with results, reply, terminal event. Pass-through: events are
 * forwarded untouched; this only tees a readable line per step. Engine-neutral (the contract only).
 */
import type { Agent, AgentEvent, Json, Prompt, Scope } from "./agent.ts";

// ── DESIGN GAP (logging): this module's `dev`-only gating is a stopgap, not the design ──────────────
//
// The real, unaddressed problem is bigger than this one trace and bigger than the think/tool question:
// fastagent has no logging LEVELS and no per-environment/per-scenario log CONFIG. Today every line —
// lifecycle (`[fastagent] …`, `[telegram] turn …`), warnings (`[fastagent] warn: …`), and this turn
// trace — is written straight to `console.error` at one implicit severity, with no level, no
// env/scenario gating, no structured sink, and no redaction of end-user content. So a downstream log
// collector cannot tell an operational warning from a debug trace from a real error, and the only knob
// we have is the crude one used here: wire the trace into `dev` and omit it from `start`.
//
// That crude knob has two costs. (1) It is all-or-nothing and hardcoded: production gets NO step-level
// visibility (only coarse turn start/done/failed), exactly when a misbehaving live bot most needs it,
// and dev cannot quiet it. (2) The reason it must stay off in `start` is itself a logging-design
// failure: this trace logs CONTENT — the user's prompt, tool args, tool results, the reply — so
// enabling it in production would spray end-user data (and high volume) into operator logs.
//
// The right shape is leveled logging (debug/info/warn/error) configured by environment/scenario, not
// by call site: dev → verbose, human-readable, content allowed; production → level-gated + structured
// + end-user content redacted/sampled. Then this trace becomes a debug-level emitter that BOTH `dev`
// and `start` route through their configured sink, instead of a switch soldered to the command path.
// Until that layer exists, `logAgentLoop` stays dev-only on purpose — to keep user content out of
// production logs — and this comment marks the debt so the next change does not mistake the stopgap
// for the intent.

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
