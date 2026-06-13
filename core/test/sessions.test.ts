import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { jsonlSessionStore, type AgentEvent, type SessionStore } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";

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

describe("jsonlSessionStore (persistent sessions, first K-axis backend)", () => {
  it("restart survival: a new store instance using the same directory sees the previous process history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));

    // "process 1":run one turn and persist it
    const agent1 = makeAgent(jsonlSessionStore({ dir }), [
      fauxAssistantMessage("the answer is blue"),
    ]);
    const e1 = await drain(agent1.invoke({ session: "conv" }, { text: "what color?" }));
    expect(e1.at(-1)?.type).toBe("completed");

    // "process 2":new store instance, same directory: history must remain because disk is the source of truth
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

  it("different sessions do not leak into each other within one store", async () => {
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

  it("two stores with the same sessionsRoot but different cwd do not open each other sessions (project isolation)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const cwdA = await mkdtemp(join(tmpdir(), "fa-proj-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "fa-proj-b-"));

    await drain(
      makeAgent(jsonlSessionStore({ dir, cwd: cwdA }), [fauxAssistantMessage("secret hunter2")]).invoke(
        { session: "same-id" },
        { text: "remember the secret" },
      ),
    );
    let other: unknown;
    await drain(
      makeAgent(jsonlSessionStore({ dir, cwd: cwdB }), [
        (context) => {
          other = context.messages;
          return fauxAssistantMessage("nothing");
        },
      ]).invoke({ session: "same-id" }, { text: "what do you know?" }),
    );

    expect(JSON.stringify(other)).not.toContain("hunter2"); // B cannot see A same-named session
  });

  it("malicious session id cannot escape the sessions directory because it is filename-encoded and can round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const dir = join(root, "sessions");
    const store = jsonlSessionStore({ dir, cwd: root });
    const evil = "../../escape/me";

    const e1 = await drain(
      makeAgent(store, [fauxAssistantMessage("ok")]).invoke({ session: evil }, { text: "hi" }),
    );
    expect(e1.at(-1)?.type).toBe("completed");

    // only sessions/ is created under root; no escape/ or other path breakout appears
    expect((await readdir(root)).sort()).toEqual(["sessions"]);

    // the same odd id resumes the same session because encoding is deterministic and injective
    let turn2: unknown;
    await drain(
      makeAgent(store, [
        (context) => {
          turn2 = context.messages;
          return fauxAssistantMessage("again");
        },
      ]).invoke({ session: evil }, { text: "continue" }),
    );
    expect(JSON.stringify(turn2)).toContain("hi"); // turn 1 is still present
  });
});
