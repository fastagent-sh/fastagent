/**
 * Library embedding example: "point at a definition folder → agent" via the
 * library API (createPiAgentFromDefinition) instead of the `fastagent dev` CLI.
 * Use this pattern when embedding fastagent inside your own app/server.
 * For the product path (config + CLI), see examples/agent/fastagent.config.ts.
 *
 * Run:
 *   node examples/definition.ts "My app crashes when I click save"
 *   node examples/definition.ts "Can I get my money back? Bought it 3 weeks ago"   # triggers refund-policy skill
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import { createPiAgentFromDefinition, createPiModels, piDefaultTools, resolveModel } from "../src/index.ts";
import lookupOrderTool from "./agent/lookup-order-tool.ts";

// install() aligns fetch with the dispatcher (same undici impl) — see cli.ts for why.
setGlobalDispatcher(new EnvHttpProxyAgent());
installUndiciFetch();

// Custom code tool = explicit import + injection (type-checked, refactor-safe; no magic directory).
const dir = join(dirname(fileURLToPath(import.meta.url)), "agent");
const models = createPiModels();
const { agent, definition } = await createPiAgentFromDefinition(dir, {
  models,
  model: resolveModel(models, "openai-codex/gpt-5.5"),
  tools: [...piDefaultTools(dir), lookupOrderTool],
});

console.error(`[definition] ${definition.dir}`);
console.error(`[instructions] ${definition.instructions ? "AGENTS.md loaded" : "(none)"}`);
console.error(`[skills] ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
for (const d of definition.diagnostics) console.error(`[warn] ${d.code}: ${d.message}`);
console.error();

const text = process.argv.slice(2).join(" ").trim() || "My app crashes when I click save";
for await (const e of agent.invoke({ session: "triage" }, { text })) {
  if (e.type === "text") process.stdout.write(e.delta);
  else if (e.type === "tool_started") process.stdout.write(`\n[tool ${e.name} ${JSON.stringify(e.args)}]\n`);
  else if (e.type === "tool_ended") process.stdout.write(`[tool done]\n`);
  else if (e.type === "completed") process.stdout.write("\n");
  else if (e.type === "failed") process.stdout.write(`\n[failed: ${e.details}]\n`);
}
process.exit(0);
