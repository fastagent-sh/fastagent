import { describe, expect, it } from "vitest";
import { formatAuthReport } from "../src/cli/auth-view.ts";

// The #5 fix: an expired/revoked login must NOT report the contradictory "(none found)". This pins the
// three-branch decision so flipping stored/none (or a probe/store contract change) can't silently regress.
describe("auth-view: formatAuthReport", () => {
  const P = "anthropic";
  const PATH = "/x/auth.json";

  it("reports the three branches distinctly: usable source, stored-but-unusable, nothing at all", () => {
    // A usable source: just the source line, no warning.
    expect(formatAuthReport({ provider: P, path: PATH, source: "OAuth" })).toEqual({
      line: "auth:   OAuth (anthropic) — /x/auth.json",
    });
    expect(formatAuthReport({ provider: "openai", path: PATH, source: "OPENAI_API_KEY" })).toEqual({
      line: "auth:   OPENAI_API_KEY (openai) — /x/auth.json",
    });

    // No source but a STORED credential: expired/unusable + re-login, never "(none found)".
    const stored = formatAuthReport({ provider: P, path: PATH, stored: "oauth" });
    expect(stored.line).toContain("stored anthropic oauth, expired/unusable");
    expect(stored.line).not.toContain("(none found)");
    expect(stored.warn).toMatch(/expired or unusable.*fastagent login/);

    // Nothing stored either: "(none found)" + the no-credentials hint.
    const none = formatAuthReport({ provider: P, path: PATH });
    expect(none.line).toContain("(none found)");
    expect(none.warn).toMatch(/no credentials for "anthropic"/);
  });

  it("a stored login that outranks a key in the environment says the key is unused, and how to switch to it", () => {
    // pi lets a stored credential own its provider, so a key added to a deployment's value file after the box was
    // logged in is ignored with nothing else to say so.
    const box = formatAuthReport({
      provider: P,
      path: "/data/.secrets/auth.json",
      source: "OAuth",
      stored: "oauth",
      shadowed: "ANTHROPIC_API_KEY",
      deployed: true,
    });
    expect(box.line).toBe("auth:   OAuth (anthropic) — /data/.secrets/auth.json");
    expect(box.warn).toBe(
      "ANTHROPIC_API_KEY is set but unused: the stored anthropic oauth credential in /data/.secrets/auth.json " +
        "outranks it. To run on ANTHROPIC_API_KEY, log in with it instead: `fastagent login anthropic --deployment` " +
        'from the workspace this was deployed from, choosing "API key"',
    );
  });
});
