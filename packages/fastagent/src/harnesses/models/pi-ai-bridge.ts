/**
 * Harness-neutral `pi-ai` helpers shared by external harnesses (`@fastagent-sh/harness-dsh` and future adapters):
 * maps FastAgent `ThinkingLevel` values onto `pi-ai` reasoning levels and classifies failed assistant turns into
 * auth, rate-limit, retryable server, or terminal model errors.
 */
import type { AssistantMessage as PiAssistantMessage, ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

const VALID_REASONING: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/** Map a FastAgent `ThinkingLevel` string to `pi-ai`'s reasoning level (`"off"` -> `undefined`, `"max"` -> `"xhigh"`). */
export function toPiThinkingLevel(effort: string | undefined): PiThinkingLevel | undefined {
  if (effort === undefined || effort === "off") return undefined;
  if (effort === "max") return "xhigh";
  return VALID_REASONING.has(effort) ? (effort as PiThinkingLevel) : undefined;
}

export type PiAiErrorCode = "AUTH" | "RATE_LIMIT" | "SERVER" | "PI_AI_ERROR";

/** Classify a failed `pi-ai` assistant turn using HTTP status (when available) and `pi-ai`'s retry rules. */
export function classifyPiAiError(
  error: PiAssistantMessage,
  status?: number,
): { code: PiAiErrorCode; status?: number } {
  const message = error.errorMessage || "Model call failed";
  const lower = message.toLowerCase();
  if (
    status === 401 ||
    (status === undefined &&
      (lower.includes("401") ||
        lower.includes("unauthorized") ||
        lower.includes("credential") ||
        lower.includes("api key")))
  ) {
    return { code: "AUTH", status: 401 };
  }
  const retryProbe =
    status !== undefined && !message.includes(String(status))
      ? { ...error, errorMessage: `${status} ${message}` }
      : error;
  const retryable = isRetryableAssistantError(retryProbe);
  if (status === 429 || lower.includes("429") || lower.includes("rate limit")) {
    return retryable ? { code: "RATE_LIMIT", status: 429 } : { code: "PI_AI_ERROR", status: 429 };
  }
  if (retryable || (status !== undefined && status >= 500)) {
    return { code: "SERVER", status: status !== undefined && status >= 500 ? status : 503 };
  }
  return { code: "PI_AI_ERROR", ...(status !== undefined ? { status } : {}) };
}
