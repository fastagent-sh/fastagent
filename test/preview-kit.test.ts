import { describe, expect, it } from "vitest";
import { defaultErrorMessage, humanizeToolName } from "../src/channels/preview-kit.ts";

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
