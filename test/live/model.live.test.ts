/**
 * A definition directory served by a REAL provider, opened the way the product opens one.
 *
 * The probe drives `createPiAgentFromDir` — the same opener `dev`, `start` and `invoke` drive — and
 * observes only from outside: what the turn answers, and what a failing one reports. It deliberately
 * does NOT reach for the `AgentSession` L0 underneath, even though that layer offers observation
 * points this file cannot have (intercepting `session.abort`, for one). Rebuilding the opener to get
 * at them means re-doing everything it does — proxy install, credential resolution, pinning pi's own
 * agent dir away from `~/.pi/agent` — and every one of those was missed at least once here. A probe
 * that rebuilds the assembly measures the rebuild's fidelity, not the product.
 *
 * SPEC conformance therefore stays where it can be asserted honestly: test/conformance-session.test.ts
 * runs the full suite (MUST 1/2/3/6) against the L0 on a faux model. Cancellation in particular gains
 * nothing from a live provider — the assertion is that the engine's abort ran, which is identical in
 * both worlds. What only a real provider can settle is here: a real stream completes, a real HTTP
 * error becomes a `failed` terminal with the right `retryable`, and a real record carries a
 * conversation across two independent instances.
 *
 * `FASTAGENT_LIVE_MODEL` selects the model ("provider/modelId"); credentials resolve as the product
 * resolves them — `FASTAGENT_AUTH_PATH`, else the agent's own `.secrets/auth.json`, else the
 * provider's env key. An OAuth provider (openai-codex) has only the first, so point the variable at a
 * logged-in file.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { collect } from "../../src/collect.ts";
import { createPiAgentFromDir } from "../../src/engines/pi/open.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { requireEnv } from "./env.ts";

// Node's own fetch ignores HTTPS_PROXY, so a correctly configured machine still needs this call to
// honour it. Every CLI entry makes it and the LIBRARY opener deliberately does not — proxy wiring
// belongs to the process, not to the assembly — so an embedder owes it, and this probe is one.
// Nothing beyond this line is the probe's business: whether a given host bypasses the proxy is the
// runner's environment to get right, and a probe that edited NO_PROXY would be hiding that.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/**
 * An agent directory as an author would write one: a persona and a config naming the model. The
 * directory IS the agent (no nesting), so the opener resolves it as both agent dir and workspace.
 */
async function agentDirectory(model: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-live-model-"));
  await writeFile(join(dir, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(model)} };\n`);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Drain a turn without letting a `failed` terminal throw — the SPEC's own discipline (MUST 2). */
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** A definition whose models.json points at a local endpoint that answers 400 to every request.
 *  models.json is definition data, so this failure arrives through the product's own path. */
async function refusingDefinition(): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "live probe: endpoint refuses this request", type: "bad_request" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return agentDirectory("refusing/refuses", {
    "models.json": JSON.stringify({
      providers: {
        refusing: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "live-probe",
          models: [{ id: "refuses" }],
        },
      },
    }),
  });
}

describe(`live model: ${MODEL}`, () => {
  it("a real stream reaches a completed terminal with an answer", async () => {
    const { agent } = await createPiAgentFromDir(await agentDirectory(MODEL));
    const { text } = await collect(agent.invoke({ session: "live-answer" }, { text: "Reply with just: ok" }));
    expect(text.trim()).not.toBe("");
  });

  it("MUST 6 portable — a second instance over the same record continues the conversation", async () => {
    // One directory, opened twice: two agent instances sharing nothing in process but the disk, which
    // is what a horizontally-scaled deployment is.
    const dir = await agentDirectory(MODEL);
    const session = "-1001234567890"; // a telegram group id: pi refuses it verbatim
    const { agent: first } = await createPiAgentFromDir(dir);
    await collect(first.invoke({ session }, { text: "Remember this number: 47. Reply with just: ok" }));

    const { agent: second } = await createPiAgentFromDir(dir);
    const { text } = await collect(
      second.invoke({ session }, { text: "What number did I ask you to remember? Reply with digits only." }),
    );
    // The witness is a literal crossing the instance boundary, never the model's phrasing.
    expect(text).toContain("47");
  });

  it("a real HTTP error becomes a failed terminal, classified non-retryable", async () => {
    const { agent } = await createPiAgentFromDir(await refusingDefinition());
    // MUST 2: iteration must not throw — a rejection here is the violation, not a failed event.
    const events = await drain(agent.invoke({ session: "live-refused" }, { text: "go" }));
    // 400 is decisive: re-sending it would fail identically, and `retryable` is what a caller branches
    // on. This is the half a faux provider cannot settle — the shape of a real provider error as it
    // travels through pi's stack into our classifier.
    expect(events.at(-1)).toMatchObject({ type: "failed", retryable: false });
  });
});
