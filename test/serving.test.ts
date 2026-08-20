/**
 * A definition on disk, served end to end: persona + skills, an id a channel actually mints, a
 * durable record, and a second agent instance that has to remember what the first one was told.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collect } from "../src/collect.ts";
import { createPiAgentFromDefinition } from "../src/engines/pi/create.ts";
import { piSessionRecordStore } from "../src/engines/pi/session-store.ts";
import { makeFaux } from "./faux.ts";

/** A definition with everything the binding has to carry through: persona, a skill, a tool. */
async function agentDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fa-parity-"));
  const dir = join(root, "fastagent");
  await mkdir(join(dir, "skills", "release"), { recursive: true });
  await writeFile(join(dir, "persona.md"), "You are Parity, a terse assistant.\n");
  await writeFile(
    join(dir, "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Cut a release\n---\n\nSteps to cut a release.\n",
  );
  return dir;
}

describe("serving a definition end to end", () => {
  it("the definition reaches the model, and a second instance continues the conversation", async () => {
    const dir = await agentDirectory();
    const sessionsDir = join(dir, "sessions");
    const session = "-1001234567890"; // a telegram group id: pi refuses it verbatim

    let firstPrompt = "";
    let secondContext = "";
    const build = async (respond: (context: { systemPrompt?: string; messages: unknown[] }) => string) => {
      const { faux } = makeFaux();
      faux.setResponses([(context) => fauxAssistantMessage(respond(context))]);
      const { agent } = await createPiAgentFromDefinition(dir, {
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
        providers: [faux.provider],
        sessions: piSessionRecordStore({ dir: sessionsDir, cwd: dir }),
      });
      return agent;
    };

    const first = await build((context) => {
      firstPrompt = context.systemPrompt ?? "";
      return "the code is 47";
    });
    expect((await collect(first.invoke({ session }, { text: "remember 47" }))).text).toBe("the code is 47");

    // A second agent instance over the same directory — nothing shared in process but the disk.
    const second = await build((context) => {
      secondContext = JSON.stringify(context.messages);
      return "recalled";
    });
    expect((await collect(second.invoke({ session }, { text: "what was it?" }))).text).toBe("recalled");

    expect(firstPrompt).toContain("You are Parity"); // persona.md
    expect(firstPrompt).toContain("release"); // the skill is listed
    expect(secondContext).toContain("the code is 47"); // history crossed the instance boundary
  });

  it("a thread that names a parent starts from what the room knew", async () => {
    const dir = await agentDirectory();
    const sessionsDir = join(dir, "sessions");
    const { faux } = makeFaux();
    let threadContext = "";
    faux.setResponses([
      () => fauxAssistantMessage("the room's answer is 47"),
      (context) => {
        threadContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("inherited");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: `${faux.getModel().provider}/${faux.getModel().id}`,
      providers: [faux.provider],
      sessions: piSessionRecordStore({ dir: sessionsDir, cwd: dir }),
    });

    await collect(agent.invoke({ session: "room" }, { text: "remember 47" }));
    // What a feishu thread sends on its first turn: continue from what the room knew.
    await collect(agent.invoke({ session: "thread", parentSession: "room" }, { text: "what did the room say?" }));

    expect(threadContext).toContain("the room's answer is 47");
  });
});
