/**
 * The SPEC conformance suite (spec-conformance.ts) against the `AgentSession` L0 — the proof that
 * pi's own session class satisfies the four Agent-side MUSTs in the `per-invoke` posture, MUST 6
 * (portability) included: every turn builds a fresh `AgentSession` over the same jsonl on disk, with
 * nothing shared in-process but the directory.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  ModelRuntime,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentFromSession, type PiAgentSessionFactory } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore, piSessionRecordStore } from "../src/engines/pi/session-store.ts";
import { collect, AgentFailure } from "../src/collect.ts";
import { describe, expect, it } from "vitest";
import { makeFaux } from "./faux.ts";
import { describeSpecConformance } from "./spec-conformance.ts";

/**
 * A per-invoke `AgentSession` factory over one faux model. `dir` makes the record durable (the
 * portability subject); without it each turn gets a fresh in-memory session.
 *
 * `services` is built ONCE and shared across turns — the per-turn cost is the session binding only,
 * which is what makes this posture affordable.
 */
interface SubjectOptions {
  /** Where the record lives. Omitted — a fresh in-memory session per turn (no continuity needed). */
  dir?: string;
  /** Mounted on the session, for the paths where a turn has to do something before it answers. */
  customTools?: ToolDefinition[];
}

async function sessionFactory(
  responses: FauxResponseStep[],
  { dir, customTools }: SubjectOptions = {},
): Promise<PiAgentSessionFactory> {
  const { faux } = makeFaux();
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const cwd = process.cwd();
  const services = await createAgentSessionServices({
    cwd,
    modelRuntime,
    resourceLoaderOptions: {
      // The agent is the definition, not the authoring machine's pi setup (same posture as serving).
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPromptOverride: () => "test",
      appendSystemPromptOverride: () => [],
      skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
    },
  });
  const store = dir === undefined ? piInMemorySessionRecordStore({ cwd }) : piSessionRecordStore({ dir, cwd });
  return async (sessionId) => {
    const sessionManager = await store.openOrCreate(sessionId);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: faux.getModel(),
      // "builtin" not "all": the coding tools stay off (this is a protocol subject, not an agent),
      // while a subject that mounts its own tool keeps it.
      noTools: "builtin",
      customTools,
    });
    return session;
  };
}

async function piSessionAgent(responses: FauxResponseStep[], options?: SubjectOptions) {
  return createPiAgentFromSession({ sessionFactory: await sessionFactory(responses, options) });
}

describeSpecConformance("pi AgentSession (faux model, per-invoke L0)", {
  completing: () => piSessionAgent([fauxAssistantMessage("hello world")]),

  // The answer streams a token before it fails, so the L0 refuses pi's retry and the subject stays
  // failed - no backoff, and the refusal itself is exercised by every conformance run.
  failing: () => piSessionAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })]),

  hanging: async (onCleanup) => {
    const factory = await sessionFactory([fauxAssistantMessage("a long answer that streams out slowly")]);
    // The engine's cancel cleanup is session.abort() — intercept it as the probe.
    return createPiAgentFromSession({
      sessionFactory: async (sessionId) => {
        const session = await factory(sessionId);
        const abort = session.abort.bind(session);
        (session as { abort: AgentSession["abort"] }).abort = async () => {
          onCleanup();
          return abort();
        };
        return session;
      },
    });
  },

  // Portable conformance: two agent instances, each building its own SessionManager over the same
  // directory — nothing shared in-process, the disk is the only common state.
  pair: async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-session-conformance-"));
    let saw = false;
    const a = await piSessionAgent([fauxAssistantMessage("the code is 47")], { dir });
    const b = await piSessionAgent(
      [
        (context) => {
          saw = JSON.stringify(context.messages).includes("the code is 47");
          return fauxAssistantMessage("ok");
        },
      ],
      { dir },
    );
    return { a, b, sawHistory: () => saw };
  },
});

describe("AgentSession L0: pi's auto-retry vs. append-only deltas", () => {
  it("a failure AFTER output was streamed is final — a retry would concatenate two answers", async () => {
    const agent = await piSessionAgent([
      fauxAssistantMessage("the first half of a wrong", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("a complete replacement answer"),
    ]);
    const started = Date.now();
    await expect(collect(agent.invoke({ session: "streamed-then-failed" }, { text: "go" }))).rejects.toBeInstanceOf(
      AgentFailure,
    );
    // Refusing the retry must also CANCEL it: pi's first backoff is 2s, and letting it run would
    // both delay the failure and spend a provider call on an answer this turn can never use.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a failure BEFORE any output still retries — that window is free resilience", async () => {
    const agent = await piSessionAgent([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("the answer, second attempt"),
    ]);
    const { text } = await collect(agent.invoke({ session: "silent-then-retried" }, { text: "go" }));
    expect(text).toBe("the answer, second attempt");
  });

  it("an executed tool does not close the window — the retry resumes from it instead of re-running it", async () => {
    let toolRuns = 0;
    const agent = await piSessionAgent(
      [
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "call-1" })),
        // The request that follows the tool fails before saying anything. pi retries it against the
        // PERSISTED tool result; refusing here would hand the retry to the caller, who has no way to
        // re-ask without running the tool again.
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
        fauxAssistantMessage("pong, once"),
      ],
      {
        // The cast is the same one session-builder.ts makes: pi types `parameters` per-tool, so a
        // literal only satisfies ToolDefinition after erasure.
        customTools: [
          {
            name: "ping",
            label: "ping",
            description: "A tool with a side effect worth not repeating.",
            parameters: Type.Object({}),
            execute: async () => {
              toolRuns++;
              return { content: [{ type: "text", text: "pong" }] };
            },
          } as unknown as ToolDefinition,
        ],
      },
    );

    const { text } = await collect(agent.invoke({ session: "tool-then-retried" }, { text: "go" }));

    expect(text).toBe("pong, once");
    expect(toolRuns).toBe(1);
  });
});
