import { describe, expect, it } from "vitest";
import { formatAuthReport } from "../src/cli/auth-view.ts";

// The #5 fix: an expired/revoked login must NOT report the contradictory "(none found)". This pins the
// three-branch decision so flipping stored/none (or a probe/store contract change) can't silently regress.
describe("auth-view: formatAuthReport", () => {
  const P = "anthropic";
  const PATH = "/x/auth.json";

  it("reports the three branches distinctly: usable source, stored-but-unusable, nothing at all", () => {
    // A usable source: just the source line, no warning.
    expect(formatAuthReport(P, PATH, "OAuth", undefined)).toEqual({ line: "auth:   OAuth (anthropic) — /x/auth.json" });
    expect(formatAuthReport("openai", PATH, "OPENAI_API_KEY", undefined)).toEqual({
      line: "auth:   OPENAI_API_KEY (openai) — /x/auth.json",
    });

    // No source but a STORED credential: expired/unusable + re-login, never "(none found)".
    const stored = formatAuthReport(P, PATH, undefined, { type: "oauth" });
    expect(stored.line).toContain("stored anthropic oauth, expired/unusable");
    expect(stored.line).not.toContain("(none found)");
    expect(stored.warn).toMatch(/expired or unusable.*fastagent login/);

    // Nothing stored either: "(none found)" + the no-credentials hint.
    const none = formatAuthReport(P, PATH, undefined, undefined);
    expect(none.line).toContain("(none found)");
    expect(none.warn).toMatch(/no credentials for "anthropic"/);
  });
});
