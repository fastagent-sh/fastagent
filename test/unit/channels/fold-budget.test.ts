import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentInfo, Session } from "../../../src/agent-api.ts";
import { fitToBudget, foldBudget } from "../../../src/channels/kit/fold-budget.ts";

function fakeAgent(options: {
  defaultModel?: { provider: string; modelId: string };
  sessionModel?: { provider: string; modelId: string };
  models?: { provider: string; modelId: string; contextWindow?: number }[];
  failInfo?: boolean;
}): Pick<Agent, "info" | "sessions"> {
  return {
    async info() {
      if (options.failInfo) throw new Error("unavailable");
      return {
        name: "bot",
        ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
        models: (options.models ?? []).map((model) => ({ ...model, name: model.modelId })),
        tools: [],
        commands: [],
      } as unknown as AgentInfo;
    },
    sessions: {
      async get() {
        return {
          id: "s1",
          status: "idle",
          ...(options.sessionModel ? { model: options.sessionModel } : {}),
          usage: { models: {}, tools: {} },
        } as Session;
      },
    } as unknown as Agent["sessions"],
  };
}

describe("foldBudget: pure character budget from model context window", () => {
  it("prefers the session model's contextWindow over the agent default", async () => {
    const agent = fakeAgent({
      defaultModel: { provider: "p", modelId: "small" },
      sessionModel: { provider: "p", modelId: "large" },
      models: [
        { provider: "p", modelId: "small", contextWindow: 10_000 },
        { provider: "p", modelId: "large", contextWindow: 200_000 },
      ],
    });
    expect(await foldBudget(agent, "s1")).toBe(40_000);
    expect(await foldBudget(agent, undefined)).toBe(2_000);
  });

  it("falls back to the 128k default budget when window is unknown or info fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = fakeAgent({
      defaultModel: { provider: "p", modelId: "mystery" },
      models: [{ provider: "p", modelId: "mystery" }],
    });
    expect(await foldBudget(unknown, undefined)).toBe(25_600);
    expect(await foldBudget(fakeAgent({ failInfo: true }), undefined)).toBe(25_600);
  });
});

describe("fitToBudget: newest-first folding and truncation notice", () => {
  it("keeps the newest items within budget and reports omitted earlier counts accurately", () => {
    const items = ["first", "second", "third", "fourth"];
    const kept = fitToBudget(items, (s) => s, 14, false);
    expect(kept.folded).toEqual(["third", "fourth"]);
    expect(kept.text).toBe("(2 earlier messages here not shown)\nthird\nfourth");

    const singular = fitToBudget(["alpha", "beta"], (s) => s, 6, false);
    expect(singular.folded).toEqual(["beta"]);
    expect(singular.text).toBe("(1 earlier message here not shown)\nbeta");

    const withEarlier = fitToBudget(["alpha", "beta"], (s) => s, 6, true);
    expect(withEarlier.text).toBe("(1+ earlier messages here not shown)\nbeta");
  });

  it("notices even when no item fits or earlier history was truncated before the read", () => {
    expect(fitToBudget(["too-long-message"], (s) => s, 5, false)).toEqual({
      text: "(1 earlier message here not shown)",
      folded: [],
    });
    expect(fitToBudget(["ok"], (s) => s, 100, true)).toEqual({
      text: "(earlier messages here not shown)\nok",
      folded: ["ok"],
    });
    expect(fitToBudget([], (s: string) => s, 100, false)).toEqual({ text: "", folded: [] });
  });
});
