import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import {
  applyTurnEvent,
  composeTurnBody,
  createTurnView,
  defaultErrorMessage,
  humanizeToolName,
  thinkingLine,
  toolLines,
} from "../src/channels/preview-kit.ts";

describe("humanizeToolName", () => {
  it("splits an mcp identifier into server: tool", () => {
    expect(humanizeToolName("mcp__github__create_issue")).toBe("Github: create issue");
  });

  it("normalizes snake_case and kebab-case into a capitalized phrase", () => {
    expect(humanizeToolName("create_issue")).toBe("Create issue");
    expect(humanizeToolName("read-file")).toBe("Read file");
    expect(humanizeToolName("search")).toBe("Search");
  });

  it("collapses dotted and repeated separators", () => {
    expect(humanizeToolName("read_file.contents")).toBe("Read file contents");
    expect(humanizeToolName("a__b")).toBe("A b");
  });

  it("never exposes tool arguments — it only reshapes the identifier", () => {
    // The identifier is the whole input; there is no separate argument channel to leak.
    expect(humanizeToolName("bash")).toBe("Bash");
  });

  it("falls back to a stable label for an empty identifier", () => {
    expect(humanizeToolName("")).toBe("Tool");
    expect(humanizeToolName("   ")).toBe("Tool");
  });

  it("truncates an overlong identifier within the code-point cap", () => {
    expect(Array.from(humanizeToolName("a".repeat(200))).length).toBeLessThanOrEqual(80);
  });
});

describe("defaultErrorMessage", () => {
  it("offers a retry for a transient failure", () => {
    expect(defaultErrorMessage({ details: "boom", retryable: true })).toMatch(/try again/i);
  });

  it("keeps the neutral phrase and adds a next step for a permanent failure", () => {
    const message = defaultErrorMessage({ details: "boom", retryable: false });
    // The shared "something went wrong" phrase is preserved verbatim (cross-channel wording contract).
    expect(message).toMatch(/something went wrong/i);
    expect(message).toMatch(/rephrasing|access/i);
  });
});

describe("turn-view reducer", () => {
  const apply = (events: AgentEvent[]) => {
    const view = createTurnView();
    const changes = events.map((e) => applyTurnEvent(view, e));
    return { view, changes };
  };

  it("reduces a full turn: humanized+arg'd tool lines, status flips, answer accumulation", () => {
    const { view } = apply([
      { type: "thinking", delta: "hm " },
      { type: "tool_started", id: "t1", name: "read", args: { path: "AGENTS.md" } },
      { type: "tool_started", id: "t2", name: "mcp__github__create_issue", args: {} },
      { type: "tool_ended", id: "t1", isError: false, content: null },
      { type: "tool_ended", id: "t2", isError: true, content: null },
      { type: "text", delta: "ok" },
    ]);
    expect(toolLines(view)).toBe("🔧 Read AGENTS.md ✓\n🔧 Github: create issue ✗");
    expect(view.answer).toBe("ok");
    expect(view.answerSince).toBeDefined();
    expect(view.thinking).toBe("hm ");
  });

  it("opens the retry notice and closes it on ANY subsequent event, including terminals", () => {
    const retrying = { type: "retrying", attempt: 1, maxAttempts: 4, delayMs: 1000, reason: "503" } as const;
    const { view, changes } = apply([retrying, { type: "completed" }]);
    expect(changes).toEqual([true, true]); // the close is a view change even on a terminal
    expect(view.retrying).toBe(false);
    const open = apply([retrying]);
    expect(open.view.retrying).toBe(true);
  });

  it("a terminal without an open notice is not a view change", () => {
    const { changes } = apply([{ type: "completed" }]);
    expect(changes).toEqual([false]);
  });

  it("thinkingLine takes a code-point-safe tail and collapses whitespace", () => {
    const view = createTurnView();
    applyTurnEvent(view, { type: "thinking", delta: `a\nb  ${"🐍".repeat(10)}` });
    expect(thinkingLine(view, 6)).toBe("💭 …🐍🐍🐍🐍🐍"); // marker + 5 points, no torn surrogate
    expect(thinkingLine(createTurnView(), 6)).toBe("");
  });

  it("composeTurnBody skips empty parts and joins with blank lines", () => {
    expect(composeTurnBody(["a", "", "  ", "b"])).toBe("a\n\nb");
    expect(composeTurnBody(["", " "])).toBe("");
  });
});
