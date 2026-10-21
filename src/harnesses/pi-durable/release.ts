/**
 * Temporary: pi-durable 1.3.0 leaves a conversation's queued messages waiting after a run that did not answer (a model
 * failure, an abort, a message sent while an aborted run was still ending) until another submission places them, while
 * the Agent API takes them whatever the message before them ended with (agent-api.md §3.2). A write of FastAgent's own
 * kind places them. Remove once pi-durable ships `afterFailedRun` and it covers aborts too.
 */
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { type PortFailure, port, portError } from "../../effect-port.ts";
import { log } from "../../log.ts";
import { RELEASE_ENTRY } from "./entries.ts";
import { queuedInputs } from "./messages.ts";

/** Release every conversation that waits now, and each one a run that did not answer leaves waiting, until the scope closes. */
export const releaseWaitingQueues = (
  harness: Harness,
  context: Context,
): Effect.Effect<void, PortFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const waiting = yield* Queue.unbounded<ConversationId>();
    const unsubscribe = harness.subscribeCommits(({ changes }) => {
      for (const change of changes) {
        const record = change.type === "submission" ? change.value : undefined;
        if (record?.type === "input" && record.status === "unanswered") {
          Queue.offerUnsafe(waiting, record.conversationId);
        }
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* Queue.take(waiting).pipe(
      Effect.flatMap((conversationId) =>
        release(harness, conversationId, context).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.error(
                `[fastagent] could not take the messages waiting in conversation ${conversationId}: ${String(portError(cause))}`,
              ),
            ),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const inspection = yield* port(() => harness.inspect(context));
    for (const record of inspection.submissions) {
      if (record.type === "input" && record.status === "queued") Queue.offerUnsafe(waiting, record.conversationId);
    }
  });

function release(harness: Harness, conversationId: ConversationId, context: Context) {
  return Effect.gen(function* () {
    const live = yield* port(() => harness.snapshot(LiveDoc, conversationId, context));
    if (live?.run !== undefined) return;
    const inbox = yield* port(() => harness.snapshot(InboxDoc, conversationId, context));
    if (queuedInputs(inbox).length === 0) return;
    const conversation = yield* port(() => harness.conversation(conversationId, context));
    if (conversation === undefined) return;
    yield* port(() => conversation.submit({ type: "write", entry: { kind: RELEASE_ENTRY, edits: [] } }, context));
  });
}
