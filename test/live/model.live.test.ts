/**
 * A definition directory served by a REAL provider, opened the way the product opens one.
 *
 * The probe drives `openServing` — the same opener `dev`, `start` and `invoke` drive — and observes only from
 * outside: what a message answers, and what a failing one reports. A probe that rebuilds the assembly measures the
 * rebuild's fidelity, not the product.
 *
 * Agent API conformance stays where it can be asserted honestly: test/durable-agent.test.ts runs the suite against
 * pi-durable on a faux model. What only a real provider can settle is here: a real stream completes, a real HTTP
 * error becomes a failed message with the right `retryable`, the storage carries a conversation across two
 * processes, and a real model CALLS a tool this repo described to it.
 *
 * `FASTAGENT_LIVE_MODEL` selects the model ("provider/modelId"); credentials resolve as the product
 * resolves them — `FASTAGENT_AUTH_PATH`, else the agent's own `.secrets/auth.json`, else the
 * provider's env key. An OAuth provider (openai-codex) has only the first, so point the variable at a
 * logged-in file.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Agent, DoneMessage } from "../../src/agent-api.ts";
import { type OpenServingOptions, openServing } from "../../src/harnesses/pi-durable/serve.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { requireEnv } from "./env.ts";

// Node's own fetch ignores HTTPS_PROXY, so a correctly configured machine still needs this call to
// honour it. Every CLI entry makes it and the LIBRARY opener deliberately does not — proxy wiring
// belongs to the process, not to the assembly — so an embedder owes it, and this probe is one.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** The repository's packages, for a fixture's own imports: a fixture directory has no node_modules of its own. */
const linkPackages = (dir: string) =>
  symlink(new URL("../../node_modules", import.meta.url).pathname, join(dir, "node_modules"), "dir");

/**
 * An agent directory as an author would write one: a system prompt and a configuration naming the model. The
 * directory IS the agent, and its working directory.
 */
async function agentDirectory(config: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-live-model-"));
  await writeFile(join(dir, "SYSTEM.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(dir, "fastagent.config.ts"), config);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}
const modelConfig = (model: string) => `export default { model: ${JSON.stringify(model)} };\n`;

/** The directory opened the product's way; closed when the file is done. */
async function open(dir: string, options: OpenServingOptions = { storage: "memory" }) {
  const opened = await openServing(dir, options);
  cleanups.push(() => opened.agent.close());
  return opened;
}

/** Send one message in `sessionId` (a new session without one) and wait for how it ended. */
async function ask(agent: Agent, text: string, sessionId?: string): Promise<DoneMessage & { sessionId: string }> {
  const session = sessionId ?? (await agent.createSession());
  const id = typeof session === "string" ? session : session.ok ? session.sessionId : undefined;
  if (id === undefined) throw new Error(`no session: ${JSON.stringify(session)}`);
  const sent = await agent.invoke({ sessionId: id, content: [{ type: "text", text }] });
  if (!sent.ok) throw new Error(`not sent: ${JSON.stringify(sent)}`);
  const end = await sent.wait();
  if (!end.ok) throw new Error(`the wait ended first: ${end.unfinished.reason}`);
  return { ...end.message, sessionId: id };
}

/** A definition whose provider points at a local endpoint that answers 400 to every request. */
async function refusingDefinition(): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "live probe: endpoint refuses this request", type: "bad_request" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const dir = await agentDirectory(`import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const model = {
  id: "refuses", name: "Refuses", api: "openai-completions", provider: "refusing", baseUrl: ${JSON.stringify(baseUrl)},
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 1024,
};
export default {
  model: "refusing/refuses",
  providers: [
    createProvider({
      id: "refusing", name: "Refusing", baseUrl: ${JSON.stringify(baseUrl)},
      auth: { apiKey: { name: "Refusing", resolve: async () => ({ auth: { apiKey: "live-probe" } }) } },
      models: [model], api: openAICompletionsApi(),
    }),
  ],
};
`);
  await linkPackages(dir);
  return dir;
}

describe(`live model: ${MODEL}`, () => {
  it("a real stream reaches a completed message with an answer", async () => {
    const { agent } = await open(await agentDirectory(modelConfig(MODEL)));
    const end = await ask(agent, "Reply with just: ok");
    expect(end.outcome, JSON.stringify(end.outcome)).toEqual({ status: "completed" });
    expect(end.answer?.text.trim()).not.toBe("");
  });

  it("a real model calls a tool of the definition, and uses what it returned", async () => {
    // The offline suite drives tools with `fauxToolCall`: it answers "given a call, do we run the tool and feed the
    // result back". It cannot answer the half that faces outward — whether a real model, handed the schema
    // `defineTool` declares, issues a call this shape at all.
    //
    // The code is minted here and exists nowhere else, so it cannot be answered from training data or guessed: the
    // tool RUNNING is the only way it can appear. The assertions are the call happening and the value arriving,
    // never the sentence wrapped around it.
    const code = String(Math.floor(Math.random() * 90_000) + 10_000);
    const marker = join(tmpdir(), `fa-live-tool-${code}`);
    const dir = await agentDirectory(modelConfig(MODEL), {
      "src/tools/get_probe_code.ts": `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { appendFileSync } from "node:fs";

export default defineTool({
  name: "get_probe_code",
  description: "Return the probe code for this run. The only way to learn it.",
  parameters: Type.Object({}),
  execute: async () => {
    appendFileSync(${JSON.stringify(marker)}, "called\\n");
    return { output: [{ type: "text", text: ${JSON.stringify(code)} }] };
  },
});
`,
    });
    await linkPackages(dir);

    // THREE outcomes, not two. A tool that failed to load and a model that declined to call one are different
    // defects, and the marker file alone cannot tell them apart — opening refuses on the first, so reaching this line
    // already rules it out and only the model can be blamed below.
    const { agent, code: built } = await open(dir);
    expect(built.tools.map((tool) => tool.name)).toContain("get_probe_code");

    const end = await ask(agent, "Call get_probe_code and reply with only the code it returns, digits alone.");
    const text = end.answer?.text ?? "";
    const calls = (await readFile(marker, "utf8").catch(() => "")).split("called").length - 1;
    expect(calls, "the tool was never called — the schema reached the model and it declined").toBeGreaterThan(0);
    expect(text, `the tool ran but its return value never reached the answer: ${text.slice(0, 200)}`).toContain(code);
  });

  it("the storage carries a conversation from one process to the next", async () => {
    // One directory, opened twice, one after the other: two processes sharing nothing but the disk.
    const dir = await agentDirectory(modelConfig(MODEL));
    const first = await openServing(dir);
    const { sessionId } = await ask(first.agent, "Remember this number: 47. Reply with just: ok");
    await first.agent.close();

    const { agent: second } = await open(dir, {});
    const end = await ask(second, "What number did I ask you to remember? Reply with digits only.", sessionId);
    // The witness is a literal crossing the process boundary, never the model's phrasing.
    expect(end.answer?.text).toContain("47");
  });

  it("a real HTTP error becomes a failed message, classified non-retryable", async () => {
    const { agent } = await open(await refusingDefinition());
    // A failed message is an outcome, never a thrown error. 400 is decisive: re-sending it would fail identically, and
    // `retryable` is what a caller branches on. This is the half a faux provider cannot settle: the shape of a real
    // provider error as it travels through pi's stack into our classifier.
    const end = await ask(agent, "go");
    expect(end.outcome, JSON.stringify(end.outcome)).toMatchObject({ status: "failed", error: { retryable: false } });
  });
});
