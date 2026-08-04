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
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
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
        tools: [],
      });
      // Auto-retry is a DEPLOYMENT policy, not a turn mechanism: leaving it on makes a failing
      // model wait out pi's backoff before the terminal, which is exactly the "hang" a conformance
      // suite must not mistake for engine behavior. The reference harness path sets its own policy
      // the same way (SUMMARIZATION_RETRY_POLICY / PROVIDER_MAX_RETRIES).
      session.setAutoRetryEnabled(false);
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
    const { sessionFactory } = await sessionAssembly({
      responses: [fauxAssistantMessage("a long answer that streams out slowly")],
      sessionsRoot: join(cwd, "sessions"),
      cwd,
    });
    // The engine's cancel cleanup is session.abort() — intercept it as the probe, mirroring the
    // harness subject.
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
        ((context: { messages: unknown[] }) => {
          sawHistory = JSON.stringify(context.messages).includes("turn one");
          return fauxAssistantMessage("second");
        }) as unknown as FauxResponseStep,
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

  it("an engine failure arrives as a failed event carrying the engine's own message", async () => {
    const agent = await sessionAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })]);
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "failed", details: expect.stringContaining("boom 500") });
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
        (() => {
          modelSaw++;
          return fauxAssistantMessage("the model answered");
        }) as unknown as FauxResponseStep,
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
    // A fresh session object per turn (the assumption that made residency look mandatory) …
    expect(built).toEqual(["s", "s"]);
    // … and ONE record carrying both turns.
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd }), sessionsRoot });
    const meta = (await repo.list({ cwd })).find((m) => m.id === "s");
    const record = await repo.open(meta as NonNullable<typeof meta>);
    const text = JSON.stringify(await record.getEntries());
    expect(text).toContain("turn one");
    expect(text).toContain("turn two");
  });
});
