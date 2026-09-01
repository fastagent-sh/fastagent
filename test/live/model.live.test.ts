/**
 * The SPEC conformance suite (spec-conformance.ts) against a REAL provider, over the same per-invoke
 * `AgentSession` L0 the serving path binds. The offline twin (test/conformance-session.test.ts) proves
 * the contract holds over a faux model; this one proves it still holds when the stream, the errors and
 * the cancellation are a real provider's.
 *
 * `FASTAGENT_LIVE_MODEL` selects the model ("provider/modelId"); credentials resolve exactly as the
 * product resolves them — `FASTAGENT_AUTH_PATH` or the agent's own auth.json, then the provider's env
 * key. An OAuth provider (openai-codex) has only the first, so point the variable at a logged-in file.
 *
 * The `failing` subject is the one deliberate stand-in: it points a definition-local models.json at a
 * local endpoint that answers 400, because the assertion is how a real HTTP error travels through pi's
 * provider stack into our terminal mapping — not which prose the vendor puts in it. MUST 6 has no
 * subject here either: the suite's `pair` probe needs to read the second instance's ANSWER, which is
 * the continuity test below, written once.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent.ts";
import { collect } from "../../src/collect.ts";
import { resolveAuthPath, resolveModel } from "../../src/engines/pi/config.ts";
import { type PiAgentSessionFactory, createPiAgentFromSession } from "../../src/engines/pi/invoke-session.ts";
import { createPiModelRuntime } from "../../src/engines/pi/models.ts";
import { piInMemorySessionRecordStore, piSessionRecordStore } from "../../src/engines/pi/session-store.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { describeSpecConformance } from "../spec-conformance.ts";
import { requireEnv } from "./env.ts";

// What every CLI entry does before it reaches a provider. This probe assembles the engine directly,
// so it owes the same call: without it, a machine behind a proxy sees each turn time out.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** An empty agent dir: no models.json, so the real provider registry and real credentials are in play. */
const agentDir = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-live-model-"));

/**
 * A per-invoke `AgentSession` factory on the REAL model runtime — the same shape the offline
 * conformance subject builds, with pi's own resource loading turned off so the probe measures the
 * engine and the provider, not this machine's pi setup. `dir` makes the record durable; without it
 * each turn gets a fresh in-memory session.
 */
async function sessionFactory(options: {
  agentDir: string;
  model: string;
  dir?: string;
}): Promise<PiAgentSessionFactory> {
  const cwd = options.agentDir;
  // Credentials resolve the way the opener resolves them (FASTAGENT_AUTH_PATH > the agent's own
  // .secrets/auth.json), NOT the credential store's bare default: an OAuth provider has no env key to
  // fall back to, so a probe that skipped this knob could only ever be run against an API-key provider.
  const modelRuntime = await createPiModelRuntime({
    agentDir: options.agentDir,
    authPath: resolveAuthPath(options.agentDir, undefined),
  });
  const model = resolveModel(modelRuntime, options.model);
  const services = await createAgentSessionServices({
    cwd,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPromptOverride: () => "Answer in as few words as possible.",
      appendSystemPromptOverride: () => [],
      skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
    },
  });
  const store =
    options.dir === undefined ? piInMemorySessionRecordStore({ cwd }) : piSessionRecordStore({ dir: options.dir, cwd });
  return async (sessionId) => {
    const sessionManager = await store.openOrCreate(sessionId);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      noTools: "builtin", // a protocol subject, not an agent: the coding tools stay off
    });
    return session;
  };
}

async function liveAgent(dir?: string): Promise<Agent> {
  const factory = await sessionFactory({ agentDir: await agentDir(), model: MODEL, ...(dir ? { dir } : {}) });
  return createPiAgentFromSession({ sessionFactory: factory });
}

/** An agent dir whose models.json points at a local endpoint that answers 400 to every request. */
async function refusingEndpointAgent(): Promise<Agent> {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "live probe: endpoint refuses this request", type: "bad_request" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const dir = await agentDir();
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        refusing: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "live-probe",
          models: [{ id: "refuses" }],
        },
      },
    }),
  );
  return createPiAgentFromSession({
    sessionFactory: await sessionFactory({ agentDir: dir, model: "refusing/refuses" }),
  });
}

describeSpecConformance(`pi AgentSession over ${MODEL} (live)`, {
  completing: () => liveAgent(),

  failing: () => refusingEndpointAgent(),

  hanging: async (onCleanup) => {
    const factory = await sessionFactory({ agentDir: await agentDir(), model: MODEL });
    // The engine's cancel cleanup is session.abort() — intercepted as the probe, exactly as the
    // offline subject does it. What is live here is that a real streaming HTTP response is what gets
    // torn down, which is the half a faux provider cannot exercise.
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
});

describe(`live model: ${MODEL}`, () => {
  it("MUST 6 portable — a second instance over the same record continues the conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-pair-"));
    const session = "-1001234567890"; // a telegram group id: pi refuses it verbatim
    const first = await liveAgent(dir);
    await collect(first.invoke({ session }, { text: "Remember this number: 47. Reply with just: ok" }));

    // A second agent instance over the same directory — nothing shared in process but the disk. The
    // witness is a literal crossing the instance boundary, never the model's phrasing.
    const second = await liveAgent(dir);
    const { text } = await collect(
      second.invoke({ session }, { text: "What number did I ask you to remember? Reply with digits only." }),
    );
    expect(text).toContain("47");
  });
});
