/**
 * The acknowledgement a turn waiting behind a running one puts on its asker's message: "OnIt" while it waits, "DONE"
 * when it is answered. Removing a reaction needs the id the platform gave it, so the mark keeps it.
 */
import { log } from "../../log.ts";
import { NO_ACK, type TurnAck } from "../kit/turn.ts";
import type { FeishuApi } from "./feishu-api.ts";

const WAITING = "OnIt";
const ANSWERED = "DONE";

/** Mark the asker's message now; every later step is best effort, since an acknowledgement must never fail its turn. */
export async function acknowledgeFeishuAsk(
  api: Pick<FeishuApi, "addReaction" | "deleteReaction">,
  messageId: string,
  label: string,
): Promise<TurnAck> {
  let reactionId: string | undefined;
  try {
    reactionId = await api.addReaction(messageId, WAITING);
  } catch (error) {
    log.warn(`${label} could not mark message ${messageId} as received: ${String(error)}`);
    return NO_ACK;
  }
  if (reactionId === undefined) {
    log.warn(`${label} the platform gave no id for the reaction on ${messageId}, so it cannot be taken back`);
  }
  const dropWaiting = async (): Promise<void> => {
    if (reactionId === undefined) return;
    const id = reactionId;
    reactionId = undefined;
    await api
      .deleteReaction(messageId, id)
      .catch((error) => log.warn(`${label} could not remove the waiting reaction on ${messageId}: ${String(error)}`));
  };
  return {
    complete: async () => {
      await dropWaiting();
      await api
        .addReaction(messageId, ANSWERED)
        .catch((error) => log.warn(`${label} could not add the done reaction on ${messageId}: ${String(error)}`));
    },
    remove: dropWaiting,
  };
}
