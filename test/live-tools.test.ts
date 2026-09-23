/**
 * The agent's own `tools/` go live without a restart (open.ts `liveTools`, docs/design/core.md §2): each invoke
 * reloads them when a file under `tools/` changed, a failed reload keeps the last tools that loaded, and a turn
 * binds — and the prompt lists — the tools of THAT invoke.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { collect } from "../src/index.ts";
import { agentOf, assemblePiFromDefinition } from "../src/engines/pi/create.ts";
import { liveTools, resolveAgentAssembly } from "../src/engines/pi/open.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";
import type { MountedTool } from "../src/engines/pi/tool.ts";
import { log } from "../src/log.ts";
import { makeFaux, sentPrompt, sentTools } from "./faux.ts";

afterEach(() => vi.restoreAllMocks());

const piUrl = new URL("../src/pi.ts", import.meta.url).href;

/** A `greet` tool that answers with a word from a helper it imports, and the `cwd` its turn gave it. */
const greet = (extra = "") => `import { defineTool, z } from ${JSON.stringify(piUrl)};
import { word } from "./lib/word.ts";
globalThis.__faGreetEvaluations = (globalThis.__faGreetEvaluations ?? 0) + 1;
export default defineTool({
  name: "greet",
  description: "Greet.",
  input: z.object({}),
  execute: async (_input, ctx) => \`\${word} from \${ctx.cwd}\`,
});
${extra}`;

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-live-tools-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "openai-codex/gpt-5.5" };\n`);
  await mkdir(join(dir, "tools", "lib"), { recursive: true });
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "hello";\n`);
  await writeFile(join(dir, "tools", "greet.ts"), greet());
  return dir;
}

/** The directory opener's live tools, over the same assembly boot uses. */
async function live(dir: string) {
  const boot = await resolveAgentAssembly(dir);
  return liveTools(
    { stamp: boot.toolsStamp, tools: boot.tools },
    async () => (await resolveAgentAssembly(dir)).tools,
    dir,
  );
}

/** Call `greet` the way a turn does: inside the turn's context. */
async function callGreet(tools: MountedTool[]): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === "greet");
  if (!tool) return "(no greet)";
  const result = await turnContext.run({ cwd: "/the/workspace" }, () => tool.execute("call-1", {}));
  return (result.content[0] as { text: string }).text;
}

it("a rewritten helper reaches the next invoke — and the tool still sees its turn", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  expect(await callGreet(await readTools())).toBe("hello from /the/workspace");

  // Only the HELPER changes. Node's own import cache would keep it (a busted entry URL re-reads the entry alone).
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "good morning";\n`);

  // `/the/workspace`, not this process's cwd: the reloaded tool re-evaluated fastagent's source, and still reads the
  // one turn context the host sets.
  expect(await callGreet(await readTools())).toBe("good morning from /the/workspace");
});

it("an unchanged tools/ is not imported again", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  const evaluations = () => (globalThis as { __faGreetEvaluations?: number }).__faGreetEvaluations ?? 0;
  const before = evaluations();

  await readTools();
  await readTools();

  expect(evaluations()).toBe(before);
});

it("a reload that fails keeps the tools that loaded, says so once, and recovers when fixed", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  const warned: string[] = [];
  vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  vi.spyOn(log, "info").mockImplementation(() => {});

  await writeFile(join(dir, "tools", "broken.ts"), "export default {\n");
  expect(await callGreet(await readTools())).toBe("hello from /the/workspace");
  await readTools(); // the same broken state is not re-announced every turn

  expect(warned.filter((line) => line.includes("tools/ changed but could not be loaded"))).toHaveLength(1);
  expect(warned.join("\n")).toMatch(/tools\/broken\.ts/);

  await rm(join(dir, "tools", "broken.ts"));
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "fixed";\n`);
  expect(await callGreet(await readTools())).toBe("fixed from /the/workspace");
});

it("each invoke binds, and its prompt lists, the tools read for THAT invoke", async () => {
  const { faux } = makeFaux();
  const seen: { tools: string[]; prompt: string }[] = [];
  const record = (context: Parameters<typeof sentPrompt>[0]) => {
    seen.push({ tools: sentTools(context), prompt: sentPrompt(context) });
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([record, record]);
  const tool = (name: string): MountedTool => ({
    name,
    label: name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  });
  let current = [tool("first")];
  const dir = await mkdtemp(join(tmpdir(), "fa-live-bind-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  const { assembly } = await assemblePiFromDefinition(dir, {
    model: "faux/faux-1",
    providers: [faux.provider],
    tools: current,
    readTools: async () => current,
  });
  const agent = agentOf(assembly);

  await collect(agent.invoke({ session: "s" }, { text: "one" }));
  current = [tool("second")];
  await collect(agent.invoke({ session: "s" }, { text: "two" }));

  expect(seen[0]?.tools).toContain("first");
  expect(seen[1]?.tools).toContain("second");
  expect(seen[1]?.tools).not.toContain("first");
  expect(seen[1]?.prompt).toContain("- second: The second tool.");
});
