import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDefinitionWarnings, reportToolCollisions } from "../src/engines/pi/report.ts";

// Locks the warning WORDING shared by the CLI runners and `chat` (the reason A1 deduped these into one
// module: two copies could drift). Spies on console.error rather than going through a runner.
describe("report", () => {
  afterEach(() => vi.restoreAllMocks());
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).join("\n");

  it("renders skill collisions and diagnostics to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportDefinitionWarnings([{ name: "greet", winnerPath: "/a/SKILL.md", loserPath: "/b/SKILL.md" }], [
      { type: "warning", code: "invalid_metadata", message: "description is required", path: "/c/SKILL.md" },
    ] as SkillDiagnostic[]);
    expect(lines(err)).toMatch(/skill "greet" collision — using \/a\/SKILL.md, ignoring \/b\/SKILL.md/);
    expect(lines(err)).toMatch(/invalid_metadata: description is required \(\/c\/SKILL.md\)/);
  });

  it("renders tool collisions to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportToolCollisions([{ name: "lookup", source: "tools/lookup.ts" }]);
    expect(lines(err)).toMatch(
      /tool "lookup" \(tools\/lookup.ts\) dropped — a default\/config tool already uses that name/,
    );
  });

  it("prints nothing when there are no findings", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    reportDefinitionWarnings([], []);
    reportToolCollisions([]);
    expect(err).not.toHaveBeenCalled();
  });
});
