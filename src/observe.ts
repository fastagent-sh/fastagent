/**
 * The message trace: wrap an Agent to tee each invoke — prompt, reasoning, tool calls (name + args) with results, reply,
 * outcome — to the log at DEBUG level. Everything but `invoke` passes through.
 */
import { log } from "./log.ts";
import type { Agent, InvokeEvent, InvokeRequest, Json, Outcome } from "./protocol.ts";

const PREVIEW = 200;

/** One line, whitespace-collapsed, truncated — a log stays scannable. */
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
}

const preview = (v: Json): string => oneLine(typeof v === "string" ? v : JSON.stringify(v));

function describe(outcome: Outcome): string {
  if (outcome.status === "failed") return `failed: ${outcome.error.code}: ${outcome.error.message}`;
  if (outcome.status === "canceled") return `canceled (${outcome.by})`;
  return outcome.status;
}

export function logAgentLoop(agent: Agent, sink: (line: string) => void = (line) => log.debug(line)): Agent {
  const traced = (request: InvokeRequest): AsyncIterable<InvokeEvent> => {
    const at = request.sessionId ?? "(new)";
    let messageId: string | undefined;
    let thinking = "";
    let reply = "";
    const toolName = new Map<string, string>();
    const observe = (e: InvokeEvent): void => {
      switch (e.type) {
        case "accepted":
          messageId = e.message.messageId;
          sink(
            `[agent] ▶ message session=${e.sessionId} message=${messageId}${e.duplicate ? " (duplicate)" : ""} ← ${oneLine(request.prompt.text)}`,
          );
          break;
        case "rejected":
          sink(`[agent] ■ rejected session=${at}: ${e.error.code}: ${e.error.message}`);
          break;
        case "message_delta":
          if (e.channel === "text") reply += e.delta;
          else thinking += e.delta;
          break;
        case "tool_started":
          toolName.set(e.toolCallId, e.name);
          sink(`[agent]   tool → ${e.name}(${preview(e.args)})`);
          break;
        case "retry_scheduled":
          sink(`[agent]   retrying (${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms): ${oneLine(e.reason)}`);
          break;
        case "done":
          if (e.message.messageId !== messageId) break;
          if (thinking.trim() !== "") sink(`[agent]   thinking: ${oneLine(thinking)}`);
          sink(`[agent]   reply: ${oneLine(reply || (e.message.answer?.text ?? "")) || "(empty)"}`);
          sink(`[agent] ■ ${describe(e.message.outcome)} message=${messageId}`);
          break;
        case "entry": {
          const data = e.entry.data as { toolCallId?: string; toolName?: string; isError?: boolean; text?: string };
          if (e.entry.kind === "tool_result") {
            const name = toolName.get(data.toolCallId ?? "") ?? data.toolName ?? data.toolCallId;
            sink(`[agent]   tool ${data.isError ? "✗" : "✓"} ${name} → ${preview(data.text ?? "")}`);
          }
          if (e.entry.kind === "assistant_message" && reply === "") reply = data.text ?? "";
          break;
        }
      }
    };
    return {
      [Symbol.asyncIterator]() {
        const inner = agent.invoke(request)[Symbol.asyncIterator]();
        return {
          async next() {
            const next = await inner.next();
            if (!next.done) observe(next.value);
            return next;
          },
          // Straight through: a caller that stops reading detaches at once, not after the next event.
          return: async () => (await inner.return?.()) ?? { done: true, value: undefined },
        };
      },
    };
  };
  return { ...agent, invoke: traced };
}
