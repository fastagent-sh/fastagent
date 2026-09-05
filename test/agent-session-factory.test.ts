/**
 * The AgentSession L0 running a REAL assembled agent: the prompt the definition produces, the skills
 * it declares, the tools it mounts — and the per-turn freshness that makes "the directory is the
 * agent, LIVE" true on a shared ResourceLoader.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { stream as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import {
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  createBashTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import type { MountedTool } from "../src/engines/pi/tool.ts";
import { describe, expect, it, vi } from "vitest";
import { collect } from "../src/collect.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import {
  type PropertyWrites,
  piInMemorySessionRecordStore,
  piSessionRecordStore,
} from "../src/engines/pi/session-store.ts";
import { defineTool, z } from "../src/pi.ts";
import { type TurnContext, turnContext } from "../src/engines/pi/tool-context.ts";
import { piAllCodingTools } from "../src/engines/pi/create.ts";
import { withSearchTool } from "../src/engines/pi/search-tools.ts";
import { makeFaux } from "./faux.ts";
import { fauxControlledAgent } from "./agent.ts";
import type { SessionEvent } from "../src/session.ts";
import { log } from "../src/log.ts";

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
      readDefinition: () => ({ skills: [] }),
      cwd,
      ...options,
    }),
  });
}

describe("piAgentSessionFactory: the definition reaches the model", () => {
  it("keeps gateway error bodies in the session record and failed event, outside server logs", async () => {
    const { faux } = makeFaux();
    const body = "gateway echoed private request: do-not-log";
    const message = await streamPiMessages(
      { ...faux.getModel(), api: "pi-messages", baseUrl: "https://gateway.invalid" },
      { messages: [] },
      { apiKey: "test", fetch: async () => new Response(body, { status: 400, statusText: "Bad Request" }) },
    ).result();
    expect(message.diagnostics?.[0]?.error?.message).toContain(body);
    const sessions = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const agent = await agentWith([message], { sessions });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const events = [];
      for await (const event of agent.invoke({ session: "gateway" }, { text: "hi" })) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "failed", details: expect.stringContaining(body) });
      const record = await sessions.openOrCreate("gateway");
      expect(record.getBranch()).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ diagnostics: message.diagnostics }),
        }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider diagnostic pi_messages_response_failure"));
      expect(JSON.stringify(warn.mock.calls)).toContain("session gateway, run");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(body);
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves provider effort across turns, forks, and a fresh store", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-effort-"));
    const sessions = piSessionRecordStore({ dir: join(cwd, "sessions"), cwd });
    const first = await agentWith(
      [
        { ...fauxAssistantMessage("high answer"), providerThinkingLevel: "high" },
        (context) => {
          expect(context.messages).toContainEqual(expect.objectContaining({ providerThinkingLevel: "high" }));
          return { ...fauxAssistantMessage("low answer"), providerThinkingLevel: "low" };
        },
      ],
      { cwd, sessions },
    );
    await collect(first.invoke({ session: "room" }, { text: "first" }));
    await collect(first.invoke({ session: "room" }, { text: "second" }));
    const record = await sessions.openOrCreate("room");
    await sessions.fork("room", record.getLeafId()!, "fork", "effort-test");
    const reopened = await agentWith(
      [
        (context) => {
          const efforts = context.messages.filter((m) => m.role === "assistant").map((m) => m.providerThinkingLevel);
          expect(efforts).toEqual(["high", "low"]);
          return fauxAssistantMessage("continued");
        },
      ],
      { cwd, sessions: piSessionRecordStore({ dir: join(cwd, "sessions"), cwd }) },
    );
    expect((await collect(reopened.invoke({ session: "fork" }, { text: "next" }))).text).toBe("continued");
  });

  it("compacts after a tool inside one run without repeating its side effect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-same-run-compaction-"));
    await mkdir(join(cwd, ".fastagent", "pi"), { recursive: true });
    await writeFile(
      join(cwd, ".fastagent", "pi", "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1600 },
        retry: { enabled: false },
      }),
    );
    let toolRuns = 0;
    let turns = 0;
    const requests: string[] = [];
    const events: SessionEvent[] = [];
    const respond: FauxResponseStep = (context) => {
      if (!context.systemPrompt?.startsWith("Same-run test")) {
        requests.push("summary");
        return fauxAssistantMessage("A compact summary");
      }
      requests.push("assistant");
      return ++turns === 1
        ? fauxAssistantMessage(fauxToolCall("large", {}, { id: "large-1" }))
        : fauxAssistantMessage("final answer");
    };
    const { agent, sessions, control } = await fauxControlledAgent(
      Array.from({ length: 6 }, () => respond),
      {
        cwd,
        systemPrompt: "Same-run test",
        faux: { models: [{ id: "small", contextWindow: 2500, maxTokens: 1000 }] },
        tools: [
          defineTool({
            name: "large",
            description: "Large output",
            input: z.object({}),
            execute() {
              toolRuns++;
              return "x".repeat(6000);
            },
          }),
        ],
      },
    );
    const record = await sessions.openOrCreate("compact");
    for (let i = 0; i < 4; i++) {
      record.appendMessage({ role: "user", content: `Earlier question ${i}`, timestamp: i });
      record.appendMessage(fauxAssistantMessage("h".repeat(1200)));
    }

    const watching = (async () => {
      for await (const event of control.sessions.get("compact").events()) {
        events.push(event);
        if (event.type === "run_settled") break;
      }
    })();
    expect((await collect(agent.invoke({ session: "compact" }, { text: "get large then answer" }))).text).toBe(
      "final answer",
    );
    await watching;
    expect(toolRuns).toBe(1);
    expect(requests).toEqual(["assistant", "summary", "summary", "assistant"]);
    expect(record.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run_settled")).toHaveLength(1);
    expect(events.some((e) => e.type === "compaction_started" || e.type === "compaction_finished")).toBe(false);
  });

  it("the assembled prompt is what the model is asked with", async () => {
    let systemPrompt = "";
    const agent = await agentWith(
      [
        (context) => {
          systemPrompt = context.systemPrompt ?? "";
          return fauxAssistantMessage("ok");
        },
      ],
      { readDefinition: () => ({ systemPrompt: "You are terse. Answer in one word.", skills: [] }) },
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
        ],
      },
    );

    const { text } = await collect(agent.invoke({ session: "-1001234567890" }, { text: "who am i" }));

    expect(text).toBe("done");
    // The CALLER's id, not pi's spelling of it: a tool correlates its own state by the id the
    // channel minted, and the record name is storage detail.
    expect(seenSessionId).toBe("-1001234567890");
  });

  it("forwards progress and native context to tools, including the workspace for coding tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-tool-context-"));
    await writeFile(join(cwd, "note.txt"), "workspace note");
    const seen: SessionEvent[] = [];
    let toolCwd: string | undefined;
    let nativeId: string | undefined;
    let headerId: string | undefined;
    let absentHeader: unknown;
    let nativeHistory = 0;
    const probe: MountedTool = {
      ...createReadTool(join(cwd, "different-root")),
      name: "probe",
      async execute(_id, _params, _signal, onUpdate, ctx?: ExtensionContext) {
        toolCwd = ctx?.cwd;
        nativeId = ctx?.sessionManager.getSessionId();
        headerId = ctx?.sessionManager.getHeader()?.id;
        const header = vi.spyOn(SessionManager.prototype, "getHeader").mockReturnValueOnce(null);
        try {
          absentHeader = ctx?.sessionManager.getHeader();
        } finally {
          header.mockRestore();
        }
        nativeHistory = ctx?.sessionManager.getBranch().length ?? 0;
        onUpdate?.({ content: [{ type: "text", text: "working" }], details: { progress: 50 } });
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    };
    const { agent, control } = await fauxControlledAgent(
      [
        fauxAssistantMessage([fauxToolCall("probe", { path: "note.txt" }), fauxToolCall("read", { path: "note.txt" })]),
        (context) => {
          expect(JSON.stringify(context.messages)).toContain("workspace note");
          return fauxAssistantMessage("finished");
        },
      ],
      { cwd, tools: [probe, createReadTool(join(cwd, "different-root"))] },
    );
    const watching = (async () => {
      for await (const event of control.sessions.get("native-context").events()) {
        seen.push(event);
        if (event.type === "run_settled") break;
      }
    })();
    expect((await collect(agent.invoke({ session: "native-context" }, { text: "go" }))).text).toBe("finished");
    await watching;
    expect(toolCwd).toBe(cwd);
    expect(nativeId).toBe("native-context");
    expect(headerId).toBe("native-context");
    expect(absentHeader).toBeNull();
    expect(nativeHistory).toBeGreaterThan(0);
    expect(seen.filter((event) => event.type === "tool_progress")).toMatchObject([
      { data: { name: "probe", partialResult: { details: { progress: 50 } } } },
    ]);
  });

  it.each([
    ["room\u0000a", '"room\\u0000a"', "json"],
    ["room\ud800a", '"room\\ud800a"', "json"],
    ['"room\\u0000a"', '"room\\u0000a"', ""],
    ["room:会话/🌙", "room:会话/🌙", ""],
    ["", "", ""],
  ])(
    "represents session %j in the shell environment without changing tool context",
    async (sessionId, envId, encoding) => {
      const tools = piAllCodingTools(process.cwd());
      const bash = tools.find((tool) => tool.name === "bash")!;
      const nativeIds: unknown[] = [];
      const callerIds: unknown[] = [];
      let shellResult: unknown;
      const agent = await agentWith(
        [
          fauxAssistantMessage([
            fauxToolCall("bash", { command: 'printf "ok\\n%s\\n%s" "$PI_SESSION_ID" "$PI_SESSION_ID_ENCODING"' }),
            fauxToolCall("whoami", {}),
          ]),
          (context) => {
            shellResult = context.messages.find(
              (message) => message.role === "toolResult" && message.toolName === "bash",
            );
            return fauxAssistantMessage("done");
          },
        ],
        {
          tools: [
            {
              ...bash,
              execute(...args) {
                nativeIds.push(args[4]?.sessionManager.getSessionId(), args[4]?.sessionManager.getHeader()?.id);
                return bash.execute(...args);
              },
            },
            defineTool({
              name: "whoami",
              description: "Read the caller's session id.",
              input: z.object({}),
              async execute(_input, ctx) {
                callerIds.push(ctx.sessionManager?.getSessionId(), (await ctx.sessionManager?.getHeader())?.id);
                return "reported";
              },
            }),
          ],
        },
      );
      vi.stubEnv("PI_SESSION_ID_ENCODING", "json");
      try {
        expect((await collect(agent.invoke({ session: sessionId }, { text: "go" }))).text).toBe("done");
        expect(shellResult).toMatchObject({
          isError: false,
          content: [{ type: "text", text: `ok\n${envId}\n${encoding}` }],
        });
        expect(nativeIds).toEqual([sessionId, sessionId]);
        expect(callerIds).toEqual([sessionId, sessionId]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps native thinkingLevel and shell effort scoped to interleaved sessions", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const levels = new Map<string, unknown[]>();
    const outputs = new Map<string, unknown>();
    const bash: MountedTool = createBashTool(process.cwd());
    const probe: MountedTool = {
      ...bash,
      async execute(...args) {
        const ctx = args[4]!;
        const id = ctx.sessionManager.getSessionId();
        const before = ctx.thinkingLevel;
        if (id === "room-a") {
          entered();
          await gate;
        }
        levels.set(id, [before, ctx.thinkingLevel]);
        const result = await bash.execute(...args);
        outputs.set(id, result.content);
        return result;
      },
    };
    const command = { command: 'printf "%s" "$PI_REASONING_LEVEL"' };
    const { agent, control, sessions } = await fauxControlledAgent(
      [
        fauxAssistantMessage(fauxToolCall("bash", command)),
        fauxAssistantMessage(fauxToolCall("bash", command)),
        fauxAssistantMessage("B done"),
        fauxAssistantMessage("A done"),
      ],
      { tools: [probe], faux: { models: [{ id: "thinker", reasoning: true }] } },
    );
    await sessions.openOrCreate("room-a");
    await sessions.openOrCreate("room-b");
    expect(await control.sessions.get("room-a").update({ thinkingLevel: "high" })).toEqual({ ok: true });
    expect(await control.sessions.get("room-b").update({ thinkingLevel: "low" })).toEqual({ ok: true });
    const runningA = collect(agent.invoke({ session: "room-a" }, { text: "A" }));
    try {
      await paused;
      expect((await collect(agent.invoke({ session: "room-b" }, { text: "B" }))).text).toBe("B done");
      expect((await control.sessions.get("room-a").state()).thinkingLevel).toBe("high");
      expect((await control.sessions.get("room-b").state()).thinkingLevel).toBe("low");
    } finally {
      resume();
      await runningA;
    }
    expect(levels.get("room-a")).toEqual(["high", "high"]);
    expect(levels.get("room-b")).toEqual(["low", "low"]);
    expect(outputs.get("room-a")).toEqual([{ type: "text", text: "high" }]);
    expect(outputs.get("room-b")).toEqual([{ type: "text", text: "low" }]);
  });

  it("every tool call in a turn runs in the same turn context", async () => {
    // The context describes the SESSION, not the call — one cwd, one session manager, one activation
    // bridge — and the bridge is why it matters: a tool call has to see what the previous one
    // activated. Built inside `execute`, every call got its own set of objects.
    //
    // Read through AsyncLocalStorage rather than off `ctx`: `defineTool` hands the tool a fresh
    // wrapper object each call, so anything reachable from `ctx` can only stand IN for the context
    // by way of a reference the wrapper happens to pass through.
    const seen: (TurnContext | undefined)[] = [];
    const probe = (name: string) =>
      defineTool({
        name,
        description: `probe ${name}`,
        input: z.object({}),
        execute: async () => {
          seen.push(turnContext.getStore());
          return "probed";
        },
      });
    const agent = await agentWith(
      [
        fauxAssistantMessage([fauxToolCall("probe-a", {}, { id: "a" }), fauxToolCall("probe-b", {}, { id: "b" })]),
        fauxAssistantMessage("done"),
      ],
      { tools: [probe("probe-a"), probe("probe-b")] },
    );

    await collect(agent.invoke({ session: "s" }, { text: "go" }));

    expect(seen).toHaveLength(2);
    // Without this the assertion below would pass on two undefineds — on there being no context.
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
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
        ],
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
      { readDefinition: async () => ({ systemPrompt: personaOnDisk, skills: [] }) },
    );

    await collect(agent.invoke({ session: "s" }, { text: "turn one" }));
    personaOnDisk = "You are the SECOND persona."; // the author edits persona.md between turns
    await collect(agent.invoke({ session: "s" }, { text: "turn two" }));

    expect(seen[0]).toContain("the first persona");
    expect(seen[1]).toContain("the SECOND persona");
  });

  it("reloads a skill whose model-invocation flag changes between turns", async () => {
    const seen: string[] = [];
    let disabled = false;
    const respond: FauxResponseStep = (context) => {
      seen.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("ok");
    };
    const agent = await agentWith([respond, respond], {
      tools: piAllCodingTools(process.cwd()),
      readDefinition: async () => ({
        systemPrompt: "test",
        skills: [
          {
            name: "visible-skill",
            description: "A skill",
            filePath: "/skills/visible/SKILL.md",
            content: "body",
            disableModelInvocation: disabled,
          },
        ],
      }),
    });
    await collect(agent.invoke({ session: "visibility" }, { text: "first" }));
    disabled = true;
    await collect(agent.invoke({ session: "visibility" }, { text: "second" }));
    expect(seen[0]).toContain("visible-skill");
    expect(seen[1]).not.toContain("visible-skill");
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
      list: () => real.list(),
      fork: (from: string, at: string, into: string, provenance: string) => real.fork(from, at, into, provenance),
      delete: (id: string) => real.delete(id),
      applyProperties: (id: string, writes: PropertyWrites) => real.applyProperties(id, writes),
    };

    const agent = await agentWith([record, record, record], {
      sessions,
      readDefinition: async () => ({ systemPrompt: persona, skills: [] }),
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
    const content = "# release\nCut a release.\n";
    await writeFile(skillFile, content);
    let systemPrompt = "";
    const agent = await agentWith(
      [
        (context) => {
          systemPrompt = context.systemPrompt ?? "";
          return fauxAssistantMessage("ok");
        },
      ],
      {
        // pi lists skills only when `read` is mounted — a skill is a file the model has to open, so
        // advertising one it cannot read would be an empty offer. Serving always has it.
        tools: piAllCodingTools(process.cwd()),
        readDefinition: () => ({
          systemPrompt: "base",
          skills: [{ name: "release", description: "Cut a release", filePath: skillFile, content }],
        }),
      },
    );

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(systemPrompt).toContain("release");
  });
});

describe("piAgentSessionFactory: deferred tools stay discovered", () => {
  const deferredPair = () => [
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
  ];

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
      { tools: withSearchTool(deferredPair()) },
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
      { sessions: store, tools: withSearchTool(deferredPair()) },
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
        ]),
      },
    );

    await expect(collect(without.invoke({ session: "shrinks" }, { text: "again" }))).resolves.toBeDefined();
    expect(offered).not.toContain("weather_forecast");
  });
});
