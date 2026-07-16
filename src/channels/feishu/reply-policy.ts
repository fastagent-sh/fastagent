import type { FeishuReplyPolicy } from "./model.ts";

/** Exact model output that means an ambient, unmentioned thread message needs no visible reply. */
export const FEISHU_NO_REPLY = "<FASTAGENT_NO_REPLY>";

/** Appended after the user content and formatting hint, so the optional-delivery contract is the last
 * instruction the Agent sees. The channel buffers these turns until completion: no Thinking/Queued
 * message may appear before the Agent has decided that a reply is useful. */
export function replyPolicyInstruction(policy: FeishuReplyPolicy): string {
  return policy === "agent-decides"
    ? `\n\n[This is an ambient message in an Agent-managed group thread. Reply normally only when a response is useful. If no response is warranted, output exactly ${FEISHU_NO_REPLY} and nothing else.]`
    : "";
}

/** Empty output is silence too; the exact marker is deliberately recognized only as the whole answer,
 * so mentioning it in ordinary prose cannot accidentally suppress a real reply. */
export function isNoReply(text: string): boolean {
  const answer = text.trim();
  return answer === "" || answer === FEISHU_NO_REPLY;
}
