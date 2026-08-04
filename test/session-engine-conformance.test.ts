/**
 * SPEC conformance for the SECOND engine class (`session`: pi-coding-agent's `AgentSession`), run at
 * the same per-invoke state locality as the reference harness path — the combination
 * design/conformance-levels.md claims is real. `pair()` is provided, so MUST 6 (no location
 * dependence) is asserted rather than assumed: two independent agent instances share only the jsonl
 * record on disk.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent.ts";
import { createPiAgentFromSession } from "../src/engines/pi/session-invoke.ts";
import { makeFaux } from "./faux.ts";
import { describeSpecConformance } from "./spec-conformance.ts";

/** A credential store that authorizes the faux provider — the seam fastagent fills with auth.json. */
const fauxCredentials = {
  read: async () => ({ type: "api_key" as const, key: "conformance" }),
  list: async () => [{ providerId: "faux", type: "api_key" as const }],
  modify: async () => undefined,
  delete: async () => {},
};

/**
 * One assembly (the SHARED half: resource loader + model runtime) and a factory that binds a fresh
 * AgentSession per invoke to `sessionsRoot`'s record for that id — the same jsonl layout the harness
 * path writes, which is what lets the two classes share one record.
 */
async function sessionAssembly(options: {
  responses: FauxResponseStep[];
  sessionsRoot: string;
  cwd: string;
  /** Inline extensions, standing in for the definition's `extensions/` directory. */
  extensionFactories?: unknown[];
  /** Off by default: pi's backoff would otherwise make a failing model look like a hang. */
  autoRetry?: boolean;
  customTools?: unknown[];
  /** pi's tool allowlist. Empty by default (no coding tools in a conformance run). */
  tools?: string[];
}) {
  const { faux } = makeFaux();
  faux.setResponses(options.responses);
  const agentDir = join(options.cwd, ".pi");
  const modelRuntime = await ModelRuntime.create({
    credentials: fauxCredentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager: SettingsManager.create(options.cwd, agentDir),
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    ...(options.extensionFactories ? { extensionFactories: options.extensionFactories as never } : {}),
  });
  await loader.reload();
  // The record is addressed the way fastagent already addresses it — through the repo, so a session
  // written by either engine class is found by the other.
  const repo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd: options.cwd }),
    sessionsRoot: options.sessionsRoot,
  });
  const filePath = async (sessionId: string): Promise<string> => {
    const existing = (await repo.list({ cwd: options.cwd })).find((m) => m.id === sessionId);
    if (existing) return existing.path;
    await repo.create({ id: sessionId, cwd: options.cwd });
    const created = (await repo.list({ cwd: options.cwd })).find((m) => m.id === sessionId);
    if (!created) throw new Error(`session record for "${sessionId}" was not created`);
    return created.path;
  };
  return {
    faux,
    /** Per invoke: a fresh AgentSession over that id's record, discarded when the turn ends. */
    sessionFactory: async (sessionId: string) => {
      const sessionManager = SessionManager.create(options.cwd, options.sessionsRoot);
      sessionManager.setSessionFile(await filePath(sessionId));
      const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader: loader,
        sessionManager,
        tools: options.tools ?? [],
        ...(options.customTools ? { customTools: options.customTools as never } : {}),
      });
      // Auto-retry is a DEPLOYMENT policy, not a turn mechanism: leaving it on makes a failing
      // model wait out pi's backoff before the terminal, which is exactly the "hang" a conformance
      // suite must not mistake for engine behavior. The reference harness path sets its own policy
      // the same way (SUMMARIZATION_RETRY_POLICY / PROVIDER_MAX_RETRIES).
      session.setAutoRetryEnabled(options.autoRetry ?? false);
      return session;
    },
  };
}

async function sessionAgent(responses: FauxResponseStep[], shared?: { sessionsRoot: string; cwd: string }) {
  const cwd = shared?.cwd ?? (await mkdtemp(join(tmpdir(), "fa-se-")));
  const sessionsRoot = shared?.sessionsRoot ?? join(cwd, "sessions");
  const { sessionFactory } = await sessionAssembly({ responses, sessionsRoot, cwd });
  return createPiAgentFromSession({ sessionFactory });
}

