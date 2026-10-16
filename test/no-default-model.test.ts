/**
 * An agent with no default model still opens: its conversations are readable and a session that records its model
 * runs on it. Only a session with no model of its own fails, at run time, with `missing_model` (#706).
 */
import { collect } from "../src/protocol-collect.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAgentFromDir } from "../src/harnesses/pi/open.ts";
import { piInMemorySessionRecordStore } from "../src/harnesses/pi/session-store.ts";
import type { Agent, SessionState } from "../src/protocol.ts";
import { fauxAgent } from "./agent.ts";

const FAUX = { provider: "faux-706" };

async function stateOf(agent: Agent, sessionId: string): Promise<SessionState> {
  const read = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (!read.ok) throw new Error(read.error.message);
  return read.state;
}

/** How a run that could not run ended: its `missing_model` error. */
async function missingModel(
  agent: Agent,
  sessionId: string,
): Promise<{ code: string; retryable: boolean; message: string }> {
  const error = await collect(agent.invoke({ sessionId, prompt: { text: "hi" } })).then(
    () => undefined,
    (thrown: { outcome?: { error?: { code: string; retryable: boolean; message: string } } }) => thrown.outcome?.error,
  );
  if (!error) throw new Error(`the run on ${sessionId} did not fail`);
  return error;
}

afterEach(() => vi.unstubAllEnvs());

describe("an agent with no default model", () => {
  it("fails a run on a session with no model of its own, and runs it once update({ model }) gives it one", async () => {
    const { agent, faux } = fauxAgent([fauxAssistantMessage("hello")], { faux: FAUX, noDefaultModel: true });
    const spec = `${faux.getModel().provider}/${faux.getModel().id}`;
    expect((await agent.models()).map((m) => m.spec)).toContain(spec);

    expect(await missingModel(agent, "fresh")).toMatchObject({
      code: "missing_model",
      retryable: false,
      message: expect.stringMatching(/session "fresh" has no model: it records none/),
    });
    // Readable, and honest that there is no model yet.
    const before = await stateOf(agent, "fresh");
    expect(before).not.toHaveProperty("model");
    expect(before).not.toHaveProperty("thinkingLevels");

    // A level without a model is recorded as asked; the model then decides what runs.
    const s = agent.sessions.get("fresh");
    expect(await s.update({ thinkingLevel: "high" })).toEqual({ ok: true });
    expect(await stateOf(agent, "fresh")).not.toHaveProperty("model");
    expect(await s.update({ model: spec })).toEqual({ ok: true });
    expect(await stateOf(agent, "fresh")).toMatchObject({ model: spec });

    expect((await collect(agent.invoke({ sessionId: "fresh", prompt: { text: "hi" } }))).text).toBe("hello");
  });

  it("a fork takes its model from its source, and one whose source has none fails missing_model", async () => {
    const sessions = piInMemorySessionRecordStore();
    const withDefault = fauxAgent([fauxAssistantMessage("in the room")], { faux: FAUX, sessions });
    await collect(withDefault.agent.invoke({ sessionId: "room", prompt: { text: "hi" } }));

    const { agent } = fauxAgent([fauxAssistantMessage("in the thread")], {
      faux: FAUX,
      sessions,
      noDefaultModel: true,
    });
    expect(await agent.sessions.create({ sessionId: "bare" })).toMatchObject({ ok: true });
    expect(await agent.sessions.get("bare").update({ name: "a source with no model" })).toEqual({ ok: true });
    expect(await agent.sessions.create({ sessionId: "child-of-bare", fork: { sessionId: "bare" } })).toMatchObject({
      ok: true,
    });
    expect(await missingModel(agent, "child-of-bare")).toMatchObject({ code: "missing_model" });

    expect(await agent.sessions.create({ sessionId: "thread", fork: { sessionId: "room" } })).toMatchObject({
      ok: true,
    });
    expect((await collect(agent.invoke({ sessionId: "thread", prompt: { text: "go on" } }))).text).toBe(
      "in the thread",
    );
  });

  it("runs a session on the model it records, and names a recorded model this registry does not know", async () => {
    const sessions = piInMemorySessionRecordStore();
    // Recorded under an agent that HAD a default: pi writes the model a new session starts on into its record.
    const before = fauxAgent([fauxAssistantMessage("first")], { faux: FAUX, sessions });
    await collect(before.agent.invoke({ sessionId: "s1", prompt: { text: "hi" } }));
    const spec = `${before.faux.getModel().provider}/${before.faux.getModel().id}`;

    const now = fauxAgent([fauxAssistantMessage("second")], { faux: FAUX, sessions, noDefaultModel: true });
    expect((await now.agent.sessions.list()).map((summary) => summary.sessionId)).toContain("s1");
    expect(await stateOf(now.agent, "s1")).toMatchObject({ model: spec });
    expect((await collect(now.agent.invoke({ sessionId: "s1", prompt: { text: "again" } }))).text).toBe("second");
    const read = await now.agent.sessions.get("s1").read();
    const answers = read.ok ? read.entries.filter((e) => e.kind === "assistant_message") : [];
    expect(answers.map((e) => (e.data as { text: string }).text)).toEqual(["first", "second"]);

    // Opened where that model is not registered, and with no default: refused, saying which model it records.
    const elsewhere = fauxAgent([], { faux: { provider: "other" }, sessions, noDefaultModel: true });
    expect(await stateOf(elsewhere.agent, "s1")).not.toHaveProperty("model");
    expect((await missingModel(elsewhere.agent, "s1")).message).toContain(`the model it records, ${spec}, is not one`);
    // Compaction is a model call on the session's model: refused with the same code, the same fix applies.
    expect(await elsewhere.agent.sessions.get("s1").compact()).toMatchObject({
      ok: false,
      error: { code: "missing_model", retryable: false },
    });
  });

  it("createPiAgentFromDir opens a directory whose config sets no model, and a run there fails missing_model", async () => {
    vi.stubEnv("FASTAGENT_MODEL", undefined);
    const dir = await mkdtemp(join(tmpdir(), "fa-no-model-"));
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};");
    const opened = await createPiAgentFromDir(dir, {});
    expect(opened.modelSpec).toBeUndefined();
    expect(await opened.agent.sessions.list()).toEqual([]);
    await expect(collect(opened.agent.invoke({ sessionId: "s", prompt: { text: "hi" } }))).rejects.toMatchObject({
      outcome: { status: "failed", error: { code: "missing_model" } },
    });
  });
});
