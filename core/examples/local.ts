/**
 * Run a minimal serial agent locally, for real.
 *
 * Auth, session continuity (in-memory, this process only) and execution env are all
 * handled by createPiAgent's defaults (dev batteries-included); this file only owns
 * two **application-level** concerns: the process-level proxy and which model to use.
 *
 * Run (Node >=22.19 executes .ts natively):
 *   node examples/local.ts "say hi in 3 words"   # one-shot
 *   node examples/local.ts                        # REPL; same session keeps memory; /exit to quit
 *   node examples/local.ts --busy-demo            # concurrent same-session → one runs, one "session busy"
 */
import { createInterface } from "node:readline/promises";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import { AgentFailure, collect, createPiAgent, createPiModels, resolveModel, type AgentEvent } from "../src/index.ts";

// Process-level network config belongs to the application entry: Node's fetch does not
// honor HTTPS_PROXY by itself; the local proxy is required to reach blocked providers.
// install() aligns fetch with the dispatcher (same undici impl) — see cli.ts for why.
setGlobalDispatcher(new EnvHttpProxyAgent());
installUndiciFetch();

// One Models collection owns model resolution + auth; the model must come from it.
const models = createPiModels();
const agent = createPiAgent({
  models,
  model: resolveModel(models, "openai-codex/gpt-5.5"),
  systemPrompt: "You are a concise, helpful assistant. Keep answers short.",
});

/** Stream-render one turn to stdout. */
async function turn(text: string): Promise<void> {
  process.stdout.write("agent> ");
  for await (const e of agent.invoke({ session: "local" }, { text })) {
    if (e.type === "text") process.stdout.write(e.delta);
    else if (e.type === "tool_started") process.stdout.write(`\n[tool ${e.name} ${JSON.stringify(e.args)}]\n`);
    else if (e.type === "tool_ended") process.stdout.write(`[tool done]\n`);
    else if (e.type === "completed") process.stdout.write("\n");
    else if (e.type === "failed") process.stdout.write(`\n[failed: ${e.details} (retryable=${e.retryable})]\n`);
  }
}

const arg = process.argv.slice(2).join(" ").trim();

if (arg === "--busy-demo") {
  // Demonstrate fail-fast: concurrent same-session invokes → A runs, B gets "session busy"
  // immediately (the REPL is serial, so this is the only way to show it here).
  console.log("Concurrent same-session: A runs, B should fail fast with session busy\n");
  const summarize = async (label: string, stream: AsyncIterable<AgentEvent>) => {
    try {
      const { text } = await collect(stream); // buffered consumption + terminal discipline
      console.log(`[${label}] completed: ${text.slice(0, 60)}…`);
    } catch (e) {
      if (e instanceof AgentFailure) console.log(`[${label}] failed: ${e.details} (retryable=${e.retryable})`);
      else throw e;
    }
  };
  await Promise.all([
    summarize("A", agent.invoke({ session: "d" }, { text: "Count slowly from 1 to 8." })),
    summarize("B", agent.invoke({ session: "d" }, { text: "Say hi." })),
  ]);
  process.exit(0);
}

if (arg) {
  await turn(arg);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Minimal serial agent. Type a message; /exit to quit. Same session keeps memory.\n");
  while (true) {
    const text = (await rl.question("you> ")).trim();
    if (!text || text === "/exit") break;
    await turn(text);
  }
  rl.close();
}

// The undici proxy agent's keep-alive connections keep the event loop alive; exit explicitly.
process.exit(0);
