/**
 * An agent with no default model still opens: its conversations are readable and a session that records its model
 * runs on it. Only a session with no model of its own is refused, at invoke, with `missing_model` (#706).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, MISSING_MODEL_CODE } from "../src/agent.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { fauxControlledAgent } from "./agent.ts";

const FAUX = { provider: "faux-706" };

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

afterEach(() => vi.unstubAllEnvs());

describe("an agent with no default model", () => {
  it("refuses a session with no model of its own before creating it, and runs one once update({ model }) gives it one", async () => {
    const { agent, control, faux } = await fauxControlledAgent([fauxAssistantMessage("hello")], {
      faux: FAUX,
      noDefaultModel: true,
    });
    const spec = `${faux.getModel().provider}/${faux.getModel().id}`;
    const s = control.sessions.get("fresh");

    // Readable, and honest that there is no model yet.
    const before = await s.state();
    expect(before).not.toHaveProperty("model");
    expect(before).not.toHaveProperty("availableThinkingLevels");
    expect(control.capabilities().allowedModels?.map((m) => m.spec)).toContain(spec);

    const refused = await drain(agent.invoke({ session: "fresh" }, { text: "hi" }));
    expect(refused.at(-1)).toMatchObject({ type: "failed", code: MISSING_MODEL_CODE, retryable: false });
    expect((refused.at(-1) as { details: string }).details).toMatch(/session "fresh" has no model: it records none/);
    // A turn that could not run left no empty conversation behind.
    expect((await control.sessions.list()).map((summary) => summary.session)).not.toContain("fresh");

    // A level without a model is recorded as asked; the model then decides what runs.
    expect(await s.update({ thinkingLevel: "high" })).toEqual({ ok: true });
    expect(await s.state()).not.toHaveProperty("model");
    expect(await s.update({ model: spec })).toEqual({ ok: true });
    expect(await s.state()).toMatchObject({ model: spec });

    const ran = await drain(agent.invoke({ session: "fresh" }, { text: "hi" }));
    expect(ran.at(-1)).toEqual({ type: "completed" });
  });

  it("a new thread takes its model from its parent, and one whose parent has none leaves no record behind", async () => {
    const sessions = piInMemorySessionRecordStore();
    const withDefault = await fauxControlledAgent([fauxAssistantMessage("in the room")], { faux: FAUX, sessions });
    expect((await drain(withDefault.agent.invoke({ session: "room" }, { text: "hi" }))).at(-1)).toEqual({
      type: "completed",
    });

    const { agent, control } = await fauxControlledAgent([fauxAssistantMessage("in the thread")], {
      faux: FAUX,
      sessions,
      noDefaultModel: true,
    });
    expect(await control.sessions.get("bare").update({ name: "a parent with no model" })).toEqual({ ok: true });
    for (const parentSession of ["nowhere", "bare"]) {
      const child = `child-of-${parentSession}`;
      const refused = await drain(agent.invoke({ session: child, parentSession }, { text: "hi" }));
      expect(refused.at(-1), parentSession).toMatchObject({ type: "failed", code: MISSING_MODEL_CODE });
      expect(
        (await control.sessions.list()).map((s) => s.session),
        parentSession,
      ).not.toContain(child);
    }

    const inherited = await drain(agent.invoke({ session: "thread", parentSession: "room" }, { text: "go on" }));
    expect(inherited.at(-1)).toEqual({ type: "completed" });
  });

  it("runs a session on the model it records, and names a recorded model this registry does not know", async () => {
    const sessions = piInMemorySessionRecordStore();
    // Recorded under an agent that HAD a default: pi writes the model a new session starts on into its record.
    const before = await fauxControlledAgent([fauxAssistantMessage("first")], { faux: FAUX, sessions });
    expect((await drain(before.agent.invoke({ session: "s1" }, { text: "hi" }))).at(-1)).toEqual({ type: "completed" });
    const spec = `${before.faux.getModel().provider}/${before.faux.getModel().id}`;

    const now = await fauxControlledAgent([fauxAssistantMessage("second")], {
      faux: FAUX,
      sessions,
      noDefaultModel: true,
    });
    expect((await now.control.sessions.list()).map((summary) => summary.session)).toContain("s1");
    expect(await now.control.sessions.get("s1").state()).toMatchObject({ model: spec });
    expect((await drain(now.agent.invoke({ session: "s1" }, { text: "again" }))).at(-1)).toEqual({ type: "completed" });
    const answers = (await now.control.sessions.get("s1").entries()).entries.filter((e) => e.kind === "assistant");
    expect(answers.map((e) => (e.data as { text: string }).text)).toEqual(["first", "second"]);

    // Opened where that model is not registered, and with no default: refused, saying which model it records.
    const elsewhere = await fauxControlledAgent([], { faux: { provider: "other" }, sessions, noDefaultModel: true });
    expect(await elsewhere.control.sessions.get("s1").state()).not.toHaveProperty("model");
    const refused = await drain(elsewhere.agent.invoke({ session: "s1" }, { text: "again" }));
    expect(refused.at(-1)).toMatchObject({ type: "failed", code: MISSING_MODEL_CODE });
    expect((refused.at(-1) as { details: string }).details).toContain(`the model it records, ${spec}, is not one`);
    // Compaction is a model call on the session's model: refused with the same code, the same fix applies.
    expect(await elsewhere.control.sessions.get("s1").compact()).toMatchObject({
      ok: false,
      error: { code: MISSING_MODEL_CODE, retryable: false },
    });
  });

  it("createPiAgentFromDir opens a directory whose config sets no model, with its session control", async () => {
    vi.stubEnv("FASTAGENT_MODEL", undefined);
    const dir = await mkdtemp(join(tmpdir(), "fa-no-model-"));
    await mkdir(join(dir, "agent"));
    await writeFile(join(dir, "agent", "fastagent.config.ts"), "export default {};");
    const opened = await createPiAgentFromDir(dir, { sessionControl: true });
    expect(opened.modelSpec).toBeUndefined();
    expect(opened.sessionControl).toBeDefined();
    expect(await opened.sessionControl?.sessions.list()).toEqual([]);
  });
});