describeSpecConformance("pi session engine class (faux model, per-invoke AgentSession)", {
  completing: () => sessionAgent([fauxAssistantMessage("hello world")]),

  failing: () => sessionAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })]),

  hanging: async (onCleanup) => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-hang-"));
    // A turn that genuinely does not finish: the model calls a tool whose execute settles ONLY on
    // its abort signal, so there is real in-flight work when the consumer walks away. It does NOT
    // discriminate between the cancellation door and the generator's finally — this case breaks at
    // a yield, so the finally runs either way; the dedicated pull-driven test below is what
    // separates the two.
    const gate = {
      name: "gate",
      label: "Gate",
      description: "Blocks until the turn is aborted",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: (_id: string, _params: unknown, signal: AbortSignal | undefined) =>
        new Promise<{ output: string }>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" }))],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      customTools: [gate],
      tools: ["gate"],
    });
    // The engine's cancel cleanup is session.abort() — intercept it as the probe.
    return createPiAgentFromSession({
      sessionFactory: async (id) => {
        const session = await sessionFactory(id);
        const abort = session.abort.bind(session);
        session.abort = async () => {
          onCleanup();
          return abort();
        };
        return session;
      },
    });
  },

  /** MUST 6: two INSTANCES, one record on disk, nothing in common in process. */
  pair: async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-pair-"));
    const sessionsRoot = join(cwd, "sessions");
    let sawHistory = false;
    const a = await sessionAgent([fauxAssistantMessage("first")], { sessionsRoot, cwd });
    // Instance B is assembled independently; its faux model reports whether the context it received
    // carried instance A's turn.
    const bAssembly = await sessionAssembly({
      responses: [
        (context) => {
          sawHistory = JSON.stringify(context.messages).includes("turn one");
          return fauxAssistantMessage("second");
        },
      ],
      sessionsRoot,
      cwd,
    });
    const b = createPiAgentFromSession({ sessionFactory: bAssembly.sessionFactory });
    return { a, b, sawHistory: () => sawHistory };
  },
});

describe("session engine class: what the class buys", () => {
  it("the stream carries the turn, not just its terminal", async () => {
    const agent = await sessionAgent([fauxAssistantMessage("hello world")]);
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("hello world");
  });

  it("tool activity projects with its args and result, error result included", async () => {
    // The two tool projections carry payloads (`args`, `content`, `isError`) that nothing else in
    // the suite reads — a stream consumer renders exactly these.
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-tool-"));
    const boom = {
      name: "boom",
      label: "Boom",
      description: "Always fails",
      parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
      // pi's `AgentToolResult` has NO isError field: a tool reports failure by THROWING, and pi
      // marks the event. Returning `{ isError: true }` is silently a success.
      execute: async () => {
        throw new Error("it went wrong");
      },
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [
        fauxAssistantMessage(fauxToolCall("boom", { why: "testing" }, { id: "b1" })),
        fauxAssistantMessage("recovered"),
      ],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      customTools: [boom],
      tools: ["boom"],
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);
    expect(events.find((e) => e.type === "tool_started")).toMatchObject({
      id: "b1",
      name: "boom",
      args: { why: "testing" },
    });
    const ended = events.find((e) => e.type === "tool_ended");
    expect(ended).toMatchObject({ id: "b1", isError: true });
    expect(JSON.stringify((ended as { content: unknown }).content)).toContain("it went wrong");
  });

  it("an extension command that throws fails the turn instead of reporting success", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-cmdfail-"));
    const extension = {
      name: "spike",
      factory: (api: { registerCommand: (n: string, o: unknown) => void }) => {
        api.registerCommand("boom", {
          description: "throws",
          handler: async () => {
            throw new Error("the command exploded");
          },
        });
      },
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage("never")],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      extensionFactories: [extension],
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "/boom" })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "failed", details: expect.stringContaining("exploded") });
  });

  it("an image prompt reaches the model — the conversion the harness path uses, not a dropped field", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-img-"));
    let sawImage = false;
    const { sessionFactory } = await sessionAssembly({
      responses: [
        (context) => {
          sawImage = JSON.stringify(context.messages).includes('"type":"image"');
          return fauxAssistantMessage("saw it");
        },
      ],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    // A 1x1 PNG — enough to travel the whole conversion path.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    for await (const e of agent.invoke(
      { session: "s" },
      { text: "what is this?", images: [{ mimeType: "image/png", data: png }] },
    ))
      void e;
    expect(sawImage).toBe(true);
  });

  it("THE point of this class: an extension command runs instead of reaching the model", async () => {
    // On the harness class this is impossible at any price — pi-agent-core has no extension
    // vocabulary, so `/ping` is text the model receives. Here the same input is dispatched.
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-ext-"));
    let ran = 0;
    let modelSaw = 0;
    const extension = {
      name: "spike",
      factory: (api: { registerCommand: (n: string, o: unknown) => void }) => {
        api.registerCommand("ping", {
          description: "answer without the model",
          handler: async () => {
            ran++;
          },
        });
      },
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [
        () => {
          modelSaw++;
          return fauxAssistantMessage("the model answered");
        },
      ],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      extensionFactories: [extension],
    });
    const agent = createPiAgentFromSession({ sessionFactory });

    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "/ping" })) events.push(e);
    expect(ran).toBe(1);
    expect(modelSaw).toBe(0); // the model never saw it …
    expect(events.at(-1)?.type).toBe("completed"); // … and the turn still settles cleanly

    // An ordinary prompt still goes to the model on the same agent.
    for await (const e of agent.invoke({ session: "s" }, { text: "hello" })) void e;
    expect(modelSaw).toBe(1);
  });
});

