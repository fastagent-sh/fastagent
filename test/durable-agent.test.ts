import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { type DurableAgent, openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { agentApiConformance } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";

agentApiConformance("pi-durable, in process", durableSubject());

const context = BACKGROUND_CONTEXT;

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, model: { provider: model.provider, modelId: model.id } };
}

const temporaryStorage = () => join(mkdtempSync(join(tmpdir(), "fastagent-durable-")), "agent.sqlite");

describe("the Agent on pi-durable", () => {
  it("answers not_found for an id from another storage, which pi-durable numbers the same", async () => {
    const { models } = fauxModels();
    const open = async () =>
      openDurableAgent({
        storage: await openNodeSqliteStorage(temporaryStorage()),
        models,
        registry: createRegistry(),
        name: "ids",
      });
    const [one, two] = [await open(), await open()];
    const created = await one.createSession();
    await two.createSession();
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(await two.read(created.sessionId)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await one.read(created.sessionId)).toMatchObject({ ok: true });
    await Promise.all([one.close(), two.close()]);
  });

  it("takes a message a failed run left waiting when the process before it stopped", async () => {
    const path = temporaryStorage();
    const { faux, models, model } = fauxModels();
    let failNow = () => {};
    const failing = new Promise<void>((resolve) => {
      failNow = resolve;
    });
    faux.setResponses([
      async () => {
        await failing;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model refused the request" });
      },
      fauxAssistantMessage("answer: later"),
    ]);
    const before = await Harness.open(
      await openNodeSqliteStorage(path),
      { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } },
      context,
    );
    const conversation = await before.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model } },
      context,
    );
    const failed = await conversation.submit({ type: "input", content: "fail" }, context);
    const waiting = await conversation.submit({ type: "input", content: "later" }, context);
    failNow();
    expect((await failed.wait(context)).status).toBe("unanswered");
    // pi-durable 1.3.0 leaves it queued: the reason release.ts exists.
    expect((await waiting.status(context)).status).toBe("queued");
    await before.close(context);

    const agent = await openDurableAgent({
      storage: await openNodeSqliteStorage(path),
      models,
      registry: createRegistry(),
      name: "release",
    });
    const handle = await agent.harness.submission(waiting.id, context);
    expect(await handle?.wait(context)).toMatchObject({ status: "done" });
    await agent.close();
  });

  it("answers with a session's own model, and with the deployment's default only when it has none", async () => {
    const path = temporaryStorage();
    const faux = fauxProvider({ models: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    faux.setResponses(
      Array.from(
        { length: 20 },
        () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) =>
          fauxAssistantMessage(`from ${model.id}`),
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const ref = (modelId: string) => ({ provider: faux.getModel().provider, modelId });
    const open = async (modelId: string, thinkingLevel: "low" | "high") =>
      openDurableAgent({
        storage: await openNodeSqliteStorage(path),
        models,
        registry: createRegistry(),
        name: "defaults",
        model: ref(modelId),
        thinkingLevel,
      });
    const session = async (agent: DurableAgent) => {
      const created = await agent.createSession();
      if (!created.ok) throw new Error(JSON.stringify(created));
      return created.sessionId;
    };
    const answer = async (agent: DurableAgent, sessionId: string) => {
      const receipt = await agent.invoke({ sessionId, content: [{ type: "text", text: "which?" }] });
      if (!receipt.ok) throw new Error(JSON.stringify(receipt));
      const end = await receipt.wait();
      if (!end.ok) throw new Error(end.unfinished.reason);
      return end.message.answer?.text;
    };
    const settings = async (agent: DurableAgent, sessionId: string) =>
      agent.harness.snapshot(AgentDoc, (await agent.conversation(sessionId))?.id as never, context);

    let agent = await open("a", "low");
    const first = await session(agent);
    expect(await answer(agent, first)).toBe("from a");
    await agent.close();

    agent = await open("b", "high");
    expect(await answer(agent, first)).toBe("from a");
    expect(await settings(agent, first)).toMatchObject({ thinkingLevel: "low" });
    const second = await session(agent);
    expect(await answer(agent, second)).toBe("from b");
    expect(await settings(agent, second)).toMatchObject({ thinkingLevel: "high" });
    await (await agent.conversation(first))?.configure({ model: ref("c") }, context);
    expect(await answer(agent, first)).toBe("from c");
    await agent.close();
  });

  it("creates a session with its chosen model and thinking level in the creating commit, kept after restart", async () => {
    const path = temporaryStorage();
    const faux = fauxProvider({ models: [{ id: "default" }, { id: "chosen" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const ref = (modelId: string) => ({ provider: faux.getModel().provider, modelId });
    const open = async () =>
      openDurableAgent({
        storage: await openNodeSqliteStorage(path),
        models,
        registry: createRegistry(),
        name: "creation",
        model: ref("default"),
        thinkingLevel: "high",
      });
    let agent = await open();
    const chosen = { model: ref("chosen"), thinkingLevel: "off" as const };
    const commits: unknown[] = [];
    const unsubscribe = agent.harness.subscribeCommits(({ changes }) => {
      if (changes.some((change) => change.type === "conversation")) {
        commits.push(
          changes.flatMap((change) =>
            change.type === "document" && change.record.kind === "pi.agent" ? [change.value] : [],
          ),
        );
      }
    });
    const created = await agent.createSession(chosen);
    unsubscribe();
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(commits).toEqual([[chosen]]);
    const conversation = await agent.conversation(created.sessionId);
    if (conversation === undefined) throw new Error("The created session has no conversation");
    expect(await agent.harness.snapshot(AgentDoc, conversation.id, context)).toEqual(chosen);
    await agent.close();

    agent = await open();
    faux.setResponses([
      (_context, options, _state, model) => {
        expect(model.id).toBe("chosen");
        expect(options?.reasoning).toBeUndefined();
        return fauxAssistantMessage("chosen answer");
      },
    ]);
    const receipt = await agent.invoke({ sessionId: created.sessionId, content: [{ type: "text", text: "hi" }] });
    if (!receipt.ok) throw new Error(JSON.stringify(receipt));
    expect(await receipt.wait()).toMatchObject({ ok: true, message: { answer: { text: "chosen answer" } } });
    expect(await agent.harness.snapshot(AgentDoc, conversation.id, context)).toEqual(chosen);
    await agent.close();
  });

  it("forks with chosen settings over the source's settings, including an empty source, without changing the source", async () => {
    const { faux, models, model } = fauxModels();
    const agent = await openDurableAgent({
      storage: await openNodeSqliteStorage(temporaryStorage()),
      models,
      registry: createRegistry(),
      name: "fork settings",
    });
    const original = { model, thinkingLevel: "high" as const };
    const created = await agent.createSession(original);
    if (!created.ok) throw new Error(JSON.stringify(created));
    const source = await agent.conversation(created.sessionId);
    if (source === undefined) throw new Error("The created session has no conversation");
    const replacement = { provider: "another", modelId: "chosen" };
    const cases = [
      { options: {}, expected: original },
      { options: { model: replacement }, expected: { ...original, model: replacement } },
      { options: { thinkingLevel: "off" as const }, expected: { ...original, thinkingLevel: "off" } },
      {
        options: { model: replacement, thinkingLevel: "max" as const },
        expected: { model: replacement, thinkingLevel: "max" },
      },
    ];
    for (const populated of [false, true]) {
      if (populated) {
        faux.setResponses([fauxAssistantMessage("source answer")]);
        const receipt = await agent.invoke({ sessionId: created.sessionId, content: [{ type: "text", text: "hi" }] });
        if (!receipt.ok) throw new Error(JSON.stringify(receipt));
        await receipt.wait();
      }
      const history = await agent.read(created.sessionId);
      if (!history.ok) throw new Error(JSON.stringify(history));
      for (const { options, expected } of cases) {
        const fork = await agent.createSession({ from: { sessionId: created.sessionId }, ...options });
        if (!fork.ok) throw new Error(JSON.stringify(fork));
        const conversation = await agent.conversation(fork.sessionId);
        if (conversation === undefined) throw new Error("The fork has no conversation");
        expect(await agent.harness.snapshot(AgentDoc, conversation.id, context)).toEqual(expected);
        expect(await agent.read(fork.sessionId)).toMatchObject({ entries: history.entries });
      }
      expect(await agent.harness.snapshot(AgentDoc, source.id, context)).toEqual(original);
      expect(await agent.read(created.sessionId)).toEqual(history);
    }
    const history = await agent.read(created.sessionId);
    if (!history.ok || history.entries[0] === undefined) throw new Error("The source has no entry to fork at");
    await source.configure({ thinkingLevel: "low" }, context);
    const bounded = await agent.createSession({
      from: { sessionId: created.sessionId, entryId: history.entries[0].id },
      model: replacement,
    });
    if (!bounded.ok) throw new Error(JSON.stringify(bounded));
    const branch = await agent.conversation(bounded.sessionId);
    if (branch === undefined) throw new Error("The fork has no conversation");
    expect(await agent.harness.snapshot(AgentDoc, branch.id, context)).toEqual({ ...original, model: replacement });
    expect(await agent.harness.snapshot(AgentDoc, source.id, context)).toEqual({ ...original, thinkingLevel: "low" });
    await agent.close();
  });

  it("refuses a message no model of the agent could answer, recording nothing", async () => {
    const path = temporaryStorage();
    const open = async (modelIds: string[], defaultModel: string | undefined) => {
      const faux = fauxProvider({ models: modelIds.map((id) => ({ id })) });
      faux.setResponses(
        Array.from(
          { length: 5 },
          () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) =>
            fauxAssistantMessage(`from ${model.id}`),
        ),
      );
      const models = createModels();
      models.setProvider(faux.provider);
      return openDurableAgent({
        storage: await openNodeSqliteStorage(path),
        models,
        registry: createRegistry(),
        name: "models",
        ...(defaultModel === undefined ? {} : { model: { provider: faux.getModel().provider, modelId: defaultModel } }),
      });
    };
    const hi = [{ type: "text" as const, text: "hi" }];

    let agent = await open(["a"], undefined);
    expect(await agent.invoke({ content: hi })).toMatchObject({ ok: false, error: { code: "missing_model" } });
    await agent.close();

    agent = await open(["a"], "a");
    const first = await agent.invoke({ content: hi });
    if (!first.ok) throw new Error(JSON.stringify(first));
    await first.wait();
    await agent.close();

    // The deployment's models no longer have the model the session took.
    agent = await open(["b"], "b");
    const before = await agent.read(first.sessionId);
    const refused = await agent.invoke({ sessionId: first.sessionId, content: hi });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "missing_model", message: expect.stringContaining("faux/a"), details: { model: "faux/a" } },
    });
    expect(await agent.read(first.sessionId)).toEqual(before);
    const fresh = await agent.invoke({ content: hi });
    if (!fresh.ok) throw new Error(JSON.stringify(fresh));
    expect(await fresh.wait()).toMatchObject({ ok: true, message: { answer: { text: "from b" } } });
    await agent.close();
  });
});
