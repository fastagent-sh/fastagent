/**
 * The SPEC conformance suite (spec-conformance.ts) against the `AgentSession` L0 — the proof that
 * pi's own session class satisfies the four Agent-side MUSTs in the `per-invoke` posture, MUST 6
 * (portability) included: every turn builds a fresh `AgentSession` over the same jsonl on disk, with
 * nothing shared in-process but the directory.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentFromSession, type PiAgentSessionFactory } from "../src/engines/pi/invoke-session.ts";
import { makeFaux } from "./faux.ts";
import { describeSpecConformance } from "./spec-conformance.ts";

/**
 * A per-invoke `AgentSession` factory over one faux model. `dir` makes the record durable (the
 * portability subject); without it each turn gets a fresh in-memory session.
 *
 * `services` is built ONCE and shared across turns — the per-turn cost is the session binding only,
 * which is what makes this posture affordable.
 */
async function sessionFactory(
  responses: FauxResponseStep[],
  dir?: string,
  /** pi's own assistant-level auto-retry. Off in the failure subject so its backoff (~14s) does not
   *  pace the suite; whether serving keeps it on is a phase-2 policy call. */
  autoRetry = true,
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
  return async (sessionId) => {
    let sessionManager: SessionManager;
    if (dir === undefined) {
      sessionManager = SessionManager.inMemory(cwd, { id: sessionId });
    } else {
      const existing = (await SessionManager.list(cwd, dir)).find((info) => info.id === sessionId);
      sessionManager = existing
        ? SessionManager.open(existing.path, dir)
        : SessionManager.create(cwd, dir, { id: sessionId });
    }
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: faux.getModel(),
      noTools: "all",
    });
    if (!autoRetry) session.setAutoRetryEnabled(false);
    return session;
  };
}

async function piSessionAgent(responses: FauxResponseStep[], dir?: string, autoRetry = true) {
  return createPiAgentFromSession({ sessionFactory: await sessionFactory(responses, dir, autoRetry) });
}

describeSpecConformance("pi AgentSession (faux model, per-invoke L0)", {
  completing: () => piSessionAgent([fauxAssistantMessage("hello world")]),

  failing: () =>
    piSessionAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })], undefined, false),

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
    const a = await piSessionAgent([fauxAssistantMessage("the code is 47")], dir);
    const b = await piSessionAgent(
      [
        (context) => {
          saw = JSON.stringify(context.messages).includes("the code is 47");
          return fauxAssistantMessage("ok");
        },
      ],
      dir,
    );
    return { a, b, sawHistory: () => saw };
  },
});
