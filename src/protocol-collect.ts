/**
 * The buffered consumer of an invoke stream (SPEC v1 §10): the run's answer, or a throw that says why there is none.
 */
import { AgentRejection, type InvokeEvent, type RunOutcome } from "./protocol.ts";

export interface CollectedRun {
  sessionId: string;
  runId: string;
  /** The run's last `assistant_message`; empty when it wrote none. */
  text: string;
}

/** A run that ended, but not `completed`: its outcome says how. */
export class RunNotCompleted extends Error {
  readonly outcome: Exclude<RunOutcome, { status: "completed" }>;
  readonly sessionId: string;
  readonly runId: string;
  constructor(outcome: Exclude<RunOutcome, { status: "completed" }>, at: { sessionId: string; runId: string }) {
    super(outcome.status === "failed" ? outcome.error.message : `the run ended ${outcome.status}`);
    this.name = "RunNotCompleted";
    this.outcome = outcome;
    this.sessionId = at.sessionId;
    this.runId = at.runId;
  }
}

/** A stream that stopped before its run ended: the process went away, or the connection to it did. */
export class RunUnfinished extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunUnfinished";
  }
}

export async function collect(events: AsyncIterable<InvokeEvent>): Promise<CollectedRun> {
  let receipt: { sessionId: string; runId: string } | undefined;
  let text = "";
  let lastError: string | undefined;
  for await (const event of events) {
    if (event.type === "rejected") throw new AgentRejection(event.error);
    if (event.type === "accepted") receipt = { sessionId: event.sessionId, runId: event.run.runId };
    if (event.type === "serving_error") lastError = event.message;
    if (event.type !== "entry" || receipt === undefined || event.entry.runId !== receipt.runId) continue;
    if (event.entry.kind === "assistant_message") text = String((event.entry.data as { text?: unknown }).text ?? "");
    if (event.entry.kind === "run_ended") {
      const { outcome } = event.entry.data as { outcome: RunOutcome };
      if (outcome.status !== "completed") throw new RunNotCompleted(outcome, receipt);
      return { ...receipt, text };
    }
  }
  throw new RunUnfinished(lastError ?? "the stream ended before its run did");
}
