import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
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
});