describe("session engine class: this L0's own responsibilities", () => {
  it("a factory that throws becomes a failed EVENT, not a thrown iteration", async () => {
    const agent = createPiAgentFromSession({
      sessionFactory: async () => {
        throw new Error("auth.json unreadable");
      },
    });
    const events = [];
    // The iteration itself must not reject — the module's stated setup-failure discipline.
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", details: expect.stringContaining("auth.json unreadable") });
  });

  it("a cancel that lands DURING the build never starts the model", async () => {
    // The latch: the cancellation door is armed only after the session exists, so a consumer that
    // walks away while the factory is still running would otherwise have its turn start anyway —
    // a model call nobody is reading, on a session about to be discarded.
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-latch-"));
    let prompted = 0;
    let releaseFactory!: () => void;
    const factoryHeld = new Promise<void>((r) => {
      releaseFactory = r;
    });
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage("should never run")],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
    });
    const agent = createPiAgentFromSession({
      sessionFactory: async (id) => {
        const session = await sessionFactory(id);
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args: Parameters<typeof prompt>) => {
          prompted++;
          return prompt(...args);
        };
        await factoryHeld; // the consumer cancels while we are in here
        return session;
      },
    });
    const iterator = agent.invoke({ session: "s" }, { text: "go" })[Symbol.asyncIterator]();
    const first = iterator.next();
    const returned = iterator.return?.(undefined); // cancels before the session exists
    releaseFactory();
    expect(await first).toEqual({ done: true, value: undefined });
    await returned;
    expect(prompted).toBe(0);
  });

  it("one turn per session: a second concurrent invoke is refused session_busy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-busy-"));
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    // The first turn announces itself from INSIDE the model call, so the second invoke races the
    // lease deterministically instead of racing a timer.
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const { sessionFactory } = await sessionAssembly({
      responses: [
        async () => {
          started();
          await held;
          return fauxAssistantMessage("done");
        },
        fauxAssistantMessage("second"),
      ],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    const first = (async () => {
      const out = [];
      for await (const e of agent.invoke({ session: "s" }, { text: "one" })) out.push(e);
      return out;
    })();
    await inFlight;
    const second = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "two" })) second.push(e);
    expect(second).toEqual([
      { type: "failed", details: expect.stringContaining("session busy"), retryable: true, code: "session_busy" },
    ]);
    release();
    expect((await first).at(-1)?.type).toBe("completed");
  });

  it("an auto-retried failure projects `retrying` and settles on the recovered turn, once", async () => {
    // The one path auto-retry owns: pi ends the agent loop with an error, retries, and succeeds.
    // `agent_end{willRetry:true}` must NOT be taken as the settle, or the turn would be classified
    // on an error the engine went on to recover from.
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-retry-"));
    const { sessionFactory } = await sessionAssembly({
      responses: [
        fauxAssistantMessage("x", { stopReason: "error", errorMessage: "transient 503" }),
        fauxAssistantMessage("recovered"),
      ],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      autoRetry: true,
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);
    expect(events.filter((e) => e.type === "retrying").length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "completed" || e.type === "failed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("completed");
  });
});

