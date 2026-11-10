/** A real Agent whose first run is held open by a tool, so a test can steer more input into it. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { makeFaux } from "./faux.ts";

/** A durable Agent whose `work` tool holds the run open until `release()`, answering `shared` when it ends. */
export async function holdingAgent(answers: { shared: string }) {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { faux, models } = makeFaux();
  const model = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("work", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage(answers.shared), // the run ends with this after the steered input was taken
  ]);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "hold",
      tools: [
        defineTool({
          name: "work",
          description: "waits",
          parameters: obj({}),
          execute: async () => {
            await held;
            return { output: [{ type: "text", text: "worked" }] };
          },
        }),
      ],
    }),
  );
  const agent = await openDurableAgent({
    storage: new MemoryStorage(),
    models,
    registry,
    name: "faux",
    model: { provider: model.provider, modelId: model.id },
  });
  return { agent, release };
}
