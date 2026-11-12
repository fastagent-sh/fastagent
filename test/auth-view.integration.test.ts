import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatAuthReport } from "../src/cli/auth-view.ts";

// The #5 fix: an expired/revoked login must NOT report the contradictory "(none found)". This pins the
// three-branch decision so flipping stored/none (or a probe/store contract change) can't silently regress.
describe("auth-view: formatAuthReport", () => {
  const P = "anthropic";
  const PATH = "/x/auth.json";

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
});
