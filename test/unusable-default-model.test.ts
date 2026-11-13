import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { openSource } from "./open-source.ts";

const RETIRED = "openai-codex/retired-model";
const opened: LocalAgent[] = [];

afterEach(async () => {
  for (const agent of opened.splice(0)) await agent.close();
});

async function agentWithDefault(model: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-unusable-default-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default { defaults: { model: "${model}" } };\n`);
  return dir;
}

describe("an agent whose configured default model the catalog does not have", () => {
  it("opens with no default, and says which model was configured and why it is unusable", async () => {
    const agent = await openSource(await agentWithDefault(RETIRED));
    opened.push(agent);
    const info = await agent.info();
    expect(info).not.toHaveProperty("defaultModel");
    expect(info.unusableDefault).toEqual({
      spec: RETIRED,
      reason: 'no provider "openai-codex" offers "retired-model"',
    });
  });

  it("refuses a message that names no model, as missing_model naming the default", async () => {
    const agent = await openSource(await agentWithDefault(RETIRED));
    opened.push(agent);
    const { id } = await agent.sessions.create();
    await expect(agent.messages.send({ sessionId: id, content: "hello" })).rejects.toMatchObject({
      code: "missing_model",
      message: expect.stringContaining(`the agent's default ${RETIRED} is unusable`),
    });
  });

  it("still refuses a model chosen when the agent is opened", async () => {
    const dir = await agentWithDefault(RETIRED);
    await expect(openSource(dir, { model: "openai-codex/typo" })).rejects.toThrow(
      'unknown model "openai-codex/typo": no provider "openai-codex" offers "typo"',
    );
  });
});
