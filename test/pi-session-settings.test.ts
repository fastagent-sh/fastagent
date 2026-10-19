/**
 * What a pi session is set to through SPEC v1 (session-settings.ts, applyProperties, startCompaction): the model and
 * thinking level a run will execute on, which `read()`'s state, `update()`'s check and the run itself all resolve
 * through one function; moving the branch head with `rewind`; and compaction. Pure resolver cases are asserted on
 * `resolveSessionSettings` directly.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type FauxResponseStep,
  Type,
  clampThinkingLevel,
  fauxAssistantMessage,
  fauxToolCall,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { fastagentCredentialStore } from "../src/harnesses/pi/auth.ts";
import { piLoopHarness } from "../src/harnesses/pi/loop-harness.ts";
import { type AnyModel, createPiModelRuntime } from "../src/harnesses/pi/models.ts";
import { piSessionBinder } from "../src/harnesses/pi/session-binding.ts";
import {
  activePath,
  describeModels,
  lastOverrideEntries,
  resolveSessionSettings,
} from "../src/harnesses/pi/session-settings.ts";
import { piInMemorySessionRecordStore } from "../src/harnesses/pi/session-store.ts";
import { loopPort } from "../src/loop-port.ts";
import type { Agent, Entry, SessionState } from "../src/protocol.ts";
import { collect } from "../src/protocol-collect.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { fauxAgent } from "./agent.ts";
import { makeFaux } from "./faux.ts";

const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo back the input",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: (params as { value: string }).value }], details: {} };
  },
};

/** An answer long enough that a few exceed pi's keep-recent window (~20k tokens): below it nothing is summarizable. */
const LONG_ANSWER = "the quick brown fox jumps over the lazy dog ".repeat(1200);

async function stateOf(agent: Agent, sessionId: string): Promise<SessionState> {
  const read = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (!read.ok) throw new Error(read.error.message);
  return read.state;
}
async function entries(agent: Agent, sessionId: string): Promise<Entry[]> {
  const read = await agent.sessions.get(sessionId).read({ limit: 500 });
  if (!read.ok) throw new Error(read.error.message);
  return read.entries;
}
const ask = (agent: Agent, sessionId: string, text = "go") => collect(agent.invoke({ sessionId, prompt: { text } }));
async function created(agent: Agent, sessionId: string): Promise<void> {
  expect(await agent.sessions.create({ sessionId })).toMatchObject({ ok: true });
}
/** A reasoning-capable model: thinking levels are answered per model, and the default faux supports only "off". */
const THINKER = { faux: { models: [{ id: "faux-thinker", reasoning: true }] } };
const TWO_MODELS = { faux: { models: [{ id: "thinker", reasoning: true }, { id: "plain" }] } };

