/** Render one message's answer, as `messages.stream` delivers it, plus an exit code: 0 only for `completed`. */
import { AgentError, type Message, type MessageStreamEvent, errorData } from "../agent-api.ts";
import { answerText } from "../answer-text.ts";

/** A command that sends a message exits 0 only when it completed. */
export const exitCodeOf = (message: Pick<Message, "status">): number => (message.status === "completed" ? 0 : 1);

function failure(message: Message): string | undefined {
  const { status, error } = message;
  if (status === "completed") return undefined;
  if (error === undefined) return status;
  return `${error.code}: ${error.message}${error.retryable ? " (retryable)" : ""}`;
}

/**
 * Read `events` to their end with `read`, which answers an exit code once the message has ended; a send the agent
 * refused rejects the first read, and is said by `refused`.
 */
async function readMessage(
  events: AsyncIterable<MessageStreamEvent>,
  read: (event: MessageStreamEvent) => number | undefined,
  refused: (error: AgentError) => void,
): Promise<number | undefined> {
  try {
    for await (const event of events) {
      const exit = read(event);
      if (exit !== undefined) return exit;
    }
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    refused(error);
    return 1;
  }
  return undefined;
}

/** The answer as text on `out`, what the tools did and why it failed on `err`. */
export async function runInvokeStream(
  events: AsyncIterable<MessageStreamEvent>,
  out: (text: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const toolName = new Map<string, string>(); // a tool result carries the id; its name came with tool_started
  const textOf = answerText();
  const exit = await readMessage(
    events,
    (event) => {
      const text = event.type === "delta" || event.type === "entry" ? textOf(event) : "";
      if (text !== "") out(text);
      switch (event.type) {
        case "tool_started":
          toolName.set(event.toolCallId, event.name);
          err(`[tool] ${event.name}`);
          return undefined;
        case "tool_progress":
          err(`[tool] ${toolName.get(event.toolCallId) ?? event.toolCallId} › ${clipStatus(event.text)}`);
          return undefined;
        case "retrying":
          // Operator-facing: include the reason (channels show a neutral customer line instead).
          err(
            `[fastagent] transient failure — retrying (${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms): ${event.reason}`,
          );
          return undefined;
        case "stream_error":
          err(`[fastagent] ${event.error.message}`);
          return 1;
        case "entry": {
          const data = event.entry.data as { toolCallId?: string; isError?: boolean };
          if (event.entry.kind === "tool_result" && data.isError) {
            err(`[tool] ${toolName.get(data.toolCallId ?? "") ?? data.toolCallId} failed`);
          }
          return undefined;
        }
        case "done": {
          const failed = failure(event.message);
          if (failed !== undefined) err(`[fastagent] failed: ${failed}`);
          return exitCodeOf(event.message);
        }
        default:
          return undefined;
      }
    },
    (error) => err(`[fastagent] rejected: ${error.code}: ${error.message}`),
  );
  if (exit !== undefined) return exit;
  err("[fastagent] the stream ended before the message did");
  return 1;
}

/**
 * The answer as JSON lines, for a program to read: the message's events as `messages.stream` delivers them, its
 * `message` first, through its `done`. A message that ends no other way ends with the line that says why: `rejected`
 * when the agent refused it, a `stream_error` event, or `unfinished` when the events end first.
 */
export async function runInvokeJson(
  events: AsyncIterable<MessageStreamEvent>,
  line: (json: string) => void,
): Promise<number> {
  const exit = await readMessage(
    events,
    (event) => {
      line(JSON.stringify(event));
      if (event.type === "stream_error") return 1;
      return event.type === "done" ? exitCodeOf(event.message) : undefined;
    },
    (error) => line(JSON.stringify({ type: "rejected", error: errorData(error) })),
  );
  if (exit !== undefined) return exit;
  line(JSON.stringify({ type: "unfinished", reason: "the stream ended before the message did" }));
  return 1;
}

/** How much of a status line a terminal gets, in code points. */
const STATUS_MAX = 120;

/**
 * A `tool_progress` line clipped to {@link STATUS_MAX} code points. The event is untruncated by contract, and a shell
 * printing one long line (`curl -s` of a JSON body) re-sends that growing line every 100 ms.
 */
function clipStatus(text: string): string {
  // Only the first STATUS_MAX + 1 code points decide the result, and they fit in twice as many UTF-16 units.
  const head = [...text.slice(0, (STATUS_MAX + 1) * 2)];
  return head.length > STATUS_MAX ? `${head.slice(0, STATUS_MAX).join("")}…` : head.join("");
}
