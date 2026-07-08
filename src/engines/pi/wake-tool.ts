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
import { addWakeup, removeWakeup } from "../../schedule/wakeups.ts";
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
  if (!enabled) return tools;
  // wake/unwake are a PAIR over one store: if the workspace defines EITHER name, mount NEITHER built-in.
  // Mixing halves would mislead — an author's wake doesn't write our wakeups store, so our unwake could
  // never cancel what it returns ("not yours" forever); the author owns the whole concept or none of it.
  if (tools.some((t) => t.name === "wake" || t.name === "unwake")) return tools;
  return [...tools, makeWakeTool(stateRoot), makeUnwakeTool(stateRoot)];
}

/** Build the `wake` tool bound to `stateRoot` (where wake-ups persist). */
export function makeWakeTool(stateRoot: string, now: () => Date = () => new Date()): AgentTool {
  return defineTool({
    name: "wake",
    description:
      "Schedule yourself to wake up later and continue in THIS conversation. ONE-SHOT: pass `in` — a " +
      'duration string with a unit ("30m", "2h", "1d") or a number of seconds — to resume a task after a ' +
      "delay. RECURRING: pass `cron` (5-field, optional `tz`) to wake repeatedly — use sparingly, and " +
      "`unwake` with the returned id when the job is done. Exactly one of `in`/`cron`. When the time " +
      "comes, a new turn runs in this same session with `prompt` as its instruction (tagged with the wake-up's " +
      "id so you can tell it from a user message) — you keep the full context of this conversation. IMPORTANT: the woken turn's plain reply is NOT delivered to anyone — " +
      "to reach the user it must call a delivery tool (e.g. a channel's send tool), exactly as a scheduled " +
      "job would.",
    input: z.object({
      in: z
        .union([z.string(), z.number()])
        .optional()
        .describe('one-shot delay: a duration string with a unit ("30m" / "2h" / "1d"), or a number of seconds'),
      cron: z.string().optional().describe('recurring: a 5-field cron expression (e.g. "0 9 * * *")'),
      tz: z.string().optional().describe('IANA timezone for `cron` (default "UTC")'),
      prompt: z.string().min(1).describe("the instruction for the woken turn (runs in this same conversation)"),
    }),
    execute(input, ctx) {
      if (!ctx.session) return "wake is only available inside a conversation (there is no session to resume).";
      if ((input.in === undefined) === (input.cron === undefined)) {
        return "pass exactly one of `in` (one-shot) or `cron` (recurring).";
      }
      if (input.cron !== undefined) {
        // addWakeup validates the cron and DERIVES the first instant itself — one computation, one truth.
        const r = addWakeup(
          stateRoot,
          { session: ctx.session, prompt: input.prompt, cron: input.cron, tz: input.tz },
          now(),
        );
        if (!r.ok) return r.error; // guardrail message the model can act on
        return `OK — recurring wake ${r.id} (cron "${input.cron}"${input.tz ? ` ${input.tz}` : ""}), first at ${r.fireAt}: ${input.prompt}. Use unwake({ id: "${r.id}" }) to stop it.`;
      }
      const ms = parseDelayMs(input.in as string | number);
      if (ms === undefined) {
        return `couldn't parse "in" (${JSON.stringify(input.in)}) — use a unit like "30m" / "2h" / "1d", or a number of seconds (a bare number as text like "120" is rejected).`;
      }
      const at = new Date(now().getTime() + ms);
      const r = addWakeup(stateRoot, { session: ctx.session, prompt: input.prompt, fireAt: at }, now());
      if (!r.ok) return r.error; // guardrail message the model can act on
      return `OK — I'll wake up at ${r.fireAt} (id ${r.id}) to: ${input.prompt}. Use unwake({ id: "${r.id}" }) if it becomes unnecessary.`;
    },
  });
}

/** Build the `unwake` tool: cancel one of THIS conversation's pending wake-ups by id (a wake/recurring
 *  that is no longer needed). Session-scoped — a conversation can never cancel another's. */
export function makeUnwakeTool(stateRoot: string): AgentTool {
  return defineTool({
    name: "unwake",
    description:
      "Cancel one of YOUR pending wake-ups (one-shot or recurring) by the id `wake` returned. Use it when " +
      "a scheduled follow-up is no longer needed — especially to stop a recurring wake once its job is done.",
    input: z.object({ id: z.string().min(1).describe("the wake-up id (returned by `wake`)") }),
    execute(input, ctx) {
      if (!ctx.session) return "unwake is only available inside a conversation.";
      return removeWakeup(stateRoot, input.id, ctx.session)
        ? `OK — wake-up ${input.id} cancelled.`
        : `no pending wake-up ${input.id} in this conversation (already fired, or not yours).`;
    },
  });
}
