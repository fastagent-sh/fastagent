import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DurableAgent, openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { sessionIdOf } from "../src/harnesses/pi-durable/ids.ts";
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
  afterEach(() => vi.restoreAllMocks());
  const hi = "hi";
  const answerOf = async (agent: DurableAgent, sessionId: string, content: string) =>
    (await agent.messages.send({ sessionId, content }, { wait: 30 })).answer?.text;

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
    const created = await one.sessions.create();
    await two.sessions.create();
    await expect(two.sessions.get(created.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await one.sessions.get(created.id)).toMatchObject({ id: created.id });
    await Promise.all([one.close(), two.close()]);
  });

  it.each([false, true])(
    "delivers a write that follows the snapshot once, live, as the history has it (replay=%s)",
    async (replay) => {
      const { faux, models, model } = fauxModels();
      faux.setResponses([fauxAssistantMessage("answer")]);
      const storage = await openNodeSqliteStorage(temporaryStorage());
      const agent = await openDurableAgent({ storage, models, registry: createRegistry(), name: "snapshot", model });
      const created = await agent.sessions.create({ model });
      const conversation = await agent.conversation(created.id);
      if (conversation === undefined) throw new Error("The created session has no conversation");
      let submitted: ReturnType<typeof conversation.submit> | undefined;
      let insert = true;
      const scanTasks = storage.scanTasks.bind(storage);
      vi.spyOn(storage, "scanTasks").mockImplementation(async (...args) => {
        const tasks = await scanTasks(...args);
        if (insert && args[0].kind === "pi.generation" && args[0].status === "completing") {
          insert = false;
          // watchEvents has captured the empty view on the mutation line; this write runs immediately after it.
          submitted = conversation.submit({ type: "input", content: "hi" }, context);
        }
        return tasks;
      });
      const stream = agent.sessions.events(created.id, replay ? { after: "start" } : {})[Symbol.asyncIterator]();
      try {
        expect(await stream.next()).toMatchObject({
          done: false,
          value: { type: "state", session: { status: "idle" } },
        });
        expect(submitted).toBeDefined();
        if (submitted === undefined) throw new Error("The interleaved submission did not start");
        await (await submitted).wait(context);
        const live = [];
        for (let next = await stream.next(); !next.done; next = await stream.next()) {
          if (next.value.type === "entry") live.push(next.value.entry);
          if (next.value.type === "done") break;
        }
        expect(live.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
        expect(live).toEqual((await agent.sessions.entries(created.id)).data);
      } finally {
        await stream.return?.();
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
    // After a model failure pi-durable's default (`afterFailedRun: "keep"`) leaves it queued: why release.ts exists.
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
    const settings = async (agent: DurableAgent, sessionId: string) =>
      agent.harness.snapshot(AgentDoc, (await agent.conversation(sessionId))?.id as never, context);

    let agent = await open("a", "low");
    const first = (await agent.sessions.create()).id;
    expect(await answerOf(agent, first, "which?")).toBe("from a");
    await agent.close();

    agent = await open("b", "high");
    expect(await answerOf(agent, first, "which?")).toBe("from a");
    expect(await settings(agent, first)).toMatchObject({ thinkingLevel: "low" });
    const second = (await agent.sessions.create()).id;
    expect(await answerOf(agent, second, "which?")).toBe("from b");
    expect(await settings(agent, second)).toMatchObject({ thinkingLevel: "high" });
    await (await agent.conversation(first))?.configure({ model: ref("c") }, context);
    expect(await answerOf(agent, first, "which?")).toBe("from c");
    await agent.close();
  });

  describe("closed while a message runs", () => {
    const untilAborted = (_context: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );

    async function closeWhileRunning(cancelFirst: boolean) {
      const path = temporaryStorage();
      const open = async (reply: unknown) => {
        const { faux, models, model } = fauxModels();
        faux.setResponses([reply as never]);
        return openDurableAgent({
          storage: await openNodeSqliteStorage(path),
          models,
          registry: createRegistry(),
          name: "closing",
          model,
        });
      };
      const first = await open(untilAborted);
      const session = await first.sessions.create();
      const sent = await first.messages.send({ sessionId: session.id, content: "go" });
      await vi.waitFor(async () => expect((await first.sessions.get(session.id)).status).toBe("running"));
      if (cancelFirst) await first.sessions.cancel(session.id);
      await first.close();

      const second = await open(fauxAssistantMessage("after reopen"));
      try {
        return await vi.waitFor(async () => {
          const message = await second.messages.get({ sessionId: session.id, messageId: sent.id });
          expect(message.status).not.toBe("running");
          return message.status;
        });
      } finally {
        await second.close();
      }
    }

    it("is interrupted, and runs again when the agent is next opened", async () => {
      expect(await closeWhileRunning(false)).toBe("completed");
    });

    it("stays canceled when it was cancelled first", async () => {
      expect(await closeWhileRunning(true)).toBe("canceled");
    });
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
    const created = await agent.sessions.create(chosen);
    unsubscribe();
    expect(commits).toEqual([[chosen]]);
    const conversation = await agent.conversation(created.id);
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
    expect(await answerOf(agent, created.id, hi)).toBe("chosen answer");
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
    const created = await agent.sessions.create(original);
    const source = await agent.conversation(created.id);
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
        await agent.messages.send({ sessionId: created.id, content: hi }, { wait: 30 });
      }
      const history = await agent.sessions.entries(created.id);
      for (const { options, expected } of cases) {
        const fork = await agent.sessions.create({ forkFrom: { sessionId: created.id }, ...options });
        const conversation = await agent.conversation(fork.id);
        if (conversation === undefined) throw new Error("The fork has no conversation");
        expect(await agent.harness.snapshot(AgentDoc, conversation.id, context)).toEqual(expected);
        expect(await agent.sessions.entries(fork.id)).toEqual(history);
      }
      expect(await agent.harness.snapshot(AgentDoc, source.id, context)).toEqual(original);
      expect(await agent.sessions.entries(created.id)).toEqual(history);
    }
    const [first] = (await agent.sessions.entries(created.id)).data;
    if (first === undefined) throw new Error("The source has no entry to fork at");
    await source.configure({ thinkingLevel: "low" }, context);
    const bounded = await agent.sessions.create({
      forkFrom: { sessionId: created.id, entryId: first.id },
      model: replacement,
    });
    const branch = await agent.conversation(bounded.id);
    if (branch === undefined) throw new Error("The fork has no conversation");
    expect(await agent.harness.snapshot(AgentDoc, branch.id, context)).toEqual({ ...original, model: replacement });
    expect(await agent.harness.snapshot(AgentDoc, source.id, context)).toEqual({ ...original, thinkingLevel: "low" });
    await agent.close();
  });

  it.each([
    ["before_commit", "unconfirmed"],
    ["after_commit", "unconfirmed"],
    ["status", "unconfirmed"],
    ["duplicate_receipt", "unavailable"],
  ] as const)(
    "rejects a send whose storage fails at %s with %s, and the same key finds what it left",
    async (stage, code) => {
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
      const sessionId = (await agent.sessions.create()).id;
      const request = { sessionId, content: "effect", idempotencyKey: "once" };
      let previous: string | undefined;
      if (stage === "duplicate_receipt") previous = (await agent.messages.send(request, { wait: 30 })).id;
      armed = true;
      const error = await agent.messages.send(request).then(
        (message) => {
          throw new Error(`the send was not refused: ${JSON.stringify(message)}`);
        },
        (rejection: unknown) => rejection,
      );
      expect(injected).toBe(true);
      expect(error).toMatchObject({ code, message: expect.stringContaining(`injected ${stage}`) });
      if (code === "unconfirmed") {
        expect(error).toMatchObject({ retryable: false, details: { sessionId } });
        const known = (error as { details: { messageId?: string } }).details.messageId;
        if (stage === "status") expect(known).toEqual(expect.any(String));
        else expect(known).toBeUndefined();
      } else expect(error).toMatchObject({ retryable: true });
      expect(await agent.harness.closed).toMatchObject({ reason: "failed" });
      await agent.close();

      agent = await openDurableAgent({
        storage: await openNodeSqliteStorage(path),
        models,
        registry,
        model,
        name: "again",
      });
      const found = await agent.messages.get({ sessionId, idempotencyKey: "once" }).catch(() => undefined);
      if (stage === "before_commit") expect(found).toBeUndefined();
      else expect(found).toBeDefined();
      if (previous !== undefined) expect(found?.id).toBe(previous);
      const retried = await agent.messages.send(request, { wait: 30 });
      if (found !== undefined) expect(retried.id).toBe(found.id);
      expect(retried.status).toBe("completed");
      const users = (await agent.sessions.entries(sessionId)).data.filter((entry) => entry.kind === "user");
      expect(users).toHaveLength(1);
      expect(effects).toBe(1);
      await agent.close();
    },
  );

  it("never ends a message canceled that its cancel does not report, sent while the cancel runs", async () => {
    const subject = durableSubject();
    const agent = (await subject.start()) as DurableAgent;
    try {
      for (let round = 0; round < 10; round++) {
        const sessionId = (await agent.sessions.create()).id;
        const running = await agent.messages.send({ sessionId, content: "hold" });
        await vi.waitFor(() => expect(subject.held()).toBe(1), { timeout: 5000, interval: 5 });
        const [late, { stopped }] = await Promise.all([
          agent.messages.send({ sessionId, content: "hi" }),
          agent.sessions.cancel(sessionId),
        ]);
        expect(stopped).toContain(running.id);
        subject.release();
        const end = await agent.messages.get({ sessionId, messageId: late.id }, { wait: 30 });
        expect(end.status === "canceled").toBe(stopped.includes(late.id));
      }
    } finally {
      await subject.stop();
    }
  });

  it("does not answer a cancel whose stop was not recorded", async () => {
    const subject = durableSubject();
    const agent = (await subject.start()) as DurableAgent;
    try {
      const sessionId = (await agent.sessions.create()).id;
      await agent.messages.send({ sessionId, content: "hold" });
      await vi.waitFor(() => expect(subject.held()).toBe(1), { timeout: 5000, interval: 5 });
      const conversation = await agent.conversation(sessionId);
      const prototype = Object.getPrototypeOf(conversation) as { abort: (...args: unknown[]) => Promise<void> };
      vi.spyOn(prototype, "abort").mockRejectedValueOnce(new Error("pi-durable refused the stop"));
      await expect(agent.sessions.cancel(sessionId)).rejects.toMatchObject({
        code: "internal",
        message: expect.stringContaining("pi-durable refused the stop"),
      });
      expect((await agent.sessions.get(sessionId)).status).toBe("running");
    } finally {
      await subject.stop();
    }
  });

  it("rejects a cancel when the harness refuses its commits, leaving no refusal unheard", async () => {
    const subject = durableSubject();
    const agent = (await subject.start()) as DurableAgent;
    const { harness } = agent;
    const commit = harness.commit;
    try {
      const sessionId = (await agent.sessions.create()).id;
      // What pi-durable does once it is closing or its storage failed: every commit is refused before it runs. Not a
      // spy, which handles each rejection it returns to record it: a rejection nobody heard must reach vitest.
      harness.commit = () => Promise.reject(new Error("Session is closed"));
      await expect(agent.sessions.cancel(sessionId)).rejects.toMatchObject({ code: "internal" });
    } finally {
      harness.commit = commit;
      await subject.stop();
    }
  });

  it("reads a page of sessions in one commit, one turn on the line every running session writes through", async () => {
    const subject = durableSubject();
    const agent = (await subject.start()) as DurableAgent;
    try {
      for (let i = 0; i < 5; i++) await agent.sessions.create();
      const commits = vi.spyOn(agent.harness, "commit");
      expect((await agent.sessions.list()).data).toHaveLength(5);
      expect(commits).toHaveBeenCalledOnce();
    } finally {
      await subject.stop();
    }
  });

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
    const sessionId = (await agent.sessions.create()).id;
    await expect(agent.messages.send({ sessionId, content: "/broken now" })).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("SKILL.md vanished"),
    });
    expect((await storage.scanSubmissions({}, 10, undefined, context)).items).toEqual([]);
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

    let agent = await open(["a"], undefined);
    const unanswerable = (await agent.sessions.create()).id;
    await expect(agent.messages.send({ sessionId: unanswerable, content: hi })).rejects.toMatchObject({
      code: "missing_model",
    });
    await agent.close();

    agent = await open(["a"], "a");
    const first = (await agent.sessions.create()).id;
    await agent.messages.send({ sessionId: first, content: hi }, { wait: 30 });
    await agent.close();

    // The deployment's models no longer have the model the session took.
    agent = await open(["b"], "b");
    const before = await agent.sessions.entries(first);
    await expect(agent.messages.send({ sessionId: first, content: hi })).rejects.toMatchObject({
      code: "missing_model",
      message: expect.stringContaining("faux/a"),
      details: { model: "faux/a" },
    });
    expect(await agent.sessions.entries(first)).toEqual(before);
    expect(await answerOf(agent, (await agent.sessions.create()).id, hi)).toBe("from b");
    await agent.close();
  });

  it("does not list a conversation a task owns, as a subagent's is", async () => {
    const { faux, models, model } = fauxModels();
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "subagent",
        tools: [
          defineTool({
            name: "spawn",
            description: "Creates a conversation its task owns",
            parameters: Type.Object({}),
            execute: async (_args, api, toolContext) => {
              await api.commit(
                (tx) => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }),
                toolContext,
              );
              return { output: [{ type: "text", text: "spawned" }] };
            },
          }),
        ],
      }),
    );
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("spawn", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("spawned"),
    ]);
    const storage = await openNodeSqliteStorage(temporaryStorage());
    const agent = await openDurableAgent({ storage, models, registry, name: "subagents", model });
    const sessionId = (await agent.sessions.create()).id;
    expect(await answerOf(agent, sessionId, "go")).toBe("spawned");
    const all = await storage.scanConversations({}, 10, undefined, context);
    const owned = all.items.filter((conversation) => conversation.owner !== undefined);
    expect(owned).toHaveLength(1);
    expect((await agent.sessions.list()).data.map(({ id }) => id)).toEqual([sessionId]);
    // Its id as the Agent would encode it: the session's incarnation, the subagent's number.
    const subagent = sessionId.replace(/\.\d+$/, `.${owned[0]?.id}`);
    await expect(agent.sessions.get(subagent)).rejects.toMatchObject({ code: "not_found" });
    await expect(agent.messages.send({ sessionId: subagent, content: hi })).rejects.toMatchObject({
      code: "not_found",
    });
    await agent.close();
  });

  it("gives a tool its session id, and none in a conversation a task owns", async () => {
    const incarnation = "inc";
    const api = (owner: { conversationId: number; taskId: number } | undefined) =>
      ({
        conversationId: 7,
        snapshot: async () => ({ incarnation }),
        commit: async (change: (tx: unknown) => unknown) =>
          change({ conversation: async (id: number) => ({ id, ...(owner === undefined ? {} : { owner }) }) }),
      }) as unknown as Parameters<typeof sessionIdOf>[0];
    expect(await sessionIdOf(api(undefined), context)).toBe("inc.7");
    expect(await sessionIdOf(api({ conversationId: 2, taskId: 5 }), context)).toBeUndefined();
  });
});