describe("session engine class: cancellation reaches in-flight work", () => {
  it("a PULL-driven consumer that walks away unsticks the turn — the door, not the finally", async () => {
    // The shared MUST 3 case is a for-await + break, which resumes the generator AT A YIELD, so its
    // finally runs with or without the cancellation door. The door only earns its place for a
    // consumer that pulls (the SSE handler's eager reads): there the generator is parked on an
    // await, and return() would queue behind work that never settles. Asserted with a tool that
    // hangs until its signal fires, so "never settles" is literal.
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-pull-"));
    let toolAborted = false;
    let sawAbort!: () => void;
    const aborted = new Promise<void>((r) => {
      sawAbort = r;
    });
    const gate = {
      name: "gate",
      label: "Gate",
      description: "Blocks until the turn is aborted",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: (_id: string, _params: unknown, signal: AbortSignal | undefined) =>
        new Promise<{ output: string }>((_resolve, reject) => {
          // The ALREADY-ABORTED check is not defensive boilerplate here, it is the case under test:
          // `tool_started` is emitted BEFORE pi calls execute, so a consumer that walks away on that
          // event cancels in the window between the two — and an already-aborted signal never fires
          // its `abort` event. A tool that only listens would hang forever.
          const stop = () => {
            toolAborted = true;
            sawAbort();
            reject(new Error("aborted"));
          };
          if (signal?.aborted) return stop();
          signal?.addEventListener("abort", stop, { once: true });
        }),
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage([{ type: "text", text: "checking" }, fauxToolCall("gate", {}, { id: "g1" })])],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      customTools: [gate],
      tools: ["gate"],
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    const iterator = agent.invoke({ session: "s" }, { text: "go" })[Symbol.asyncIterator]();
    // Pull until the TOOL is actually running. Walking away during the model stream is a different
    // (also correct) case — pi never starts the tool — and would prove nothing about in-flight work.
    for (let i = 0; i < 20; i++) {
      const { value, done } = await iterator.next();
      if (done) throw new Error("the turn ended before the tool started");
      if (value?.type === "tool_started") break;
    }
    // The consumer is released PROMPTLY — this is what the door buys, and without it `return()`
    // queues behind a turn parked inside a tool that never settles.
    await Promise.race([
      iterator.return?.(undefined) ?? Promise.resolve(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("return() never settled — the door is not armed")), 3000),
      ),
    ]);
    // … and the work it walked away from is actually stopped. Awaited rather than asserted inline:
    // the abort is in flight when return() resolves.
    await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("in-flight tool was never stopped")), 3000)),
    ]);
    expect(toolAborted).toBe(true);
  });
});

describe("session engine class: the turn context fastagent tools depend on", () => {
  it("a fastagent tool sees this session and this turn's activation, not the process defaults", async () => {
    // The binding degrades SILENTLY when missing (cwd → process.cwd(), manager/activation →
    // undefined), so it is asserted rather than assumed.
    const { turnContext } = await import("../src/engines/pi/tool-context.ts");
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-ctx-"));
    let seen: { cwd?: string; sessionId?: string; canActivate?: boolean } = {};
    // Read from a TOOL's execute, not from the model call: the tool path is the one the binding
    // exists for (`wake`, `search_tools`, cwd), and it is a different resumption of pi's stack.
    const probe = {
      name: "probe",
      label: "Probe",
      description: "Reports the turn context it sees",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const store = turnContext.getStore();
        seen = {
          cwd: store?.cwd,
          sessionId: store?.sessionManager?.getSessionId(),
          canActivate: typeof store?.tools?.activate === "function",
        };
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    };
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage(fauxToolCall("probe", {}, { id: "p1" })), fauxAssistantMessage("done")],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
      customTools: [probe],
      tools: ["probe"],
    });
    const agent = createPiAgentFromSession({ sessionFactory });
    for await (const e of agent.invoke({ session: "ctx" }, { text: "go" })) void e;
    expect(seen.cwd).toBe(cwd);
    expect(seen.sessionId).toBeTruthy();
    expect(seen.canActivate).toBe(true);
  });
});

describe("session engine class: per-invoke discipline", () => {
  it("nothing resident survives a turn — the record is the only continuity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-se-record-"));
    const sessionsRoot = join(cwd, "sessions");
    const built: string[] = [];
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
      sessionsRoot,
      cwd,
    });
    const agent: Agent = createPiAgentFromSession({
      sessionFactory: async (id) => {
        built.push(id);
        return sessionFactory(id);
      },
    });
    for (const text of ["turn one", "turn two"]) {
      const events = [];
      for await (const e of agent.invoke({ session: "s" }, { text })) events.push(e);
      expect(events.at(-1)?.type).toBe("completed");
    }
    // The factory is asked once per invoke — this L0 holds nothing across turns. (Whether a factory
    // hands back a cached object is the caller's choice, not something this L0 can or should police;
    // what it owes is asking again, and rebuilding the turn from the record below.)
    expect(built).toHaveLength(2);
    // … and ONE record carrying both turns.
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd }), sessionsRoot });
    const meta = (await repo.list({ cwd })).find((m) => m.id === "s");
    const record = await repo.open(meta as NonNullable<typeof meta>);
    const text = JSON.stringify(await record.getEntries());
    expect(text).toContain("turn one");
    expect(text).toContain("turn two");
  });
});
