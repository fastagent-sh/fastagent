import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";
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

  it.each([false, true])(
    "keeps an empty snapshot's first live entry parentless when a write follows attachment (replay=%s)",
    async (replay) => {
      const { faux, models, model } = fauxModels();
      faux.setResponses([fauxAssistantMessage("answer")]);
      const storage = await openNodeSqliteStorage(temporaryStorage());
      const agent = await openDurableAgent({ storage, models, registry: createRegistry(), name: "snapshot", model });
      const created = await agent.createSession({ model });
      if (!created.ok) throw new Error(JSON.stringify(created));
      const conversation = await agent.conversation(created.sessionId);
      if (conversation === undefined) throw new Error("The created session has no conversation");
      let submitted: ReturnType<typeof conversation.submit> | undefined;
      let insert = true;
      const scanTasks = storage.scanTasks.bind(storage);
      const spy = vi.spyOn(storage, "scanTasks").mockImplementation(async (...args) => {
        const tasks = await scanTasks(...args);
        if (insert && args[0].kind === "pi.generation" && args[0].status === "completing") {
          insert = false;
          // watchEvents has captured the empty view on the mutation line; this write runs immediately after it.
          submitted = conversation.submit({ type: "input", content: "hi" }, context);
        }
        return tasks;
      });
      const stream = agent
        .resume(created.sessionId, replay ? { replayFrom: { type: "start" } } : undefined)
        [Symbol.asyncIterator]();
      try {
        expect(await stream.next()).toMatchObject({
          done: false,
          value: { type: "state", state: { status: "idle", taken: [], queued: [] } },
        });
        expect(submitted).toBeDefined();
        if (submitted === undefined) throw new Error("The interleaved submission did not start");
        await (await submitted).wait(context);
        const live = [];
        for (let next = await stream.next(); !next.done; next = await stream.next()) {
          if (next.value.type === "entry") live.push(next.value.entry);
          if (next.value.type === "done") break;
        }
        const read = await agent.read(created.sessionId);
        if (!read.ok) throw new Error(JSON.stringify(read));
        expect(live.map((entry) => entry.kind)).toEqual(["user_message", "assistant_message"]);
        expect(live[0]).not.toHaveProperty("parentEntryId");
        expect(live).toEqual(read.entries);
      } finally {
        await stream.return?.();
        spy.mockRestore();
        await agent.close();
      }
    },
  );

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

  it.each(["before_commit", "after_commit", "status", "duplicate_receipt"] as const)(
    "answers unknown rather than a rejection when submission or its receipt fails at %s",
    async (stage) => {
      const path = temporaryStorage();
      const { faux, models, model } = fauxModels();
      let effects = 0;
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "receipt failure",
          tools: [
            defineTool({
              name: "effect",
              description: "Counts an effect",
              parameters: Type.Object({}),
              execute: async () => {
                effects++;
                return { output: [{ type: "text", text: "effect recorded" }] };
              },
            }),
          ],
        }),
      );
      faux.setResponses(
        Array.from(
          { length: 8 },
          () => (input) =>
            input.messages.at(-1)?.role === "toolResult"
              ? fauxAssistantMessage("answer")
              : fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
        ),
      );
      const disk = await openNodeSqliteStorage(path);
      let armed = false;
      let injected = false;
      const failRead = () => {
        armed = false;
        injected = true;
        throw new Error(`injected ${stage} failure`);
      };
      const storage = new Proxy(disk, {
        get(target, property) {
          if (property === "commit") {
            return async (...args: Parameters<typeof disk.commit>) => {
              const admitsInput = args[0].some((write) => write.type === "submission" && write.value.type === "input");
              if (armed && admitsInput && stage === "before_commit") failRead();
              const result = await target.commit(...args);
              if (armed && admitsInput && stage === "after_commit") failRead();
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (
              armed &&
              ((property === "submission" && stage === "status") ||
                (property === "entry" && stage === "duplicate_receipt"))
            ) {
              failRead();
            }
            return value.apply(target, args);
          };
        },
      });
      let agent = await openDurableAgent({ storage, models, registry, model, name: "receipt failure" });
      const content = [{ type: "text" as const, text: "effect" }];
      const key = "once";
      let sessionId: string | undefined;
      let previousMessageId: string | undefined;
      // A failed first invoke without a key must still return the session and message ids it learned.
      if (stage !== "status") {
        const created = await agent.createSession();
        if (!created.ok) throw new Error(JSON.stringify(created));
        sessionId = created.sessionId;
      }
      if (stage === "duplicate_receipt") {
        const receipt = await agent.invoke({ sessionId, content, idempotencyKey: key });
        if (!receipt.ok) throw new Error(JSON.stringify(receipt));
        expect(await receipt.wait()).toMatchObject({ ok: true });
        previousMessageId = receipt.message.messageId;
      }
      armed = true;
      const result = await agent.invoke({
        content,
        ...(sessionId === undefined ? {} : { sessionId, idempotencyKey: key }),
      });
      expect(injected).toBe(true);
      expect(result).toMatchObject({ ok: false, unknown: { reason: expect.stringContaining(`injected ${stage}`) } });
      expect(result).not.toHaveProperty("error");
      if (result.ok || !("unknown" in result)) throw new Error(JSON.stringify(result));
      const known = result.unknown;
      expect(known.sessionId).toEqual(sessionId ?? expect.any(String));
      if (stage === "status" || stage === "duplicate_receipt") {
        expect(known.messageId).toEqual(previousMessageId ?? expect.any(String));
      } else {
        expect(known.messageId).toBeUndefined();
      }
      expect(await agent.harness.closed).toMatchObject({ reason: "failed" });
      await agent.close();

      agent = await openDurableAgent({
        storage: await openNodeSqliteStorage(path),
        models,
        registry,
        model,
        name: "reopened",
      });
      const restoredSessionId = known.sessionId as string;
      const found = await agent.getMessage(
        restoredSessionId,
        known.messageId === undefined ? { idempotencyKey: key } : { messageId: known.messageId },
      );
      if (stage === "before_commit") expect(found).toBeUndefined();
      else expect(found).toBeDefined();
      if (stage === "status") {
        const watch = agent.resume(restoredSessionId)[Symbol.asyncIterator]();
        await watch.next();
        const current = await agent.getMessage(restoredSessionId, { messageId: known.messageId as string });
        if (current?.status !== "done") {
          for (let next = await watch.next(); !next.done; next = await watch.next()) {
            if (next.value.type === "done" && next.value.message.messageId === known.messageId) break;
          }
        }
        await watch.return?.();
      } else {
        const retry = await agent.invoke({ sessionId: restoredSessionId, content, idempotencyKey: key });
        if (!retry.ok) throw new Error(JSON.stringify(retry));
        expect(retry.duplicate).toBe(stage !== "before_commit");
        if (found !== undefined) expect(retry.message.messageId).toBe(found.messageId);
        expect(await retry.wait()).toMatchObject({ ok: true });
      }
      const history = await agent.read(restoredSessionId);
      if (!history.ok) throw new Error(JSON.stringify(history));
      expect(history.entries.filter((entry) => entry.kind === "user_message")).toHaveLength(1);
      expect(effects).toBe(1);
      await agent.close();
    },
  );

  it("records nothing when expanding a command fails", async () => {
    const { models, model } = fauxModels();
    const storage = await openNodeSqliteStorage(temporaryStorage());
    const agent = await openDurableAgent({
      storage,
      models,
      registry: createRegistry(),
      name: "commands",
      model,
      commands: () => [
        {
          name: "broken",
          expand: () => {
            throw new Error("SKILL.md vanished");
          },
        },
      ],
    });
    expect(await agent.invoke({ content: [{ type: "text", text: "/broken now" }] })).toMatchObject({
      ok: false,
      error: { code: "internal", message: expect.stringContaining("SKILL.md vanished") },
    });
    expect((await storage.scanConversations({}, 10, undefined, context)).items).toEqual([]);
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
