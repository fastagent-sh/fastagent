import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent } from "../src/index.ts";
import { logAgentLoop } from "../src/observe.ts";

function fauxAgent(events: AgentEvent[]): Agent {
  return {
    async *invoke(): AsyncIterable<AgentEvent> {
      for (const e of events) yield e;
    },
  };
}

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("logAgentLoop", () => {
  it("traces prompt, tool call + result, reply, and completion — and passes events through unchanged", async () => {
    const lines: string[] = [];
    const events: AgentEvent[] = [
      { type: "tool_started", id: "t1", name: "read", args: { path: "AGENTS.md" } },
      { type: "tool_ended", id: "t1", isError: false, content: { ok: true } },
      { type: "text", delta: "Done." },
      { type: "completed" },
    ];
    const wrapped = logAgentLoop(fauxAgent(events), (l) => lines.push(l));

    const passed = await drain(wrapped.invoke({ session: "s1" }, { text: "read it" }));

    expect(passed).toEqual(events); // pass-through: the stream is untouched
    expect(lines.some((l) => /turn session=s1/.test(l) && /read it/.test(l))).toBe(true);
    expect(lines.some((l) => /tool → read/.test(l) && /AGENTS\.md/.test(l))).toBe(true);
    expect(lines.some((l) => /tool ✓ read/.test(l))).toBe(true);
    expect(lines.some((l) => /reply: Done\./.test(l))).toBe(true);
    expect(lines.some((l) => /completed session=s1/.test(l))).toBe(true);
  });

  it("traces a failed turn with its details", async () => {
    const lines: string[] = [];
    const wrapped = logAgentLoop(fauxAgent([{ type: "failed", details: "boom", retryable: true }]), (l) =>
      lines.push(l),
    );

    await drain(wrapped.invoke({ session: "s2" }, { text: "x" }));

    expect(lines.some((l) => /failed session=s2/.test(l) && /boom/.test(l) && /retryable=true/.test(l))).toBe(true);
  });
});
