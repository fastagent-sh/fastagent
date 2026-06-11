import { describe, expect, it } from "vitest";
import { AgentHarness, InMemorySessionRepo, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createPiAgentFromHarness, piHarnessFactory, type AgentEvent } from "../src/index.ts";

/** An echo tool for the tool-call path. */
const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo back the input",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_id, params) {
    const { value } = params as { value: string };
    return {
      content: [{ type: "text", text: value }],
      details: { echoed: value },
    };
  },
};

/** An agent bound to a faux model + shared repo (→ continuity). Open-or-create per invoke. */
function makeAgent(responses: FauxResponseStep[]) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const repo = new InMemorySessionRepo();
  const agent = createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      repo,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      model: faux.getModel(),
      tools: [echoTool],
      systemPrompt: "test",
    }),
  });
  return { agent, repo };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("invoke fan-in", () => {
  it("纯文本 → completed 终局唯一", async () => {
    const { agent } = makeAgent([fauxAssistantMessage("hello world")]);

    const events = await drain(agent.invoke({ session: "s1" }, { text: "hi" }));

    const text = events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
    expect(text).toBe("hello world");
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(events.filter((e) => e.type === "completed" || e.type === "failed")).toHaveLength(1);
  });

  it("text → tool → completed 顺序保持", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage(fauxToolCall("echo", { value: "ping" }, { id: "call-1" })),
      fauxAssistantMessage("done"),
    ]);

    const events = await drain(agent.invoke({ session: "s2" }, { text: "use echo" }));
    const types = events.map((e) => e.type);

    expect(types).toContain("tool_started");
    expect(types).toContain("tool_ended");
    expect(types.indexOf("tool_started")).toBeLessThan(types.indexOf("tool_ended"));
    expect(events.at(-1)?.type).toBe("completed");

    const started = events.find((e) => e.type === "tool_started") as any;
    expect(started.name).toBe("echo");
    expect(started.id).toBe("call-1");
    const ended = events.find((e) => e.type === "tool_ended") as any;
    expect(ended.id).toBe("call-1");
    expect(ended.isError).toBe(false);
  });

  it("模型 error(不 throw,resolve 带 stopReason)→ failed,而非漏终局", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "rate limit 429" }),
    ]);

    const events = await drain(agent.invoke({ session: "s3" }, { text: "hi" }));
    const terminal = events.at(-1) as any;

    expect(terminal.type).toBe("failed");
    expect(terminal.details).toContain("429");
    expect(terminal.retryable).toBe(true);
  });

  it("cancel(break)→ 无终局事件,且 harness 被 abort", async () => {
    let aborted = false;
    const repo = new InMemorySessionRepo();
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const agent = createPiAgentFromHarness({
      harnessFactory: async (sessionId: string) => {
        const faux = registerFauxProvider();
        faux.setResponses([fauxAssistantMessage("a long answer streamed out")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({
          env,
          session,
          model: faux.getModel(),
          systemPrompt: "test",
        });
        const origAbort = harness.abort.bind(harness);
        harness.abort = async () => {
          aborted = true;
          return origAbort();
        };
        return harness;
      },
    });

    const seen: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s4" }, { text: "hi" })) {
      seen.push(e);
      break;
    }

    expect(seen.some((e) => e.type === "completed" || e.type === "failed")).toBe(false);
    expect(aborted).toBe(true);
  });

  it("cleanup 绝不抛:finally 里 abort() reject 不得污染已闭合的终局流(MUST 2)", async () => {
    const repo = new InMemorySessionRepo();
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const agent = createPiAgentFromHarness({
      harnessFactory: async (sessionId: string) => {
        const faux = registerFauxProvider();
        faux.setResponses([fauxAssistantMessage("done")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({ env, session, model: faux.getModel(), systemPrompt: "test" });
        harness.abort = async () => {
          throw new Error("abort blew up"); // simulate an idle abort rejecting
        };
        return harness;
      },
    });

    // iteration must not throw, and the tail is still completed
    const events = await drain(agent.invoke({ session: "sg" }, { text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "completed" });
  });
});

describe("prompt.images 透传(SPEC §4)", () => {
  it("images 随 prompt 到达模型上下文", async () => {
    let seen: unknown;
    const faux = registerFauxProvider({ models: [{ id: "faux-vision", input: ["text", "image"] }] });
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage("saw it");
      },
    ]);
    const repo = new InMemorySessionRepo();
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        repo,
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(
      agent.invoke(
        { session: "img" },
        { text: "what is this?", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] },
      ),
    );
    const dump = JSON.stringify(seen);
    expect(dump).toContain("aGVsbG8="); // base64 payload reached the context
    expect(dump).toContain('"image"');
  });
});

