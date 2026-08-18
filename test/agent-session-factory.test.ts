/**
 * The AgentSession L0 running a REAL assembled agent: the prompt the definition produces, the skills
 * it declares, the tools it mounts — and the per-turn freshness that makes "the directory is the
 * agent, LIVE" true on a shared ResourceLoader.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { collect } from "../src/collect.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { defineTool, z } from "../src/pi.ts";
import { makeFaux } from "./faux.ts";

/** An agent built the way serving builds one, minus the directory read. */
async function agentWith(
  responses: FauxResponseStep[],
  options: Partial<Parameters<typeof piAgentSessionFactory>[0]> = {},
) {
  const { faux } = makeFaux();
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const cwd = process.cwd();
  return createPiAgentFromSession({
    sessionFactory: piAgentSessionFactory({
      sessions: piInMemorySessionRecordStore({ cwd }),
      modelRuntime,
      model: faux.getModel(),
      cwd,
      env: new NodeExecutionEnv({ cwd }),
      ...options,
    }),
  });
}

describe("piAgentSessionFactory: the definition reaches the model", () => {
  it("the assembled prompt is what the model is asked with", async () => {
    let systemPrompt = "";
    const agent = await agentWith(
      [
        (context) => {
          systemPrompt = context.systemPrompt ?? "";
          return fauxAssistantMessage("ok");
        },
      ],
      { systemPrompt: "You are terse. Answer in one word." },
    );

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(systemPrompt).toContain("You are terse. Answer in one word.");
  });

  it("a mounted tool executes, and sees the turn's session through the tool context", async () => {
    let seenSessionId: string | undefined;
    const agent = await agentWith(
      [fauxAssistantMessage(fauxToolCall("whoami", {}, { id: "c1" })), fauxAssistantMessage("done")],
      {
        tools: [
          defineTool({
            name: "whoami",
            description: "Report the session this turn runs in.",
            input: z.object({}),
            execute: async (_input, ctx) => {
              seenSessionId = ctx.sessionManager?.getSessionId();
              return "reported";
            },
          }),
        ] as Parameters<typeof piAgentSessionFactory>[0]["tools"],
      },
    );

    const { text } = await collect(agent.invoke({ session: "-1001234567890" }, { text: "who am i" }));

    expect(text).toBe("done");
    // pi stores the record under its own spelling of the id; what matters is that the tool was bound
    // to THIS turn's session rather than to nothing.
    expect(seenSessionId).toBe("s-1001234567890");
  });

  it("a deferred tool is not offered until something activates it", async () => {
    let offered: string[] = [];
    const agent = await agentWith(
      [
        (context) => {
          offered = (context.tools ?? []).map((t: { name: string }) => t.name);
          return fauxAssistantMessage("ok");
        },
      ],
      {
        tools: [
          defineTool({
            name: "eager",
            description: "Always available.",
            input: z.object({}),
            execute: async () => "",
          }),
          defineTool({
            name: "lazy",
            description: "Discovered on demand.",
            deferred: true,
            input: z.object({}),
            execute: async () => "",
          }),
        ] as Parameters<typeof piAgentSessionFactory>[0]["tools"],
      },
    );

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(offered).toContain("eager");
    expect(offered).not.toContain("lazy");
  });

  it("the prompt is re-read every turn, so an edited definition takes effect on the next one", async () => {
    const seen: string[] = [];
    let personaOnDisk = "You are the first persona.";
    const agent = await agentWith(
      [
        (context) => {
          seen.push(context.systemPrompt ?? "");
          return fauxAssistantMessage("ok");
        },
        (context) => {
          seen.push(context.systemPrompt ?? "");
          return fauxAssistantMessage("ok");
        },
      ],
      { live: async () => ({ systemPrompt: personaOnDisk }) },
    );

    await collect(agent.invoke({ session: "s" }, { text: "turn one" }));
    personaOnDisk = "You are the SECOND persona."; // the author edits persona.md between turns
    await collect(agent.invoke({ session: "s" }, { text: "turn two" }));

    expect(seen[0]).toContain("the first persona");
    expect(seen[1]).toContain("the SECOND persona");
  });

  it("skills declared by the definition are offered to the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-skills-"));
    const skillFile = join(dir, "release.md");
    await (await import("node:fs/promises")).writeFile(skillFile, "# release\nCut a release.\n");
    let systemPrompt = "";
    const agent = await agentWith(
      [
        (context) => {
          systemPrompt = context.systemPrompt ?? "";
          return fauxAssistantMessage("ok");
        },
      ],
      {
        systemPrompt: "base",
        skills: [{ name: "release", description: "Cut a release", filePath: skillFile }] as Parameters<
          typeof piAgentSessionFactory
        >[0]["skills"],
      },
    );

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(systemPrompt).toContain("release");
  });
});
