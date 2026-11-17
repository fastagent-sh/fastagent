import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  type Harness,
  Harness as Harnesses,
  MemoryStorage,
  type ToolRegistration,
  createRegistry,
} from "@earendil-works/pi-durable";
import { listWakeups } from "../../../packages/fastagent/src/schedule/wakeups.ts";
import { clockStore } from "../../../packages/fastagent/src/harnesses/pi-durable/clock.ts";
import { wakeExtension } from "../../../packages/fastagent/src/harnesses/pi-durable/wake.ts";

const NOW = new Date("2026-07-07T12:00:00Z");
const opened: Harness[] = [];
afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close(BACKGROUND_CONTEXT);
});

/** A Session of storage "inc", with one conversation the wake tool runs in: session `inc.<id>`. */
async function session() {
  const harness = await Harnesses.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  opened.push(harness);
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  return { harness, conversationId: conversation.id };
}

describe("schedule/wake-tool", () => {
  it("records a wake-up into the CURRENT session, in the tool call's own commit", async () => {
    const { harness, conversationId } = await session();
    const tool = wakeExtension({ now: () => NOW }).tools?.find(({ name }) => name === "wake") as ToolRegistration;
    // The tool's only way to its Session is its call's commit.
    const api = {
      conversationId,
      snapshot: async () => ({ incarnation: "inc" }),
      commit: (change: Parameters<Harness["commit"]>[0], context: Parameters<Harness["commit"]>[1]) =>
        harness.commit(change, context),
    };
    await tool.execute({ in: "30m", prompt: "resume the check" } as never, api as never, BACKGROUND_CONTEXT);
    const wakeups = await listWakeups(clockStore(harness, BACKGROUND_CONTEXT));
    expect(wakeups).toEqual([
      expect.objectContaining({ session: `inc.${conversationId}`, prompt: "resume the check" }),
    ]);
  });
});
