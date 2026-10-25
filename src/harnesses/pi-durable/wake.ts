/**
 * `wake` and `unwake`: the agent schedules itself back into the conversation it is in, one-shot or recurring, kept in
 * the instance's state (schedule/wakeups.ts), which the scheduler fires. A pair over one store: a definition that
 * defines either name gets neither.
 */
import { Type } from "@earendil-works/pi-ai";
import { type Extension, type ToolExecutionResult, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { addWakeup, parseDelayMs, removeWakeup } from "../../schedule/wakeups.ts";
import { sessionIdOf } from "./ids.ts";

export const WAKE_EXTENSION = "fastagent.wake";
export const WAKE_TOOLS = ["wake", "unwake"];

const said = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });
const refused = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });
const NOT_A_SESSION =
  "wake-ups belong to a session, and this conversation is not one (a subagent's): nothing would wake it.";

export function wakeExtension(stateRoot: string, now: () => Date = () => new Date()): Extension {
  return defineExtension({
    name: WAKE_EXTENSION,
    tools: [
      defineTool({
        name: "wake",
        description:
          "Schedule yourself to wake up later and continue in THIS conversation. ONE-SHOT: pass `in`, a duration " +
          'string with a unit ("30m", "2h", "1d") or a number of seconds, to resume a task after a delay. RECURRING: ' +
          "pass `cron` (5-field, optional `tz`) to wake repeatedly; use it sparingly, and `unwake` with the returned " +
          "id when the job is done. Exactly one of `in`/`cron`. When the time comes, a new message arrives in this " +
          "same conversation with `prompt` as its instruction, tagged with the wake-up's id so you can tell it from a " +
          "user's, and you keep the full context of this conversation. Its plain reply is delivered to no one: to " +
          "reach a person it must call a delivery tool (a channel's send tool), as a scheduled job does.",
        parameters: Type.Object({
          in: Type.Optional(
            Type.Union([Type.String(), Type.Number()], {
              description:
                'one-shot delay: a duration string with a unit ("30m" / "2h" / "1d"), or a number of seconds',
            }),
          ),
          cron: Type.Optional(Type.String({ description: 'recurring: a 5-field cron expression (e.g. "0 9 * * *")' })),
          tz: Type.Optional(Type.String({ description: 'IANA timezone for `cron` (default "UTC")' })),
          prompt: Type.String({
            minLength: 1,
            description: "the instruction for the woken message (it arrives in this same conversation)",
          }),
        }),
        execute: async (args, api, context) => {
          if ((args.in === undefined) === (args.cron === undefined)) {
            return refused("pass exactly one of `in` (one-shot) or `cron` (recurring).");
          }
          const session = await sessionIdOf(api, context);
          if (session === undefined) return refused(NOT_A_SESSION);
          const at = now();
          if (args.cron !== undefined) {
            const added = addWakeup(stateRoot, { session, prompt: args.prompt, cron: args.cron, tz: args.tz }, at);
            if (!added.ok) return refused(added.error);
            return said(
              `OK — recurring wake ${added.id} (cron "${args.cron}"${args.tz ? ` ${args.tz}` : ""}), first at ${added.fireAt}: ${args.prompt}. Use unwake({ id: "${added.id}" }) to stop it.`,
            );
          }
          const ms = parseDelayMs(args.in as string | number);
          if (ms === undefined) {
            return refused(
              `couldn't parse "in" (${JSON.stringify(args.in)}): use a unit like "30m" / "2h" / "1d", or a number of seconds (a bare number as text like "120" is rejected).`,
            );
          }
          const added = addWakeup(stateRoot, { session, prompt: args.prompt, fireAt: new Date(at.getTime() + ms) }, at);
          if (!added.ok) return refused(added.error);
          return said(
            `OK — I'll wake up at ${added.fireAt} (id ${added.id}) to: ${args.prompt}. Use unwake({ id: "${added.id}" }) if it becomes unnecessary.`,
          );
        },
      }),
      defineTool({
        name: "unwake",
        description:
          "Cancel one of YOUR pending wake-ups (one-shot or recurring) by the id `wake` returned. Use it when a " +
          "scheduled follow-up is no longer needed, especially to stop a recurring wake once its job is done.",
        parameters: Type.Object({
          id: Type.String({ minLength: 1, description: "the wake-up id (returned by `wake`)" }),
        }),
        execute: async (args, api, context) => {
          const session = await sessionIdOf(api, context);
          if (session === undefined) return refused(NOT_A_SESSION);
          return removeWakeup(stateRoot, args.id, session)
            ? said(`OK — wake-up ${args.id} cancelled.`)
            : refused(`no pending wake-up ${args.id} in this conversation (already fired, or not yours).`);
        },
      }),
    ],
  });
}