describe("session 连续性(open 替 create)", () => {
  it("同 session 多 turn:第二轮看得到第一轮历史", async () => {
    let turn2: unknown;
    const { agent } = makeAgent([
      fauxAssistantMessage("issue #42 is the login bug"),
      (context) => {
        turn2 = context.messages; // the context of the second request
        return fauxAssistantMessage("ok, fixing");
      },
    ]);

    await drain(agent.invoke({ session: "conv" }, { text: "triage issue #42" }));
    await drain(agent.invoke({ session: "conv" }, { text: "now fix it" }));

    const dump = JSON.stringify(turn2);
    expect(dump).toContain("triage issue #42"); // turn-1 user
    expect(dump).toContain("issue #42 is the login bug"); // turn-1 assistant
    expect(dump).toContain("now fix it"); // turn-2 user
  });

  it("不同 session 互不串味", async () => {
    let other: unknown;
    const { agent } = makeAgent([
      fauxAssistantMessage("the secret is hunter2"),
      (context) => {
        other = context.messages;
        return fauxAssistantMessage("nothing here");
      },
    ]);

    await drain(agent.invoke({ session: "A" }, { text: "remember the secret" }));
    await drain(agent.invoke({ session: "B" }, { text: "what do you know?" }));

    const dump = JSON.stringify(other);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("remember the secret");
    expect(dump).toContain("what do you know?"); // B's own prompt is present
  });
});

describe("lease + setup 健壮性", () => {
  it("harnessFactory 抛 → failed 事件(不 throw,MUST 2)", async () => {
    const agent = createPiAgentFromHarness({
      harnessFactory: async () => {
        throw new Error("cannot open session");
      },
    });
    const events = await drain(agent.invoke({ session: "z" }, { text: "hi" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed" });
    expect((events[0] as any).details).toContain("cannot open session");
  });

  it("createPiAgentFromHarness 用注入的 lease 包住 invoke(acquire…release)", async () => {
    const calls: string[] = [];
    const repo = new InMemorySessionRepo();
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const agent = createPiAgentFromHarness({
      lease: {
        tryAcquire: (s) => {
          calls.push(`acq:${s}`);
          return () => calls.push(`rel:${s}`);
        },
      },
      harnessFactory: piHarnessFactory({
        repo,
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(agent.invoke({ session: "z" }, { text: "hi" }));
    expect(calls).toEqual(["acq:z", "rel:z"]);
  });

  it("同 session 并发:一个跑完,另一个 fail-fast 'session busy'(不排队、不重入)", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("should-not-run"),
    ]);
    const [ea, eb] = await Promise.all([
      drain(agent.invoke({ session: "x" }, { text: "a" })),
      drain(agent.invoke({ session: "x" }, { text: "b" })),
    ]);

    const completed = [ea, eb].filter((es) => es.at(-1)?.type === "completed");
    const busy = [ea, eb].filter((es) =>
      es.some((e) => e.type === "failed" && /busy/.test((e as any).details)),
    );
    expect(completed).toHaveLength(1); // exactly one completed
    expect(busy).toHaveLength(1); // exactly one busy
    expect(busy[0]).toHaveLength(1); // the busy one never ran a turn; a single failed event
    expect((busy[0]![0] as any).retryable).toBe(true);
  });

  it("busy 是瞬时的:前一个 turn 完成后同 session 可再用", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("later"),
    ]);
    await drain(agent.invoke({ session: "y" }, { text: "a" })); // completed serially
    const events = await drain(agent.invoke({ session: "y" }, { text: "b" }));
    expect(events.at(-1)?.type).toBe("completed"); // no longer busy
  });
});

describe("systemPrompt 工厂(per-invoke 重新求值)", () => {
  it("每次 harnessFactory 都重新调用工厂 → 时间敏感段(日期)不固化在创建时刻", async () => {
    let calls = 0;
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        repo: new InMemorySessionRepo(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: () => `prompt v${++calls}`,
      }),
    });

    await drain(agent.invoke({ session: "p" }, { text: "one" }));
    await drain(agent.invoke({ session: "p" }, { text: "two" }));
    expect(calls).toBe(2); // evaluated once per invoke, not once per agent
  });
});

describe("retryClassifier 注入(failed.retryable 策略可换)", () => {
  it("注入的策略覆盖默认字符串启发式", async () => {
    const faux = registerFauxProvider();
    // "weird custom failure" 不命中默认正则 → 默认会是 retryable:false
    faux.setResponses([
      fauxAssistantMessage("x", { stopReason: "error", errorMessage: "weird custom failure" }),
    ]);
    const agent = createPiAgentFromHarness({
      retryClassifier: () => true,
      harnessFactory: piHarnessFactory({
        repo: new InMemorySessionRepo(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });

    const events = await drain(agent.invoke({ session: "r" }, { text: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "failed", retryable: true });
  });
});
