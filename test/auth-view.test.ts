import { describe, expect, it } from "vitest";
import { formatAuthReport } from "../src/cli/auth-view.ts";

// The #5 fix: an expired/revoked login must NOT report the contradictory "(none found)". This pins the
// three-branch decision so flipping stored/none (or a probe/store contract change) can't silently regress.
describe("auth-view: formatAuthReport", () => {
  const P = "anthropic";
  const PATH = "/x/auth.json";

  it("a usable source → just the source line, no warning", () => {
    expect(formatAuthReport(P, PATH, "OAuth", undefined)).toEqual({ line: "auth:   OAuth (anthropic) — /x/auth.json" });
    expect(formatAuthReport("openai", PATH, "OPENAI_API_KEY", undefined)).toEqual({
      line: "auth:   OPENAI_API_KEY (openai) — /x/auth.json",
    });
  });

  it("no source but a STORED credential → expired/unusable + re-login (NOT '(none found)')", () => {
    const r = formatAuthReport(P, PATH, undefined, { type: "oauth" });
    expect(r.line).toContain("stored anthropic oauth, expired/unusable");
    expect(r.line).not.toContain("(none found)");
    expect(r.warn).toMatch(/expired or unusable.*fastagent login/);
  });

  it("no source and nothing stored → (none found) + no-credentials hint", () => {
    const r = formatAuthReport(P, PATH, undefined, undefined);
    expect(r.line).toContain("(none found)");
    expect(r.warn).toMatch(/no credentials for "anthropic"/);
  });
});
