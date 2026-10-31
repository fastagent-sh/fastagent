/**
 * What becomes of a task pi-durable's crash-loop guard parked (`settings.restartLimit`: cut off by a crash that many
 * times in a row, with no progress between). Left parked, the message it was answering stays `running` for ever with
 * nothing to say why (SPEC.md §5.4 ends a message that cannot be answered `failed`). Parked is a state the task keeps,
 * which `inspect()` shows as blocked for `restart_limit`: it is read from there, and not from the one `task_parked`
 * report an open makes, so a process that dies half way, or a step that fails, is finished by the next open.
 */
import type { Context } from "@earendil-works/chord/context";
import { type Harness, LiveDoc } from "@earendil-works/pi-durable";
import { log } from "../../log.ts";

const RESTART_LIMIT_REASON = "restart_limit";
const DETAIL = "The process was cut off repeatedly while answering this message, so it was given up on";

/**
 * Settle the messages each parked task was answering `unanswered` for {@link RESTART_LIMIT_REASON}, and abort the task,
 * which frees its session. The settlement comes first: an abort alone settles them `aborted`, which reads as a
 * cancellation nobody asked for, and the first settlement of a submission stands (measured). Both steps can be run
 * again over their own result: the run stays until the abort's handler ends it, so a task left half way is found
 * parked, and finished, by the next open. A parked task that is not its conversation's run (a tool's, a compaction's)
 * is only aborted: the run goes on without it.
 */
export async function giveUpOnParked(harness: Harness, context: Context): Promise<void> {
  const parked = (await harness.inspect(context)).tasks.filter(
    ({ state }) => state.kind === "blocked" && state.reason === RESTART_LIMIT_REASON,
  );
  for (const { record } of parked) {
    await harness.commit(async (tx) => {
      const run = (await tx.doc(LiveDoc, record.conversationId))?.run;
      if (run?.taskId !== record.id) return;
      for (const id of run.inputs) {
        tx.settleSubmission(id, { status: "unanswered", reason: RESTART_LIMIT_REASON, detail: DETAIL });
      }
    }, context);
    await harness.abortTask(record.id, context);
    log.warn(
      `[fastagent] gave up on ${record.kind} task ${record.id} of conversation ${record.conversationId}: it was parked`,
    );
  }
}
