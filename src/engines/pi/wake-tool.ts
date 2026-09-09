/** The built-in `wake` tool: the agent's self-scheduling surface. */
import { z } from "zod";
import { addWakeup, removeWakeup } from "../../schedule/wakeups.ts";
import { defineTool, type MountedTool } from "./tool.ts";

/**
 * Parse a delay to milliseconds: a number is SECONDS; a string MUST carry a unit — `"<n><s|m|h|d>"` ("30m", "2h",
 * "1d").
 */
export function parseDelayMs(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input * 1000 : undefined;
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i); // unit REQUIRED on a string
  if (!m) return undefined;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] as string).toLowerCase() as "s"];
  return Number(m[1]) * mult;
}

export function withWakeTool(tools: MountedTool[], stateRoot: string, enabled: boolean): MountedTool[] {
  if (!enabled) return tools;
  // wake/unwake are a PAIR over one store: if the workspace defines EITHER name, mount NEITHER built-in.
  if (tools.some((t) => t.name === "wake" || t.name === "unwake")) return tools;
  return [...tools, makeWakeTool(stateRoot), makeUnwakeTool(stateRoot)];
}

/** Build the `wake` tool bound to `stateRoot` (where wake-ups persist). */
export function makeWakeTool(stateRoot: string, now: () => Date = () => new Date()): MountedTool {
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
      const session = ctx.sessionManager?.getSessionId();
      if (!session) return "wake is only available inside a conversation (there is no session to resume).";
      if ((input.in === undefined) === (input.cron === undefined)) {
        return "pass exactly one of `in` (one-shot) or `cron` (recurring).";
      }
      if (input.cron !== undefined) {
        // addWakeup validates the cron and DERIVES the first instant itself — one computation, one truth.
        const r = addWakeup(stateRoot, { session, prompt: input.prompt, cron: input.cron, tz: input.tz }, now());
        if (!r.ok) return r.error; // guardrail message the model can act on
        return `OK — recurring wake ${r.id} (cron "${input.cron}"${input.tz ? ` ${input.tz}` : ""}), first at ${r.fireAt}: ${input.prompt}. Use unwake({ id: "${r.id}" }) to stop it.`;
      }
      const ms = parseDelayMs(input.in as string | number);
      if (ms === undefined) {
        return `couldn't parse "in" (${JSON.stringify(input.in)}) — use a unit like "30m" / "2h" / "1d", or a number of seconds (a bare number as text like "120" is rejected).`;
      }
      const at = new Date(now().getTime() + ms);
      const r = addWakeup(stateRoot, { session, prompt: input.prompt, fireAt: at }, now());
      if (!r.ok) return r.error; // guardrail message the model can act on
      return `OK — I'll wake up at ${r.fireAt} (id ${r.id}) to: ${input.prompt}. Use unwake({ id: "${r.id}" }) if it becomes unnecessary.`;
    },
  });
}

/**
 * Build the `unwake` tool: cancel one of THIS conversation's pending wake-ups by id (a wake/recurring that is no
 * longer needed).
 */
function makeUnwakeTool(stateRoot: string): MountedTool {
  return defineTool({
    name: "unwake",
    description:
      "Cancel one of YOUR pending wake-ups (one-shot or recurring) by the id `wake` returned. Use it when " +
      "a scheduled follow-up is no longer needed — especially to stop a recurring wake once its job is done.",
    input: z.object({ id: z.string().min(1).describe("the wake-up id (returned by `wake`)") }),
    execute(input, ctx) {
      const session = ctx.sessionManager?.getSessionId();
      if (!session) return "unwake is only available inside a conversation.";
      return removeWakeup(stateRoot, input.id, session)
        ? `OK — wake-up ${input.id} cancelled.`
        : `no pending wake-up ${input.id} in this conversation (already fired, or not yours).`;
    },
  });
}
