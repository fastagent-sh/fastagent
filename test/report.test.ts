import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDefinitionWarnings, reportFindingsIfChanged, reportToolCollisions } from "../src/engines/pi/report.ts";

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

  it("the findings memo is per DEFINITION, not per reader: two readers of one dir warn once", () => {
    // Why the memo is module state keyed by the resolved dir instead of a closure inside the
    // assembly: the thing being deduped is the FINDING. A broken skill discovered by the turn's live
    // read and then by the control plane's command list is ONE event for the author.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const findings = {
      collisions: [],
      diagnostics: [
        { type: "warning", code: "invalid_metadata", message: "description is required", path: "/a/x/SKILL.md" },
      ] as SkillDiagnostic[],
    };
    reportFindingsIfChanged("/agent", findings); // reader A (a turn)
    expect(lines(err)).toMatch(/invalid_metadata/);
    err.mockClear();
    reportFindingsIfChanged("/agent", findings); // reader B (commands()) — same finding, same dir
    expect(err).not.toHaveBeenCalled();
    // A DIFFERENT definition keeps its own budget …
    reportFindingsIfChanged("/other-agent", findings);
    expect(lines(err)).toMatch(/invalid_metadata/);
    err.mockClear();
    // There is no record-without-printing door: the boot report goes through this same function, so
    // a caller that never reports cannot silently consume the announcement for every later reader.
    reportFindingsIfChanged("/third-agent", findings); // boot
    err.mockClear();
    reportFindingsIfChanged("/third-agent", findings); // a turn, then commands() — already said
    expect(err).not.toHaveBeenCalled();
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
