import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createPiAgentFromHarness,
  jsonlSessionStore,
  piHarnessFactory,
  type AgentEvent,
  type SessionStore,
} from "../src/index.ts";

/** Agent over an injected store (the store is the variable under test). */
function makeAgent(sessions: SessionStore, responses: FauxResponseStep[]) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  return createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      model: faux.getModel(),
      systemPrompt: "test",
    }),
  });
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("jsonlSessionStore(持久 session,K 轴第一个后端)", () => {
  it("重启存活:新 store 实例(同目录)看得到上一进程的对话历史", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));

    // “进程 1”:跑一轮并落盘
    const agent1 = makeAgent(jsonlSessionStore({ dir }), [
      fauxAssistantMessage("the answer is blue"),
    ]);
    const e1 = await drain(agent1.invoke({ session: "conv" }, { text: "what color?" }));
    expect(e1.at(-1)?.type).toBe("completed");

    // “进程 2”:全新 store 实例,同一目录 → 历史必须还在(磁盘是真相)
    let turn2: unknown;
    const agent2 = makeAgent(jsonlSessionStore({ dir }), [
      (context) => {
        turn2 = context.messages;
        return fauxAssistantMessage("still blue");
      },
    ]);
    const e2 = await drain(agent2.invoke({ session: "conv" }, { text: "remind me" }));
    expect(e2.at(-1)?.type).toBe("completed");

    const dump = JSON.stringify(turn2);
    expect(dump).toContain("what color?"); // turn-1 user
    expect(dump).toContain("the answer is blue"); // turn-1 assistant
    expect(dump).toContain("remind me"); // turn-2 user
  });

  it("不同 session 互不串味(同一 store)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const store = jsonlSessionStore({ dir });

    await drain(makeAgent(store, [fauxAssistantMessage("secret hunter2")]).invoke(
      { session: "A" },
      { text: "remember the secret" },
    ));
    let other: unknown;
    await drain(
      makeAgent(store, [
        (context) => {
          other = context.messages;
          return fauxAssistantMessage("nothing");
        },
      ]).invoke({ session: "B" }, { text: "what do you know?" }),
    );

    expect(JSON.stringify(other)).not.toContain("hunter2");
  });

  it("恶意 session id 不逃出 sessions 目录(编码进文件名,且可往返续接)", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const dir = join(root, "sessions");
    const store = jsonlSessionStore({ dir, cwd: root });
    const evil = "../../escape/me";

    const e1 = await drain(
      makeAgent(store, [fauxAssistantMessage("ok")]).invoke({ session: evil }, { text: "hi" }),
    );
    expect(e1.at(-1)?.type).toBe("completed");

    // root 下只多了 sessions/ 这一个目录 —— 没有 escape/ 之类的外溢
    expect((await readdir(root)).sort()).toEqual(["sessions"]);

    // 同一个怪 id 续接命中同一 session(编码是确定且单射的)
    let turn2: unknown;
    await drain(
      makeAgent(store, [
        (context) => {
          turn2 = context.messages;
          return fauxAssistantMessage("again");
        },
      ]).invoke({ session: evil }, { text: "continue" }),
    );
    expect(JSON.stringify(turn2)).toContain("hi"); // turn-1 还在
  });
});
