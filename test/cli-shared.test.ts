import { describe, expect, it } from "vitest";
import { loginWithKeyCheck } from "../src/cli/shared.ts";
import { LoginCancelled, type LoginMethod } from "../src/engines/pi/login.ts";

/** Record every flow call's (provider, method) and pop canned results/verdicts in order. */
function fakes(
  results: Array<{ provider: string; method: LoginMethod }>,
  verdicts: Array<"ok" | "rejected" | "unknown">,
) {
  const flowCalls: Array<{ provider?: string; method?: LoginMethod }> = [];
  const verifyCalls: string[] = [];
  return {
    flowCalls,
    verifyCalls,
    flow: async (_io: unknown, options: { provider?: string; method?: LoginMethod }) => {
      flowCalls.push({ provider: options.provider, method: options.method });
      return results[flowCalls.length - 1] as { provider: string; method: LoginMethod };
    },
    verify: async (provider: string) => {
      verifyCalls.push(provider);
      return verdicts[verifyCalls.length - 1] as "ok" | "rejected" | "unknown";
    },
  };
}

describe("loginWithKeyCheck (the rejected-key retry loop)", () => {
  it("rejected → re-asks ONLY the key (provider+method pinned), exits on ok", async () => {
    const f = fakes(
      [
        { provider: "deepseek", method: "api_key" },
        { provider: "deepseek", method: "api_key" },
      ],
      ["rejected", "ok"],
    );
    const result = await loginWithKeyCheck(undefined, "/tmp/auth.json", "deepseek/chat", f);
    expect(result).toEqual({ provider: "deepseek", method: "api_key" });
    // First pass: nothing pinned (user picks provider/method); retry pins BOTH so only the key is re-asked.
    expect(f.flowCalls).toEqual([
      { provider: undefined, method: undefined },
      { provider: "deepseek", method: "api_key" },
    ]);
    expect(f.verifyCalls).toEqual(["deepseek", "deepseek"]);
  });

  it("unknown keeps the key and exits (no retry); OAuth skips verification entirely", async () => {
    const unknown = fakes([{ provider: "p", method: "api_key" }], ["unknown"]);
    await loginWithKeyCheck("p", "/tmp/auth.json", undefined, unknown);
    expect(unknown.flowCalls).toHaveLength(1); // no re-prompt on unverifiable

    const oauth = fakes([{ provider: "openai-codex", method: "oauth" }], []);
    await loginWithKeyCheck(undefined, "/tmp/auth.json", undefined, oauth);
    expect(oauth.verifyCalls).toEqual([]); // completing the flow already proved the credential
  });

  it("cancel inside the retry propagates (caller's cancel policy decides)", async () => {
    const f = fakes([{ provider: "p", method: "api_key" }], ["rejected"]);
    const flow = async (io: unknown, options: { provider?: string; method?: LoginMethod }) => {
      if (options.method === "api_key") throw new LoginCancelled("cancelled"); // the re-prompt round
      return f.flow(io, options);
    };
    await expect(
      loginWithKeyCheck(undefined, "/tmp/auth.json", undefined, { flow, verify: f.verify }),
    ).rejects.toBeInstanceOf(LoginCancelled);
  });
});
