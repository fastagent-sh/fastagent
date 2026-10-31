/**
 * What becomes of a task pi-durable's crash-loop guard parked (`settings.restartLimit`: cut off by a crash that many
 * times in a row, with no progress between). Left parked, the message it was answering stays `running` for ever with
 * nothing to say why (SPEC.md §5.4 ends a message that cannot be answered `failed`). The guard reports it to `onReport`
 * while the Harness opens, so the tasks are collected there and given up on once it is open.
 */
import type { Context } from "@earendil-works/chord/context";
import { type Harness, LiveDoc, type ReportInfo } from "@earendil-works/pi-durable";
import { log } from "../../log.ts";

const RESTART_LIMIT_REASON = "restart_limit";
const DETAIL = "The process was cut off repeatedly while answering this message, so it was given up on";

type ParkedTask = Extract<ReportInfo, { type: "task_parked" }>["task"];

/** The parked tasks `onReport` is told of, in the order it is told. */
export function parkedTasks(): { report(info: ReportInfo): void; tasks: readonly ParkedTask[] } {
  const tasks: ParkedTask[] = [];
  return {
    tasks,
    report(info) {
      if (info.type === "task_parked") tasks.push(info.task);
    },
  };
}

/**
 * Settle the messages a parked task was answering `unanswered` for {@link RESTART_LIMIT_REASON}, and abort the task,
 * which frees its session. The settlement comes first: an abort alone settles them `aborted`, which reads as a
 * cancellation nobody asked for, and the first settlement of a submission stands (measured). A parked task that is not
 * its conversation's run (a tool's, a compaction's) is only aborted: the run goes on without it.
 */
export async function giveUpOnParked(harness: Harness, tasks: readonly ParkedTask[], context: Context): Promise<void> {
  for (const task of tasks) {
    await harness.commit(async (tx) => {
      const run = (await tx.doc(LiveDoc, task.conversationId))?.run;
      if (run?.taskId !== task.id) return;
      for (const id of run.inputs) {
        tx.settleSubmission(id, { status: "unanswered", reason: RESTART_LIMIT_REASON, detail: DETAIL });
      }
    }, context);
    await harness.abortTask(task.id, context);
    log.warn(
      `[fastagent] gave up on ${task.kind} task ${task.id} of conversation ${task.conversationId}: it was parked`,
    );
  }
}
