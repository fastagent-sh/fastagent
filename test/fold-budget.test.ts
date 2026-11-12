import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent-api.ts";
import { budgetOfWindow, fitToBudget, foldBudget } from "../src/channels/kit/fold-budget.ts";
import { log } from "../src/log.ts";

afterEach(() => vi.restoreAllMocks());

/** An Agent that answers what the budget asks of it: its models, its default, and one session's own model. */
const agentWith = (
  models: { provider: string; modelId: string; contextWindow?: number }[],
  options: {
    defaultModel?: { provider: string; modelId: string };
    session?: { id: string; model?: { provider: string; modelId: string } };
  } = {},
): Pick<Agent, "info" | "sessions"> =>
  ({
    info: async () => ({
      name: "a",
      agent: { name: "a" },
      commands: [],
      tools: [],
      models: models.map((m) => ({ ...m, thinkingLevels: ["off"] })),
      ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    }),
    sessions: {
      get: async (id: string) => {
        if (options.session?.id !== id) throw new Error(`no session ${id}`);
        return {
          id,
          status: "idle",
          usage: { models: {}, tools: {} },
          ...(options.session.model ? { model: options.session.model } : {}),
        };
      },
    },
  }) as unknown as Pick<Agent, "info" | "sessions">;

describe("foldBudget", () => {
  it("is a share of the window the session's own model runs with", async () => {
    const agent = agentWith(
      [
        { provider: "p", modelId: "small", contextWindow: 8_000 },
        { provider: "p", modelId: "large", contextWindow: 1_000_000 },
      ],
      {
        defaultModel: { provider: "p", modelId: "large" },
        session: { id: "s", model: { provider: "p", modelId: "small" } },
      },
    );
    expect(await foldBudget(agent, "s")).toBe(budgetOfWindow(8_000));
    expect(budgetOfWindow(8_000)).toBeLessThan(budgetOfWindow(1_000_000));
  });

  it("uses the agent's default model for a session that names none, and for a conversation with no session yet", async () => {
    const agent = agentWith([{ provider: "p", modelId: "m", contextWindow: 200_000 }], {
      defaultModel: { provider: "p", modelId: "m" },
      session: { id: "s" },
    });
    expect(await foldBudget(agent, "s")).toBe(budgetOfWindow(200_000));
    expect(await foldBudget(agent, undefined)).toBe(budgetOfWindow(200_000));
  });

  it("says a model whose window it does not know, once, and uses the window of an unknown one", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const agent = agentWith([{ provider: "p", modelId: "blind" }], {
      defaultModel: { provider: "p", modelId: "blind" },
    });
    const first = await foldBudget(agent, undefined);
    await foldBudget(agent, undefined);
    expect(first).toBe(budgetOfWindow(128_000));
    expect(warn.mock.calls.flat().join(" ")).toContain("no context window is known for p/blind");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never rejects: an agent that cannot say is said in the log, and the unknown window is used", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const failing = {
      info: async () => Promise.reject(new Error("storage is down")),
      sessions: { get: async () => Promise.reject(new Error("storage is down")) },
    } as unknown as Pick<Agent, "info" | "sessions">;
    expect(await foldBudget(failing, "s")).toBe(budgetOfWindow(128_000));
    expect(warn.mock.calls.flat().join(" ")).toContain("storage is down");
  });
});

describe("fitToBudget", () => {
  const render = (n: number) => `line ${n}`;
  it("keeps the newest that fit, in order, and counts what it left out", () => {
    const { text, folded } = fitToBudget([1, 2, 3, 4, 5], render, "line 4\nline 5".length + 2, false);
    expect(folded).toEqual([4, 5]);
    expect(text).toBe("(3 earlier messages here not shown)\nline 4\nline 5");
  });

  it("says a read that never reached the older messages, with or without a cut", () => {
    expect(fitToBudget([1], render, 1e9, true).text).toBe("(earlier messages here not shown)\nline 1");
    expect(fitToBudget([1, 2], render, 7, true).text).toBe("(1+ earlier messages here not shown)\nline 2");
  });

  it("says nothing for nothing", () => {
    expect(fitToBudget([], render, 1e9, false)).toEqual({ text: "", folded: [] });
  });
});
