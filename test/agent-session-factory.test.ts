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
import { piAllCodingTools } from "../src/engines/pi/create.ts";
import { withSearchTool } from "../src/engines/pi/search-tools.ts";
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
      engine: async () => ({ modelRuntime, model: faux.getModel() }),
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
    // The CALLER's id, not pi's spelling of it: a tool correlates its own state by the id the
    // channel minted, and the record name is storage detail.
    expect(seenSessionId).toBe("-1001234567890");
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

  it("concurrent turns each run on a definition that exists, and neither blocks the other", async () => {
    const seen: string[] = [];
    let persona = "first";
    const record = (context: { systemPrompt?: string }) => {
      seen.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("ok");
    };
    // Park turn A between "definition read" and "session bound" - the window where the shared
    // snapshot holds A's new value but the loader has not been reloaded with it yet.
    let openRoomA!: () => void;
    let roomAParked!: () => void;
    const parked = new Promise<void>((resolve) => (openRoomA = resolve));
    const reachedPark = new Promise<void>((resolve) => (roomAParked = resolve));
    const cwd = process.cwd();
    const real = piInMemorySessionRecordStore({ cwd });
    const sessions = {
      async openOrCreate(id: string) {
        if (id === "room-a") {
          roomAParked();
          await parked;
        }
        return real.openOrCreate(id);
      },
      openIfExists: (id: string) => real.openIfExists(id),
    };

    const agent = await agentWith([record, record, record], {
      sessions,
      live: async () => ({ systemPrompt: persona }),
    });

    // Turn zero settles the shared services with "first".
    await collect(agent.invoke({ session: "warm" }, { text: "zero" }));

    persona = "second"; // the author edits between turns
    const a = collect(agent.invoke({ session: "room-a" }, { text: "one" }));
    await reachedPark;
    // B runs to completion while A is still parked - the whole point is what B sees meanwhile.
    await collect(agent.invoke({ session: "room-b" }, { text: "two" }));
    openRoomA();
    await a;

    // B must not be held up by A (the snapshot is shared, but binding is not serialized), and must
    // not inherit a half-applied snapshot: whichever order they land in, each turn ran on a
    // definition some read actually produced - here, the current one.
    expect(seen.slice(1).map((p) => (p.includes("second") ? "second" : p.includes("first") ? "first" : "?"))).toEqual([
      "second",
      "second",
    ]);
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
        // pi lists skills only when `read` is mounted — a skill is a file the model has to open, so
        // advertising one it cannot read would be an empty offer. Serving always has it.
        tools: piAllCodingTools(process.cwd()),
        skills: [{ name: "release", description: "Cut a release", filePath: skillFile }] as Parameters<
          typeof piAgentSessionFactory
        >[0]["skills"],
      },
    );

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(systemPrompt).toContain("release");
  });
});

describe("piAgentSessionFactory: deferred tools stay discovered", () => {
  const deferredPair = () =>
    [
      defineTool({
        name: "eager",
        description: "Always available.",
        input: z.object({}),
        execute: async () => "",
      }),
      defineTool({
        name: "weather_forecast",
        description: "Look up the weather forecast for a place.",
        deferred: true,
        input: z.object({}),
        execute: async () => "sunny",
      }),
    ] as Parameters<typeof piAgentSessionFactory>[0]["tools"];

  it("a tool discovered in one turn is still callable in the next", async () => {
    const offered: string[][] = [];
    const record = (context: { tools?: { name: string }[] }) => {
      offered.push((context.tools ?? []).map((t) => t.name));
      return undefined;
    };
    const agent = await agentWith(
      [
        // Turn one: the model cannot see the deferred tool, searches, and finds it.
        (context) => {
          record(context);
          return fauxAssistantMessage(fauxToolCall("search_tools", { query: "weather forecast" }, { id: "s1" }));
        },
        fauxAssistantMessage("found it"),
        // Turn two: a fresh session over the same record.
        (context) => {
          record(context);
          return fauxAssistantMessage("still here");
        },
      ],
      { tools: withSearchTool(deferredPair() ?? []) },
    );

    await collect(agent.invoke({ session: "discovers" }, { text: "what is the weather?" }));
    await collect(agent.invoke({ session: "discovers" }, { text: "and now?" }));

    expect(offered[0]).not.toContain("weather_forecast"); // deferred at the start
    expect(offered[1]).toContain("weather_forecast"); // and restored for the next turn
  });

  it("a recorded activation whose tool is gone is dropped, not replayed into a throw", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const withTool = await agentWith(
      [
        fauxAssistantMessage(fauxToolCall("search_tools", { query: "weather forecast" }, { id: "s1" })),
        fauxAssistantMessage("found it"),
      ],
      { sessions: store, tools: withSearchTool(deferredPair() ?? []) },
    );
    await collect(withTool.invoke({ session: "shrinks" }, { text: "weather?" }));

    // The author removes the tool from the definition; the session still records having found it.
    let offered: string[] = [];
    const without = await agentWith(
      [
        (context) => {
          offered = (context.tools ?? []).map((t: { name: string }) => t.name);
          return fauxAssistantMessage("ok");
        },
      ],
      {
        sessions: store,
        tools: withSearchTool([
          defineTool({ name: "eager", description: "Always available.", input: z.object({}), execute: async () => "" }),
        ] as Parameters<typeof piAgentSessionFactory>[0]["tools"] as never),
      },
    );

    await expect(collect(without.invoke({ session: "shrinks" }, { text: "again" }))).resolves.toBeDefined();
    expect(offered).not.toContain("weather_forecast");
  });
});