describe("models and thinking levels", () => {
  it("models() describes every model a session may be set to, with the levels its state then reports", async () => {
    const { agent, faux } = fauxAgent([], THINKER);
    const spec = `${faux.getModel().provider}/${faux.getModel().id}`;
    const models = await agent.models();
    const specs = models.map((model) => model.spec);
    expect(specs).toEqual([...specs].sort());
    const described = models.find((model) => model.spec === spec);
    expect(described?.thinkingLevels).toContain("high");
    await created(agent, "sCaps");
    expect((await stateOf(agent, "sCaps")).thinkingLevels).toEqual(described?.thinkingLevels);
    // A model that declares no name or context window (an extension's virtual model: pi reads the window as 0) leaves
    // the fields out rather than inventing them.
    const bare = { provider: "router", id: "bare", api: "pi-virtual", reasoning: false, contextWindow: 0 };
    expect(describeModels([bare as unknown as AnyModel])).toStrictEqual([
      { spec: "router/bare", thinkingLevels: ["off"] },
    ]);
  });

  it("a new session reports its first run's settings, takes others, and its first run runs on them", async () => {
    const ran: { reasoning?: string; model: string }[] = [];
    const answer: FauxResponseStep = (_context, options, _state, model) => {
      ran.push({ ...(options?.reasoning ? { reasoning: options.reasoning } : {}), model: model.id });
      return fauxAssistantMessage("done");
    };
    const { agent, faux } = fauxAgent([answer, answer], { ...TWO_MODELS, thinkingLevel: "max" });
    const plain = `${faux.getModel("plain")?.provider}/plain`;
    await created(agent, "sFresh");
    // The defaults, the level clamped to the model: the agent's default is above what the model supports.
    const before = await stateOf(agent, "sFresh");
    expect(before.model).toBe(`${faux.getModel()?.provider}/thinker`);
    expect(before.thinkingLevel).not.toBe("max");
    expect(before.thinkingLevel).toBe(before.thinkingLevels?.at(-1));

    expect(await agent.sessions.get("sFresh").update({ thinkingLevel: "low", name: "draft" })).toEqual({ ok: true });
    expect(await agent.sessions.list()).toContainEqual(expect.objectContaining({ sessionId: "sFresh", name: "draft" }));
    await created(agent, "sOther");
    expect(await agent.sessions.get("sOther").update({ model: plain })).toEqual({ ok: true });
    await ask(agent, "sFresh");
    await ask(agent, "sOther");
    expect(ran).toEqual([{ reasoning: "low", model: "thinker" }, { model: "plain" }]);
  });

  it("a refused patch writes nothing", async () => {
    const { agent, sessions } = fauxAgent([], THINKER); // faux-thinker: no "max"
    await created(agent, "sGhost");
    const size = async () => (await sessions.openIfExists("sGhost"))?.getEntries().length;
    const before = await size();
    for (const patch of [
      { thinkingLevel: "max" },
      { thinkingLevel: "loud" },
      { model: "faux/missing" },
      { name: " " },
    ]) {
      expect(await agent.sessions.get("sGhost").update(patch), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    expect(await size()).toBe(before);
  });

  it("a session updated before its first run: compact writes nothing, its own setting stands, delete removes it", async () => {
    const { agent, sessions } = fauxAgent([], THINKER);
    await created(agent, "sDraft");
    expect(await agent.sessions.get("sDraft").update({ thinkingLevel: "low" })).toEqual({ ok: true });
    const written = (await sessions.openIfExists("sDraft"))?.getEntries().length;
    // Binding would record the model and level on a session with no messages: refused before it, nothing is written.
    expect(await agent.sessions.get("sDraft").compact()).toMatchObject({
      ok: false,
      error: { code: "nothing_to_compact" },
    });
    expect((await sessions.openIfExists("sDraft"))?.getEntries().length).toBe(written);
    expect((await stateOf(agent, "sDraft")).thinkingLevel).toBe("low");
    expect(await agent.sessions.get("sDraft").delete()).toEqual({ ok: true });
    expect(await sessions.openIfExists("sDraft")).toBeUndefined();
  });

  it("the levels are the MODEL's: a non-reasoning model offers only off, and a level it lacks is refused", async () => {
    const { agent } = fauxAgent([]); // default faux: reasoning false
    await created(agent, "sNR");
    expect((await stateOf(agent, "sNR")).thinkingLevels).toEqual(["off"]);
    // The lie this replaces: ok, a durable entry, and no effect on the run.
    expect(await agent.sessions.get("sNR").update({ thinkingLevel: "high" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(
      (await entries(agent, "sNR")).some((e) => e.kind === "settings_changed" && "thinkingLevel" in (e.data as object)),
    ).toBe(false);
    expect(await agent.sessions.get("sNR").update({ thinkingLevel: "off" })).toEqual({ ok: true });

    // A reasoning model answers the same way about a level it has no mapping for (xhigh/max need one).
    const reasoning = fauxAgent([], THINKER);
    await created(reasoning.agent, "sMax");
    expect((await stateOf(reasoning.agent, "sMax")).thinkingLevels).not.toContain("max");
    expect(await reasoning.agent.sessions.get("sMax").update({ thinkingLevel: "max" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("after a model is set, the SESSION's model decides the levels: state and the update check agree", async () => {
    const { agent, faux } = fauxAgent([], { ...TWO_MODELS, modelId: "thinker" });
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    await created(agent, "sAuth");
    expect(await agent.sessions.get("sAuth").update({ model: `${plain.provider}/${plain.id}` })).toEqual({ ok: true });
    const after = await stateOf(agent, "sAuth");
    expect(after.model).toBe(`${plain.provider}/${plain.id}`);
    expect(after.thinkingLevels).toEqual(["off"]);
    expect(await agent.sessions.get("sAuth").update({ thinkingLevel: "high" })).toMatchObject({ ok: false });
  });

  it("a multi-field patch applies together; one that fails its check leaves everything as it was", async () => {
    const { agent, faux } = fauxAgent([], { ...TWO_MODELS, modelId: "plain" });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const spec = `${thinker.provider}/${thinker.id}`;
    await created(agent, "sPatch");
    expect(
      await agent.sessions.get("sPatch").update({ model: spec, thinkingLevel: "high", name: "Both at once" }),
    ).toEqual({ ok: true });
    expect(await stateOf(agent, "sPatch")).toMatchObject({ model: spec, thinkingLevel: "high", name: "Both at once" });
    expect(await agent.sessions.get("sPatch").update({ name: "changed", model: "nope/nothing" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect((await stateOf(agent, "sPatch")).name).toBe("Both at once");
  });

  it("a patch that fails BETWEEN writes says what landed: it cannot claim a rollback pi has no way to do", async () => {
    const { agent, sessions } = fauxAgent([], THINKER);
    await created(agent, "sPartial");
    const record = await sessions.openIfExists("sPartial");
    if (!record) throw new Error("no record");
    // The name is written LAST; failing it leaves the thinking level durable.
    const appendName = vi.spyOn(record, "appendSessionInfo").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const result = await agent.sessions.get("sPartial").update({ thinkingLevel: "high", name: "never lands" });
    appendName.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "partial_update", message: expect.stringMatching(/applied thinkingLevel/), retryable: false },
    });
    const state = await stateOf(agent, "sPartial");
    expect(state.thinkingLevel).toBe("high");
    expect(state.name).toBeUndefined();
  });

  it("a recorded level the session's new model cannot do is not what runs, and comes back with a model that can", async () => {
    const { agent, sessions, faux, models } = fauxAgent([], { ...TWO_MODELS, modelId: "thinker" });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    await created(agent, "sOne");
    expect(await agent.sessions.get("sOne").update({ thinkingLevel: "high" })).toEqual({ ok: true });
    expect(await agent.sessions.get("sOne").update({ model: `${plain.provider}/${plain.id}` })).toEqual({ ok: true });

    const recorded = ((await sessions.openIfExists("sOne"))?.getEntries() ?? []) as Parameters<
      typeof resolveSessionSettings
    >[0];
    const executed = resolveSessionSettings(recorded, await models(), { model: thinker, thinkingLevel: "medium" });
    // The record keeps the PREFERENCE; every surface agrees on what actually happens.
    expect(lastOverrideEntries(recorded).thinkingLevel).toBe("high");
    expect((await stateOf(agent, "sOne")).thinkingLevel).toBe("off");
    expect(executed?.thinkingLevel).toBe("off");
    expect(await agent.sessions.get("sOne").update({ thinkingLevel: "high" })).toMatchObject({ ok: false });
    // Back to a capable model: the preference returns, unsent.
    expect(await agent.sessions.get("sOne").update({ model: `${thinker.provider}/${thinker.id}` })).toEqual({
      ok: true,
    });
    expect((await stateOf(agent, "sOne")).thinkingLevel).toBe("high");
  });

  it("state reports what will RUN, the defaults named, and the override rides the next run end to end", async () => {
    const answerWithTheModelAsked: FauxResponseStep = (_ctx, _opts, _state, model) =>
      fauxAssistantMessage(`answered by ${model.id}`);
    const { agent, faux } = fauxAgent([answerWithTheModelAsked, answerWithTheModelAsked], {
      faux: { models: [{ id: "faux-a" }, { id: "faux-b" }] },
      modelId: "faux-a",
    });
    expect((await ask(agent, "sE2E", "hi")).text).toBe("answered by faux-a");
    expect(await stateOf(agent, "sE2E")).toMatchObject({ model: `${faux.provider.id}/faux-a`, thinkingLevel: "off" });
    expect(await agent.sessions.get("sE2E").update({ model: `${faux.provider.id}/faux-b` })).toEqual({ ok: true });
    expect((await entries(agent, "sE2E")).filter((e) => e.kind === "settings_changed").at(-1)?.data).toEqual({
      model: `${faux.provider.id}/faux-b`,
    });
    expect((await ask(agent, "sE2E", "again")).text).toBe("answered by faux-b");
  });

  it("a real provider's default level is what a rebound session runs on, after a move back to its model entry", async () => {
    for (const [provider, thinkingLevel] of [
      ["openai", "off"],
      ["openai", "minimal"],
      ["openai-codex", "off"],
    ] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "fa-astra-thinking-"));
      try {
        const modelRuntime = await createPiModelRuntime({
          credentials: fastagentCredentialStore(join(cwd, "auth.json")),
        });
        const model = modelRuntime.getModel(provider, "gpt-6-astra");
        expect(model).toBeDefined();
        const sessions = piInMemorySessionRecordStore({ cwd });
        const binding = {
          createModelRuntime: async () => modelRuntime,
          modelSpec: `${model?.provider}/${model?.id}`,
          thinkingLevel,
          tools: [],
          cwd,
          readDefinition: () => ({ systemPrompt: "test", skills: [] }),
        };
        const bind = piSessionBinder(binding);
        const agent = servingAgent(
          loopPort(piLoopHarness({ ...binding, sessions, catalog: async () => modelRuntime })),
        );
        // Binding records the model a new session starts on.
        (await bind("astra", await sessions.openOrCreate("astra"))).dispose();
        const modelEntry = (await entries(agent, "astra")).find(
          (e) => e.kind === "settings_changed" && "model" in (e.data as object),
        );
        expect(modelEntry).toBeDefined();
        expect(await agent.sessions.get("astra").rewind(modelEntry?.id as string)).toEqual({ ok: true });
        const reported = await stateOf(agent, "astra");
        const rebound = await bind("astra", (await sessions.openIfExists("astra")) as never);
        try {
          expect(reported.thinkingLevel, `${provider}/${thinkingLevel}`).toBe(rebound.thinkingLevel);
          expect(reported.thinkingLevels).toContain(reported.thinkingLevel);
        } finally {
          rebound.dispose();
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });
});

describe("the resolver", () => {
  it("a cut parent chain is refused, so every reader of the path refuses it alike", () => {
    const cut = [{ id: "leaf", parentId: "pruned", type: "message", timestamp: new Date().toISOString(), message: {} }];
    const record = { getBranch: () => cut } as unknown as Parameters<typeof activePath>[0];
    expect(() => activePath(record)).toThrow(/missing from the journal/);
  });

  it("still clamps as a BACKSTOP: a level recorded for a model the session then left", () => {
    const { faux, models } = makeFaux(TWO_MODELS.faux);
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    const out = resolveSessionSettings(
      [
        { type: "thinking_level_change", thinkingLevel: "high" },
        { type: "model_change", provider: plain.provider, modelId: plain.id },
      ],
      models,
      { model: thinker, thinkingLevel: "low" },
    );
    expect(out?.model).toBe(plain);
    expect(out?.thinkingLevel).toBe("off");
  });

  it("the clamp we borrow resolves a GAP upward, not down", () => {
    // A cost increase, not a conservative degrade, and invisible in what the faux registry can express, so it is
    // pinned against pi directly: an upstream change to the direction fails here.
    const gapped = {
      provider: "probe",
      id: "gapped",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null },
    } as unknown as Parameters<typeof clampThinkingLevel>[0];
    expect(getSupportedThinkingLevels(gapped)).toEqual(["off", "high"]);
    expect(clampThinkingLevel(gapped, "low")).toBe("high");
    expect(clampThinkingLevel(gapped, "xhigh")).toBe("high");
  });

  it("a known override wins, the last entry wins, an unknown one falls back", () => {
    const two = makeFaux({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
    const base = { model: two.faux.getModel("faux-a") as AnyModel, thinkingLevel: "medium" as const };
    const recorded = two.faux.getModel("faux-b") as AnyModel;
    expect(
      resolveSessionSettings(
        [{ type: "model_change", provider: recorded.provider, modelId: recorded.id }],
        two.models,
        base,
      )?.model,
    ).toBe(recorded);

    const { faux, models } = makeFaux({ models: [{ id: "faux-thinker", reasoning: true }] });
    const fallback = { model: faux.getModel() as AnyModel, thinkingLevel: "medium" as const };
    const out = resolveSessionSettings(
      [
        { type: "model_change", provider: "gone", modelId: "nope" },
        { type: "thinking_level_change", thinkingLevel: "low" },
      ],
      models,
      fallback,
    );
    expect(out?.model).toBe(fallback.model);
    expect(out?.thinkingLevel).toBe("low");
    expect(
      resolveSessionSettings([{ type: "thinking_level_change", thinkingLevel: "ultra" }], models, fallback)
        ?.thinkingLevel,
    ).toBe("medium");
  });

  it("a malformed override record reads as ABSENT on both surfaces, never skipped over", () => {
    const { faux, models } = makeFaux({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
    const fallback = { model: faux.getModel("faux-a") as AnyModel, thinkingLevel: "medium" as const };
    const recorded = [
      { type: "model_change", provider: faux.provider.id, modelId: "faux-b" }, // an earlier, VALID override
      { type: "model_change" }, // the LAST record is malformed
    ];
    expect(resolveSessionSettings(recorded, models, fallback)?.model).toBe(fallback.model);
    expect(lastOverrideEntries(recorded).model).toBeUndefined();
  });
});

describe("rewind", () => {
  it("moves the branch head, so the NEXT run continues the branch it was moved to", async () => {
    let thirdRunContext = "";
    const { agent } = fauxAgent([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      (context) => {
        thirdRunContext = JSON.stringify(context.messages.filter((message) => message.role !== "system"));
        return fauxAssistantMessage("three");
      },
    ]);
    await ask(agent, "sNav", "first");
    await ask(agent, "sNav", "second");
    const before = await entries(agent, "sNav");
    const target = before.find((e) => e.kind === "assistant_message") as Entry;
    expect(await agent.sessions.get("sNav").rewind(target.id)).toEqual({ ok: true });
    expect((await stateOf(agent, "sNav")).leafEntryId).toBe(target.id);
    await ask(agent, "sNav", "third");
    const after = await entries(agent, "sNav");
    expect(after.map((e) => e.id)).toEqual(expect.arrayContaining(before.map((e) => e.id))); // nothing deleted
    expect(thirdRunContext).toContain("first");
    expect(thirdRunContext).toContain("third");
    expect(thirdRunContext).not.toContain("second");
  });

  it("a setting recorded on a branch the session LEFT does not follow it back", async () => {
    let ranWith: string | undefined;
    const { agent, faux } = fauxAgent(
      [
        fauxAssistantMessage("one"),
        (_context, _options, _state, model) => {
          ranWith = model.id;
          return fauxAssistantMessage("two");
        },
      ],
      { faux: { models: [{ id: "default-model" }, { id: "other-model" }] }, modelId: "default-model" },
    );
    const other = faux.getModel("other-model") as AnyModel;
    const dflt = faux.getModel("default-model") as AnyModel;
    await ask(agent, "sNavLeak", "hi");
    const target = (await entries(agent, "sNavLeak")).find((e) => e.kind === "user_message") as Entry;
    expect(await agent.sessions.get("sNavLeak").update({ model: `${other.provider}/${other.id}` })).toEqual({
      ok: true,
    });
    expect((await stateOf(agent, "sNavLeak")).model).toBe(`${other.provider}/${other.id}`);
    // Back to a point BEFORE the override was recorded: it is off the active path now.
    expect(await agent.sessions.get("sNavLeak").rewind(target.id)).toEqual({ ok: true });
    expect((await stateOf(agent, "sNavLeak")).model).toBe(`${dflt.provider}/${dflt.id}`);
    await ask(agent, "sNavLeak", "again");
    expect(ranWith).toBe(dflt.id); // the RUN agrees with what state reports
  });

  it("onto an answer whose tool result is now off the branch, the next run still runs", async () => {
    // A move writes no message, but it can EXPOSE a dangling tool call. Nothing here repairs it: pi-ai pairs it at
    // request time (session-store.test.ts pins that), so the next run only has to run.
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("echo", { value: "hi" }, { id: "e1" })),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("after the move"),
      ],
      { tools: [echoTool] },
    );
    await ask(agent, "sNavDangle", "call it");
    const call = (await entries(agent, "sNavDangle")).find(
      (e) => e.kind === "assistant_message" && (e.data as { toolCalls?: unknown[] }).toolCalls,
    ) as Entry;
    expect(await agent.sessions.get("sNavDangle").rewind(call.id)).toEqual({ ok: true });
    expect((await ask(agent, "sNavDangle", "continue")).text).toBe("after the move");
  });

  it("to where the head already is writes nothing; the bookkeeping a move writes is never published", async () => {
    const { agent, sessions, faux } = fauxAgent([fauxAssistantMessage("ok")]);
    await ask(agent, "sNavNoop", "hi");
    const leaf = (await stateOf(agent, "sNavNoop")).leafEntryId as string;
    const size = async () => ((await sessions.openIfExists("sNavNoop"))?.getEntries() ?? []).length;
    const before = await size();
    expect(await agent.sessions.get("sNavNoop").rewind(leaf)).toEqual({ ok: true });
    expect(await size()).toBe(before);

    // Move away, then back onto a settings record: a legitimate target, the harness leaves the head on one after
    // every model update. A move does write one record (pi's branch() is a pointer move that survives nothing), and
    // that anchor is ours: everything a client sees is still a position it can move to.
    expect(
      await agent.sessions.get("sNavNoop").update({ model: `${faux.getModel().provider}/${faux.getModel().id}` }),
    ).toEqual({ ok: true });
    const published = await entries(agent, "sNavNoop");
    const settings = published.filter((e) => e.kind === "settings_changed").at(-1) as Entry;
    const user = published.find((e) => e.kind === "user_message") as Entry;
    expect(await agent.sessions.get("sNavNoop").rewind(user.id)).toEqual({ ok: true });
    expect(await agent.sessions.get("sNavNoop").rewind(settings.id)).toEqual({ ok: true });
    const raw = (await sessions.openIfExists("sNavNoop"))?.getEntries() ?? [];
    const ids = new Set((await entries(agent, "sNavNoop")).map((e) => e.id));
    const withheld = raw.filter((e) => !ids.has(e.id));
    expect(withheld.some((e) => (e as { customType?: string }).customType === "fastagent.leaf")).toBe(true);
    // The published tree is self-contained: a client walking up from the head reaches the root.
    expect(
      (await entries(agent, "sNavNoop")).every((e) => e.parentEntryId === undefined || ids.has(e.parentEntryId)),
    ).toBe(true);
    expect((await stateOf(agent, "sNavNoop")).leafEntryId).toBe(settings.id);
  });
});

describe("compaction", () => {
  /** Enough runs that the session has history BEHIND the keep-recent window. */
  async function compactable(agent: Agent, sessionId: string, runs = 3): Promise<void> {
    for (let i = 0; i < runs; i++) await ask(agent, sessionId, `turn ${i}`);
  }

  it("writes a compaction entry, and bounds the model's context, not the session's settings", async () => {
    const { agent } = fauxAgent(
      Array.from({ length: 8 }, () => fauxAssistantMessage(LONG_ANSWER)),
      THINKER,
    );
    await ask(agent, "sCompact", "tell me things");
    expect(await agent.sessions.get("sCompact").update({ thinkingLevel: "high" })).toEqual({ ok: true });
    await compactable(agent, "sCompact");
    expect(await agent.sessions.get("sCompact").compact()).toEqual({ ok: true });
    expect((await entries(agent, "sCompact")).find((e) => e.kind === "compaction")?.data).toMatchObject({
      summary: expect.any(String),
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) }, // the summarizing calls' cost
    });
    expect(await stateOf(agent, "sCompact")).toMatchObject({ status: "idle", thinkingLevel: "high" });
  });

  it("nothing to compact on a record a real run wrote is refused before anything starts", async () => {
    // On a record a REAL run wrote: since pi 0.86 the journal leads with the assembled prompt as a `system` entry,
    // before the first cut point, so a hand-written record is the one shape that cannot observe the gate counting it.
    const { agent, sessions } = fauxAgent([fauxAssistantMessage("short answer")]);
    await ask(agent, "sEmpty", "hi");
    const before = (await sessions.openIfExists("sEmpty"))?.getEntries().length;
    expect(await agent.sessions.get("sEmpty").compact()).toMatchObject({
      ok: false,
      error: { code: "nothing_to_compact", retryable: false },
    });
    expect((await sessions.openIfExists("sEmpty"))?.getEntries().length).toBe(before);
  });

  it("admits every history shape the coding-agent journal writes", async () => {
    for (const shape of ["retained", "missing-kept", "split"]) {
      const requests: string[] = [];
      const { agent, sessions } = fauxAgent(
        Array.from({ length: 4 }, () => (context: { messages: unknown[] }) => {
          requests.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("compact summary");
        }) as FauxResponseStep[],
        THINKER,
      );
      const record = await sessions.openOrCreate("compact-shape");
      record.appendModelChange("faux", "faux-thinker");
      record.appendThinkingLevelChange("high");
      record.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
      const kept = record.appendCustomEntry("metadata", {});
      record.appendMessage({ role: "user", content: "carry-over", timestamp: 2 });
      record.appendMessage(fauxAssistantMessage(LONG_ANSWER));
      if (shape !== "split") {
        record.appendCompaction("previous summary", shape === "retained" ? kept : "missing", 100000);
        if (shape === "missing-kept") {
          record.appendMessage({ role: "user", content: "after-boundary", timestamp: 3 });
          record.appendMessage(fauxAssistantMessage(LONG_ANSWER));
        }
        record.appendMessage({ role: "user", content: "recent", timestamp: 4 });
      }
      record.appendMessage(fauxAssistantMessage(LONG_ANSWER));
      record.appendThinkingLevelChange("low");
      record.appendMessage(fauxAssistantMessage(LONG_ANSWER));

      expect(await agent.sessions.get("compact-shape").compact(), shape).toEqual({ ok: true });
      expect(
        (await entries(agent, "compact-shape")).filter((e) => e.kind === "compaction").at(-1)?.data,
        shape,
      ).toMatchObject({
        summary: expect.stringContaining("compact summary"),
      });
      expect(requests.join(" "), shape).toContain(shape === "missing-kept" ? "after-boundary" : "carry-over");
      if (shape !== "split") expect(requests.join(" "), shape).not.toContain("discarded");
      expect(await agent.sessions.get("compact-shape").compact(), shape).toMatchObject({
        ok: false,
        error: { code: "nothing_to_compact" },
      });
    }
  });

  it("reads what the model sees: context edits count as pi counts them", async () => {
    // pi 0.87 omits an abandoned retry/overflow attempt with a `context_edit` and computes its cut over the
    // projection: refuse where pi finds nothing, accept where it summarizes.
    for (const shape of ["omitted-only", "recovery-tail"]) {
      const { agent, sessions } = fauxAgent(
        Array.from({ length: 4 }, () => fauxAssistantMessage("compact summary")),
        THINKER,
      );
      const record = await sessions.openOrCreate("edited");
      record.appendModelChange("faux", "faux-thinker");
      record.appendMessage({ role: "user", content: "old", timestamp: 1 });
      record.appendMessage(fauxAssistantMessage("old answer"));
      record.appendCompaction("previous summary", null, 100); // retains nothing
      if (shape === "omitted-only") {
        // Only the omitted attempt is large, so the visible history fits the keep-recent window.
        record.appendMessage({ role: "user", content: "question", timestamp: 2 });
        record.appendContextEdit(record.appendMessage(fauxAssistantMessage(LONG_ANSWER.repeat(3))), null);
        record.appendMessage(fauxAssistantMessage("final"));
        expect(await agent.sessions.get("edited").compact(), shape).toMatchObject({
          ok: false,
          error: { code: "nothing_to_compact" },
        });
      } else {
        // An input too large to keep, then only its abandoned attempt: pi moves the cut past the attempt, so the input
        // is summarized as a turn prefix.
        record.appendMessage({ role: "user", content: LONG_ANSWER.repeat(3), timestamp: 2 });
        record.appendContextEdit(record.appendMessage(fauxAssistantMessage("cut off")), null);
        expect(await agent.sessions.get("edited").compact(), shape).toEqual({ ok: true });
      }
    }
  });

  it("a truncated summary or a failed model call writes no compaction entry, and the session goes on", async () => {
    const truncated = fauxAgent([
      ...Array.from({ length: 3 }, () => fauxAssistantMessage(LONG_ANSWER)),
      ...Array.from({ length: 4 }, () => ({ ...fauxAssistantMessage("incomplete"), stopReason: "length" as const })),
    ]);
    await compactable(truncated.agent, "truncated");
    const before = (await truncated.sessions.openIfExists("truncated"))?.getEntries();
    expect(await truncated.agent.sessions.get("truncated").compact()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("summary is incomplete") },
    });
    expect((await truncated.sessions.openIfExists("truncated"))?.getEntries()).toEqual(before);

    // Exactly enough answers for the history: the summarization call then finds the faux queue empty.
    const failing = fauxAgent(
      Array.from({ length: 3 }, () => fauxAssistantMessage(LONG_ANSWER)),
      THINKER,
    );
    await compactable(failing.agent, "failing");
    expect(await failing.agent.sessions.get("failing").compact()).toMatchObject({ ok: false });
    expect((await entries(failing.agent, "failing")).map((e) => e.kind)).not.toContain("compaction");
    expect(await stateOf(failing.agent, "failing")).toMatchObject({ status: "idle" });
    expect(await failing.agent.sessions.get("failing").update({ thinkingLevel: "low" })).toEqual({ ok: true });
  });

  it("is compacting while in flight, and abort stops it with nothing written", async () => {
    const { agent } = fauxAgent(
      [
        // Exactly the history's answers: the next model call is the summarization, which hangs until aborted.
        ...Array.from({ length: 3 }, () => fauxAssistantMessage(LONG_ANSWER)),
        // The summarization call hangs until aborted. Checked up front too: the abort may land before this runs.
        (async (_c: unknown, o: { signal?: AbortSignal } | undefined) => {
          await new Promise<never>((_resolve, reject) => {
            const bail = () => reject(new Error("summarization aborted"));
            if (o?.signal?.aborted) return bail();
            o?.signal?.addEventListener("abort", bail, { once: true });
          });
          return fauxAssistantMessage("unreachable");
        }) as never,
      ],
      THINKER,
    );
    await compactable(agent, "sAbort");
    const compacting = agent.sessions.get("sAbort").compact();
    for (let i = 0; i < 200 && (await stateOf(agent, "sAbort")).status !== "compacting"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await stateOf(agent, "sAbort")).status).toBe("compacting");
    expect(await agent.sessions.get("sAbort").abort()).toMatchObject({ ok: true, stopped: { compaction: true } });
    expect(await compacting).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "the compaction was stopped by abort" }),
    });
    expect((await entries(agent, "sAbort")).map((e) => e.kind)).not.toContain("compaction");
    expect(await stateOf(agent, "sAbort")).toMatchObject({ status: "idle" });
  });
});
