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
import { loadModuleDir } from "../src/loader.ts";
import { makeFaux, sentPrompt, sentTools } from "./faux.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  return liveTools(boot, { stamp: boot.toolsStamp, tools: boot.tools });
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
  expect(await callGreet((await readTools()).tools)).toBe("hello from /the/workspace");

  // Only the HELPER changes. Node's own import cache would keep it (a busted entry URL re-reads the entry alone).
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "good morning";\n`);

  // `/the/workspace`, not this process's cwd: the reloaded tool re-evaluated fastagent's source, and still reads the
  // one turn context the host sets.
  expect(await callGreet((await readTools()).tools)).toBe("good morning from /the/workspace");
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

it("a reload that fails keeps the tools that loaded, logs once, tells the model while broken, and recovers", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  const warned: string[] = [];
  vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  vi.spyOn(log, "info").mockImplementation(() => {});

  await writeFile(join(dir, "tools", "broken.ts"), "export default {\n");
  const broken = await readTools();
  expect(await callGreet(broken.tools)).toBe("hello from /the/workspace");
  expect(broken.failure).toMatch(/tools\/broken\.ts/);
  // The log is not re-announced every turn; the model, which has no log, hears it every turn the state lasts.
  expect((await readTools()).failure).toBe(broken.failure);
  expect(warned.filter((line) => line.includes("tools/ changed but could not be loaded"))).toHaveLength(1);

  await rm(join(dir, "tools", "broken.ts"));
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "fixed";\n`);
  const fixed = await readTools();
  expect(await callGreet(fixed.tools)).toBe("fixed from /the/workspace");
  expect(fixed.failure).toBeUndefined();
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
  let failure: string | undefined;
  const dir = await mkdtemp(join(tmpdir(), "fa-live-bind-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  const { assembly } = await assemblePiFromDefinition(dir, {
    model: "faux/faux-1",
    providers: [faux.provider],
    tools: current,
    readTools: async () => ({ tools: current, failure }),
  });
  const agent = agentOf(assembly);

  await collect(agent.invoke({ session: "s" }, { text: "one" }));
  current = [tool("second")];
  failure = "tools/third.ts failed to load";
  await collect(agent.invoke({ session: "s" }, { text: "two" }));

  expect(seen[0]?.tools).toContain("first");
  expect(seen[0]?.prompt).not.toContain("could not be loaded");
  expect(seen[1]?.tools).toContain("second");
  expect(seen[1]?.tools).not.toContain("first");
  expect(seen[1]?.prompt).toContain("- second: The second tool.");
  expect(seen[1]?.prompt).toMatch(/tools\/ changed but could not be loaded[\s\S]*tools\/third\.ts failed to load/);
});

it("reloads under Bun too — whose own import() would keep the first module forever", async () => {
  // jiti turns native imports ON when it sees `Bun`, and a native import is the cache that never lets go: every
  // reload then logged "reloaded" over the old tools. The global is what jiti looks at, so this is that path.
  vi.stubGlobal("Bun", {});
  const dir = await agentDir();
  const readTools = await live(dir);
  vi.spyOn(log, "info").mockImplementation(() => {});

  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "from bun";\n`);

  expect(await callGreet((await readTools()).tools)).toBe("from bun from /the/workspace");
});

it("one load evaluates a helper its tools share ONCE — a pool stays one pool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-live-shared-"));
  await mkdir(join(dir, "tools", "lib"), { recursive: true });
  await writeFile(join(dir, "tools", "lib", "pool.ts"), "export const pool = {};\n");
  await writeFile(join(dir, "tools", "a.ts"), 'export { pool as default } from "./lib/pool.ts";\n');
  await writeFile(join(dir, "tools", "b.ts"), 'export { pool as default } from "./lib/pool.ts";\n');
  await writeFile(join(dir, "tools", "broken.ts"), "export default {\n");

  const { modules, failures } = await loadModuleDir(join(dir, "tools"), { fresh: true });

  const [a, b] = modules.map((module) => module.mod.default);
  expect(a).toBeDefined();
  expect(a).toBe(b);
  // ...and loading them together still isolates the one that is broken.
  expect(failures.map((failure) => failure.label)).toEqual(["tools/broken.ts"]);
});

it("a reloaded tool that takes a mounted name is said, not silently absent", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  const warned: string[] = [];
  vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  vi.spyOn(log, "info").mockImplementation(() => {});

  // `read` is a coding tool, so this file's tool is dropped.
  await writeFile(join(dir, "tools", "read.ts"), greet());
  await readTools();

  expect(warned.join("\n")).toMatch(/tool "read" \(tools\/read\) dropped/);
});

it("a change only Node's cache would serve is said to need a restart — never logged as reloaded", async () => {
  // An ESM `.js`/`.mjs`, a `.cjs` or a `.json` is loaded by Node itself, which keeps it as first read. pi's `/reload`
  // has the same line; what must not happen is "reloaded" over a file that did not.
  const dir = await agentDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const readTools = await live(dir);
  const warned: string[] = [];
  const informed: string[] = [];
  vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  vi.spyOn(log, "info").mockImplementation((message) => void informed.push(message));
  const evaluations = () => (globalThis as { __faGreetEvaluations?: number }).__faGreetEvaluations ?? 0;
  const before = evaluations();

  await writeFile(join(dir, "tools", "lib", "limits.js"), "export const max = 2;\n");
  await readTools();

  expect(warned.join("\n")).toMatch(/tools\/lib\/limits\.js changed — only TypeScript in tools\/ reloads/);
  expect(informed.join("\n")).not.toMatch(/reloaded/);
  expect(evaluations()).toBe(before);

  // Alongside a TypeScript change, the TypeScript still reloads — and the rest is still said.
  warned.length = 0;
  await writeFile(join(dir, "tools", "lib", "limits.js"), "export const max = 3;\n");
  await writeFile(join(dir, "tools", "lib", "word.ts"), `export const word = "mixed";\n`);
  expect(await callGreet((await readTools()).tools)).toBe("mixed from /the/workspace");
  expect(warned.join("\n")).toMatch(/tools\/lib\/limits\.js changed/);
});

it("a file nothing imports is not a change — no restart notice, no reload", async () => {
  const dir = await agentDir();
  const readTools = await live(dir);
  const logged: string[] = [];
  vi.spyOn(log, "warn").mockImplementation((message) => void logged.push(message));
  vi.spyOn(log, "info").mockImplementation((message) => void logged.push(message));
  const evaluations = () => (globalThis as { __faGreetEvaluations?: number }).__faGreetEvaluations ?? 0;
  const before = evaluations();

  await writeFile(join(dir, "tools", "README.md"), "# tools\n");
  await writeFile(join(dir, "tools", ".greet.ts.swp"), "swap");
  await readTools();

  expect(logged).toEqual([]);
  expect(evaluations()).toBe(before);
});

it("a tool file of any name loads — the load's own entry cannot shadow one", async () => {
  // jiti keys its cache by the entry's path; a real `tools/<that name>` would have been answered with the entry.
  const dir = await mkdtemp(join(tmpdir(), "fa-live-entry-"));
  await mkdir(join(dir, "tools"), { recursive: true });
  await writeFile(join(dir, "tools", "fastagent-load.mjs"), 'export default "mine";\n');
  await writeFile(join(dir, "tools", "fastagent-load.ts"), 'export default "mine too";\n');

  const { modules, failures } = await loadModuleDir(join(dir, "tools"), { fresh: true });

  expect(failures).toEqual([]);
  expect(modules.map((module) => module.mod.default)).toEqual(["mine", "mine too"]);
});
