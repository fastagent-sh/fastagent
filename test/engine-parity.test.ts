/**
 * The same agent directory, served by both engines.
 *
 * This is the check the AgentSession path could not pass before: a definition on disk (persona +
 * skills + a tool), an id a channel actually mints, a durable record, and a second agent instance
 * that has to remember what the first one was told. `FASTAGENT_ENGINE` is the only difference
 * between the two runs, and both assertions are identical — that is the point.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { collect } from "../src/collect.ts";
import { createPiAgentFromDefinition } from "../src/engines/pi/create.ts";
import { jsonlSessionStore } from "../src/engines/pi/sessions.ts";
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

const original = process.env.FASTAGENT_ENGINE;
afterEach(() => {
  if (original === undefined) delete process.env.FASTAGENT_ENGINE;
  else process.env.FASTAGENT_ENGINE = original;
});

describe("engine parity: one definition, two engines", () => {
  for (const engine of ["harness", "session"] as const) {
    it(`${engine}: the definition reaches the model, and a second instance continues the conversation`, async () => {
      process.env.FASTAGENT_ENGINE = engine;
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
          // Both stores read the same directory; the engine in force picks the one it speaks.
          sessions: jsonlSessionStore({ dir: sessionsDir, cwd: dir }),
          sessionRecords: piSessionRecordStore({ dir: sessionsDir, cwd: dir }),
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
  }

  it("session: a thread that names a parent fails loudly rather than starting empty", async () => {
    process.env.FASTAGENT_ENGINE = "session";
    const dir = await agentDirectory();
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("never reached")]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: `${faux.getModel().provider}/${faux.getModel().id}`,
      providers: [faux.provider],
      sessionRecords: piSessionRecordStore({ dir: join(dir, "sessions"), cwd: dir }),
    });

    // What a feishu thread sends on its first turn: continue from what the room knew.
    const events = [];
    for await (const event of agent.invoke({ session: "thread", parentSession: "room" }, { text: "hi" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", retryable: false });
    expect((events[0] as { details: string }).details).toContain("inheritance");
  });

  it("session: a mistyped engine name is a startup error, not a silent default", async () => {
    process.env.FASTAGENT_ENGINE = "sesion"; // the typo that would otherwise pick the harness
    const dir = await agentDirectory();
    const { faux } = makeFaux();
    await expect(
      createPiAgentFromDefinition(dir, {
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
        providers: [faux.provider],
      }),
    ).rejects.toThrow(/FASTAGENT_ENGINE must be/);
  });

  it("session: refuses the harness engine's session store instead of silently going in-memory", async () => {
    process.env.FASTAGENT_ENGINE = "session";
    const dir = await agentDirectory();
    const { faux } = makeFaux();
    await expect(
      createPiAgentFromDefinition(dir, {
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
        providers: [faux.provider],
        sessions: jsonlSessionStore({ dir: join(dir, "sessions"), cwd: dir }),
      }),
    ).rejects.toThrow(/PiSessionStore/);
  });
});
