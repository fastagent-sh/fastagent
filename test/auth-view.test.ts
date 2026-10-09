import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatAuthReport } from "../src/cli/auth-view.ts";
import { deployedHost } from "../src/paths.ts";

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
      deployed: { host: "railway" },
    });
    expect(box.line).toBe("auth:   OAuth (anthropic) — /data/.secrets/auth.json");
    expect(box.warn).toBe(
      "ANTHROPIC_API_KEY is set but unused: the stored anthropic oauth credential in /data/.secrets/auth.json " +
        "outranks it. To run on ANTHROPIC_API_KEY, log in with it instead: `fastagent login anthropic --deployment railway` " +
        'from the agent directory this was deployed from, choosing "API key"',
    );
  });

  it("local recovery commands write the selected auth path, including shell-special characters", () => {
    const authPath = "/agent's dir/$production/auth.json";
    const local = { authPath, valueFile: "/agent/.secrets/production/.env" };
    for (const status of [
      {},
      { stored: "oauth" },
      { source: "OAuth", stored: "oauth", shadowed: "ANTHROPIC_API_KEY" },
    ]) {
      const report = formatAuthReport({ provider: P, path: PATH, local, ...status });
      const command = report.warn?.match(/`([^`]+)`/)?.[1];
      expect(command).toBeDefined();
      const result = spawnSync("sh", ["-c", `fastagent() { printf '%s' "$FASTAGENT_AUTH_PATH"; }; ${command}`]);
      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toBe(authPath);
    }
    expect(formatAuthReport({ provider: P, path: PATH, local }).warn).toContain(local.valueFile);
  });

  it("a box that cannot tell its host leaves <host> in the command, never a guess", () => {
    const box = formatAuthReport({ provider: P, path: PATH, deployed: { host: undefined } });
    expect(box.warn).toContain(
      "run `fastagent login --deployment <host>` from the agent directory this was deployed from",
    );
  });
});

describe("deployedHost: which host a box runs on, from its own environment", () => {
  it("reads each platform's own variable, and answers nothing where nothing says", () => {
    expect(deployedHost({ FASTAGENT_AGENTCORE: "1" })).toBe("agentcore");
    expect(deployedHost({ FLY_APP_NAME: "bot" })).toBe("fly");
    expect(deployedHost({ RAILWAY_SERVICE_ID: "f120224a" })).toBe("railway");
    expect(deployedHost({})).toBeUndefined();
  });
});
