/**
 * The built-in `wake` tool: the agent's self-scheduling surface. Calling it records a one-shot wake-up
 * (wakeups.ts); the scheduler fires it back into the SAME session, so the agent resumes THIS
 * conversation after a delay ("check the deploy in 10 minutes"). The session comes from the turn
 * context (ToolContext.session, set around the harness turn); the state root is closed over at build
 * time (where it is known — the workspace opener), never read from the turn.
 *
 * Mounted by the opener ONLY when `config.selfSchedule` is on AND on the serving path (`dev`/`start`, where
 * the scheduler poller honors a wake-up) — never on the one-shot `invoke`/`fire` (they exit and never poll).
 * To opt OUT: leave `selfSchedule` off (the default), or override the built-in by defining your own
 * `tools/wake.ts` (a same-name collision wins — see {@link withWakeTool}). There is no name-based tool
 * exclusion config today.
 */
import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { addWakeup } from "../../schedule/wakeups.ts";
import { defineTool } from "./tool.ts";

/**
 * Parse a delay to milliseconds: a number is SECONDS; a string MUST carry a unit — `"<n><s|m|h|d>"`
 * ("30m", "2h", "1d"). Undefined for anything else, INCLUDING a bare numeric string like "120": one
 * encoding, one scale. Deliberate — an LLM freely emits a number OR a numeral-string, so letting a
 * unitless string alias to a different unit than a number (120s vs 120min, 60x apart) is a silent
 * footgun the guardrail (min 60s) would mask. A rejected value comes back to the model to fix.
 */
export function parseDelayMs(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input * 1000 : undefined;
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i); // unit REQUIRED on a string
  if (!m) return undefined;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] as string).toLowerCase() as "s"];
  return Number(m[1]) * mult;
}

/**
 * Append the built-in `wake` tool to `tools` — but only when `enabled` (the serving path, where the
 * scheduler poller honors a wake-up) and only when the workspace hasn't defined its own `wake` (that
 * wins, like any tool collision). The single place the mount decision + collision rule run.
 */
export function withWakeTool(tools: AgentTool[], stateRoot: string, enabled: boolean): AgentTool[] {
  if (!enabled || tools.some((t) => t.name === "wake")) return tools;
  return [...tools, makeWakeTool(stateRoot)];
}

/** Build the `wake` tool bound to `stateRoot` (where wake-ups persist). */
export function makeWakeTool(stateRoot: string, now: () => Date = () => new Date()): AgentTool {
  return defineTool({
    name: "wake",
    description:
      "Schedule yourself to wake up later and continue in THIS conversation. Use it to resume a task " +
      "after a delay (e.g. check on something in 10 minutes). `in` is a duration string WITH a unit " +
      '("30m", "2h", "1d"), or a number of seconds. When the time comes, a new turn runs in this same ' +
      "session with `prompt` as its instruction — you keep the full context of this conversation. " +
      "IMPORTANT: the woken turn's plain reply is NOT delivered to anyone — to reach the user it must call " +
      "a delivery tool (e.g. a channel's send tool), exactly as a scheduled job would.",
    input: z.object({
      in: z
        .union([z.string(), z.number()])
        .describe('delay until wake: a duration string with a unit ("30m" / "2h" / "1d"), or a number of seconds'),
      prompt: z.string().min(1).describe("the instruction for the woken turn (runs in this same conversation)"),
    }),
    execute(input, ctx) {
      if (!ctx.session) return "wake is only available inside a conversation (there is no session to resume).";
      const ms = parseDelayMs(input.in);
      if (ms === undefined) {
        return `couldn't parse "in" (${JSON.stringify(input.in)}) — use a unit like "30m" / "2h" / "1d", or a number of seconds (a bare number as text like "120" is rejected).`;
      }
      const at = new Date(now().getTime() + ms);
      const r = addWakeup(stateRoot, { session: ctx.session, prompt: input.prompt, fireAt: at }, now());
      if (!r.ok) return r.error; // guardrail message the model can act on
      return `OK — I'll wake up at ${r.fireAt} to: ${input.prompt}`;
    },
  });
}
