import { describe, expect, it } from "vitest";
import type { InvokeEvent } from "../src/protocol.ts";
import { ev } from "./scripted-run.ts";
import {
  applyTurnEvent,
  composeTurnBody,
  createTurnView,
  defaultErrorMessage,
  humanizeToolName,
  thinkingLine,
  toolLines,
} from "../src/channels/kit/preview-kit.ts";

describe("humanizeToolName", () => {
  it("reshapes an identifier into a readable label, whatever shape it arrives in", () => {
    // One pure mapping. The identifier is the WHOLE input — there is no separate argument channel
    // to leak, so "never exposes tool arguments" is a property of the signature, exercised here.
    expect(humanizeToolName("mcp__github__create_issue")).toBe("Github: create issue"); // mcp → server: tool
    expect(humanizeToolName("create_issue")).toBe("Create issue"); // snake_case
    expect(humanizeToolName("read-file")).toBe("Read file"); // kebab-case
    expect(humanizeToolName("search")).toBe("Search");
    expect(humanizeToolName("bash")).toBe("Bash");
    expect(humanizeToolName("read_file.contents")).toBe("Read file contents"); // dotted
    expect(humanizeToolName("a__b")).toBe("A b"); // repeated separators
    expect(humanizeToolName("")).toBe("Tool"); // a stable label rather than an empty one
    expect(humanizeToolName("   ")).toBe("Tool");
    expect(Array.from(humanizeToolName("a".repeat(200))).length).toBeLessThanOrEqual(80); // code-point cap
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
  /** A turn's events after its receipt: the receipt names the run, and only that run's events are the turn's. */
  const apply = (events: InvokeEvent[]) => {
    const view = createTurnView();
    applyTurnEvent(view, ev.accepted());
    const changes = events.map((e) => applyTurnEvent(view, e));
    return { view, changes };
  };

  it("reduces a full turn: humanized+arg'd tool lines, status flips, answer accumulation", () => {
    const { view } = apply([
      ev.thinking("hm "),
      ev.toolStarted("t1", "read", { path: "AGENTS.md" }),
      ev.toolStarted("t2", "mcp__github__create_issue"),
      ev.toolResult("t1"),
      ev.toolResult("t2", true),
      ev.text("ok"),
    ]);
    expect(toolLines(view)).toBe("🔧 Read AGENTS.md ✓\n🔧 Github: create issue ✗");
    expect(view.answer).toBe("ok");
    expect(view.answerSince).toBeDefined();
    expect(view.thinking).toBe("hm ");
  });

  it("a running call shows its latest progress, clipped to one line; a finished one drops it", () => {
    const { view, changes } = apply([
      ev.toolStarted("t1", "bash", { command: "npm test" }),
      ev.toolProgress("t1", "12 passed"),
      ev.toolProgress("t1", `42 passed ${"x".repeat(100)}`),
      ev.toolProgress("unknown", "not a call the view shows"),
    ]);
    expect(changes).toEqual([true, true, true, false]);
    expect(toolLines(view)).toBe(`\u{1F527} Bash npm test \u2026 \u203a 42 passed ${"x".repeat(53)}\u2026`);
    applyTurnEvent(view, ev.toolResult("t1"));
    expect(toolLines(view)).toBe("\u{1F527} Bash npm test \u2713");
    // Progress that arrives after the call ended is stale, and not a view change.
    expect(applyTurnEvent(view, ev.toolProgress("t1", "late"))).toBe(false);
  });

  it("opens the retry notice and closes it on ANY subsequent event, including terminals", () => {
    const retrying = ev.retrying();
    const { view, changes } = apply([retrying, ev.ended()]);
    expect(changes).toEqual([true, true]); // the close is a view change even on a terminal
    expect(view.retrying).toBe(false);
    const open = apply([retrying]);
    expect(open.view.retrying).toBe(true);
  });

  it("a terminal without an open notice is not a view change", () => {
    const { changes } = apply([ev.ended()]);
    expect(changes).toEqual([false]);
  });

  it("thinkingLine takes a code-point-safe tail and collapses whitespace", () => {
    const view = createTurnView();
    applyTurnEvent(view, ev.accepted());
    applyTurnEvent(view, ev.thinking(`a\nb  ${"🐍".repeat(10)}`));
    expect(thinkingLine(view, 6)).toBe("💭 …🐍🐍🐍🐍🐍"); // marker + 5 points, no torn surrogate
    expect(thinkingLine(createTurnView(), 6)).toBe("");
  });

  it("the settled message adds what no delta carried; another run's events are not the turn's", () => {
    const { view, changes } = apply([
      ev.text("Hel"),
      ev.answer("Hello"),
      ev.text("ignored", "other-run"),
      ev.thinking("not ours", "other-run"),
      ev.toolStarted("t9", "read", {}, "other-run"),
    ]);
    expect(view.answer).toBe("Hello");
    expect(view.thinking).toBe("");
    expect(view.tools).toEqual([]);
    expect(changes).toEqual([true, true, false, false, false]);
  });

  it("composeTurnBody skips empty parts and joins with blank lines", () => {
    expect(composeTurnBody(["a", "", "  ", "b"])).toBe("a\n\nb");
    expect(composeTurnBody(["", " "])).toBe("");
  });
});
