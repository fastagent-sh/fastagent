import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxAgent } from "./agent.ts";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collect, defineTool, z } from "../src/index.ts";
import { loadTools } from "../src/harnesses/pi/tool.ts";
import {
  CODING_TOOL_NAMES,
  createPiAgentFromDefinition,
  fastagentPromptSections,
  piAllCodingTools,
  resolveAgentTools,
} from "../src/harnesses/pi/create.ts";
import { log } from "../src/log.ts";
import { makeFaux, sentPrompt } from "./faux.ts";

describe("defineTool", () => {
  it("builds a pi AgentTool: JSON-schema parameters, validated + auto-wrapped execute", async () => {
    const tool = defineTool({
      name: "add",
      description: "Add a and b.",
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }) {
        return { sum: a + b }; // plain value
      },
    });
    expect(tool.name).toBe("add");
    const params = tool.parameters as { type: string; properties: Record<string, unknown>; $schema?: unknown };
    expect(params.type).toBe("object");
    expect(Object.keys(params.properties).sort()).toEqual(["a", "b"]);
    expect(params.$schema).toBeUndefined(); // dialect marker stripped

    // valid args → user value wrapped into pi's result shape
    const ok = await tool.execute("c1", { a: 2, b: 3 });
    expect(ok.details).toEqual({ sum: 5 });
    expect(ok.content[0]).toMatchObject({ type: "text" });

    // invalid args → an error RESULT (reported to the model), not a thrown exception
    const bad = await tool.execute("c2", { a: "x" });
    expect(JSON.stringify(bad)).toMatch(/Invalid arguments|expected number/);
  });

  it("passes executionMode through to pi — the author's only way to serialize a batch", async () => {
    // Authored tools own their execution mode; the adapter must preserve it.
    expect(
      defineTool({ name: "a", description: "d", input: z.object({}), execute: async () => "" }),
    ).not.toHaveProperty("executionMode");
    const serial = defineTool({
      name: "b",
      description: "d",
      input: z.object({}),
      executionMode: "sequential",
      execute: async () => "",
    });
    expect(serial.executionMode).toBe("sequential");
  });

  it("uses the unified ToolContext without a duplicate session id", async () => {
    let context: Record<string, unknown> | undefined;
    const tool = defineTool({
      name: "ordinary",
      description: "ordinary",
      input: z.object({}),
      execute(_input, ctx) {
        context = ctx as unknown as Record<string, unknown>;
        return "ok";
      },
    });
    await tool.execute("c", {});
    expect(context?.cwd).toBe(process.cwd());
    expect(context?.sessionManager).toBeUndefined();
    expect(context).not.toHaveProperty("session");
  });

  it("passes a full {content,details} result through unchanged", async () => {
    const tool = defineTool({
      name: "raw",
      description: "d",
      input: z.object({}),
      async execute() {
        return { content: [{ type: "text", text: "hi" }], details: 42 };
      },
    });
    const r = await tool.execute("c", {});
    expect(r.details).toBe(42);
    expect(r.content[0]).toMatchObject({ text: "hi" });
  });

  it("asks the provider to constrain sampling to the tool's schema", async () => {
    const tool = defineTool({
      name: "search",
      description: "d",
      input: z.object({
        query: z.string(),
        limit: z.number().optional(),
        cursor: z.string().nullable(),
        page: z.object({ size: z.number().optional() }).optional(),
      }),
      async execute(input) {
        return input;
      },
    });

    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    // Not a no-op: pi can express THIS schema strictly, so the request really is constrained. A schema it
    // cannot (and a provider without strict mode) falls back to an ordinary function tool under "prefer".
    expect(() => makeStrictJsonSchema(tool.parameters as never)).not.toThrow();
  });

  it("through a real turn: a strict-schema null is dropped only where the author's schema rejects it", async () => {
    // What constrained sampling costs, and the exact rule for it. A model sampling against pi's strict form of
    // the schema must send every key, so an omitted optional arrives as `null`; pi-ai normalizes those away
    // before execute, but only where the author's own schema rejects null. So `limit` (optional number) is
    // dropped and `note` (nullable AND optional) is NOT — that field can no longer tell "absent" from "null",
    // which is the one behavior change this carries for an author. Asserted through a real turn because pi
    // validates against the UNrewritten schema before execute, which a unit call would not exercise.
    let seen: unknown;
    const tool = defineTool({
      name: "search",
      description: "d",
      input: z.object({
        query: z.string(),
        limit: z.number().optional(),
        note: z.string().nullable().optional(),
      }),
      async execute(input) {
        seen = input;
        return "ok";
      },
    });
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("search", { query: "q", limit: null, note: null }, { id: "c1" })),
        fauxAssistantMessage("done"),
      ],
      { tools: [tool] },
    );

    const events: { type: string }[] = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "go" })) events.push(e);

    expect(events.at(-1)?.type).toBe("completed");
    expect(seen).toEqual({ query: "q", note: null });
  });
});

/** A tool as a module below tools/ writes it, without importing this package from a temporary directory. */
const toolSource = (name: string) =>
  `{ name: ${JSON.stringify(name)}, description: "d", parameters: { type: "object" }, async execute() { return { content: [], details: "" }; } }`;

/** An agent directory whose tools/ holds these files, by path below tools/. */
async function toolsDir(files: Record<string, string>): Promise<string> {
  // The real path: a module re-exported through a symlinked temp dir would otherwise load twice under vitest.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-tools-tree-")));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "tools", path)), { recursive: true });
    await writeFile(join(dir, "tools", path), content);
  }
  return dir;
}

describe("loadTools (filesystem discovery)", () => {
  it("discovers tools/* and names them from the filename; missing tools/ is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    expect((await loadTools(dir)).tools).toEqual([]); // no tools/ dir yet

    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "ping.mjs"),
      `export default { description: "p", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "pong" }], details: "pong" }; } };`,
    );
    const { tools, collisions } = await loadTools(dir);
    expect(tools.map((t) => t.name)).toEqual(["ping"]); // filename = name
    expect(collisions).toEqual([]);
    expect((await tools[0]!.execute("c", {})).details).toBe("pong");
  });

  it("resolveAgentTools discovers tools/ from agentDir, NOT from cwd (guards the agentDir/cwd param split)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-ws-cwd-"));
    const agentDir = join(cwd, "agent");
    const tool = `export default { description: "d", parameters: { type: "object" }, async execute() { return { content: [], details: "" }; } };`;
    await mkdir(join(agentDir, "tools"), { recursive: true });
    await writeFile(join(agentDir, "tools", "foo.mjs"), tool); // the agent's own tool (in agentDir)
    await mkdir(join(cwd, "tools"), { recursive: true });
    await writeFile(join(cwd, "tools", "hostonly.mjs"), tool); // the host repo's tool at cwd — must NOT be scanned

    const { toolNames } = await resolveAgentTools({}, agentDir);
    expect(toolNames).toContain("foo"); // discovered from agentDir
    expect(toolNames).not.toContain("hostonly"); // cwd's own tools/ is the host's, not the agent's surface
  });

  it("always mounts every coding tool", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fa-tools-all-"));
    const resolved = await resolveAgentTools({}, agentDir);
    expect(resolved.tools.map((tool) => tool.name)).toEqual([...CODING_TOOL_NAMES]);
    expect(resolved.toolNames).toEqual([]); // no authored tools
  });

  it("keeps a coding built-in when authored tools reuse its name", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fa-tools-read-collision-"));
    await mkdir(join(agentDir, "tools"));
    await writeFile(
      join(agentDir, "tools", "read.mjs"),
      `export default { description: "Discovered read", parameters: { type: "object" }, async execute() { return "mine"; } };`,
    );
    const configuredRead = defineTool({
      name: "read",
      description: "Configured read",
      input: z.object({}),
      execute: () => "mine",
    });

    const resolved = await resolveAgentTools({ tools: [configuredRead] }, agentDir);
    expect(resolved.tools.filter((tool) => tool.name === "read")).toHaveLength(1);
    expect(resolved.tools.find((tool) => tool.name === "read")?.description).not.toMatch(/Configured|Discovered/);
    expect(resolved.toolNames).not.toContain("read");
    expect(resolved.toolCollisions).toEqual([
      { name: "read", source: "config.tools" },
      { name: "read", source: "tools/read.mjs" },
    ]);
  });

  it("keeps native deferred exposure without adding a fastagent loader", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fa-tools-deferred-"));
    const deferred = defineTool({
      name: "lookup",
      description: "Look up a business record.",
      input: z.object({}),
      exposure: "deferred",
      execute: () => "ok",
    });

    const surface = [
      deferred,
      ...(
        [
          { name: "direct" },
          { name: "modelOnly", exposure: "model-only" },
          { name: "scriptOnly", exposure: "codemode" },
          { name: "invisible", exposure: "hidden" },
          { name: "inactive", defaultActive: false },
        ] as const
      ).map((options) =>
        defineTool({ ...options, description: options.name, input: z.object({}), execute: () => "ok" }),
      ),
    ];
    const { tools, toolNames, indirectTools } = await resolveAgentTools({ tools: surface }, agentDir);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(surface.map((tool) => tool.name)));
    expect(toolNames).toEqual(["direct", "modelOnly"]);
    expect(indirectTools).toEqual([
      { name: "lookup", reach: "tool_search" },
      { name: "scriptOnly", reach: "codemode" },
      { name: "invisible", reach: "hidden" },
      { name: "inactive", reach: "inactive" },
    ]);
    // What pi's default prompt lists, through the real assembly: the active tools, each by its line.
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(agentDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: [...piAllCodingTools(agentDir), ...surface],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(prompt).toContain("- direct:");
    expect(prompt).toContain("- modelOnly:");
    expect(prompt).not.toContain("- scriptOnly:");
    expect(prompt).not.toContain("- invisible:");
    expect(prompt).not.toContain("- inactive:");
    // Only deferred tools are tool_search's to load; codemode lists its own, and an inactive direct tool is authored.
    expect(prompt).toContain("1 additional tool(s)");
  });

  it("a built-in pi's settings disable leaves its tools unreachable, and every signal says so", async () => {
    // The agent directory is pi's project scope, so its own `.pi/settings.json` is where an author disables one.
    const agentDir = await mkdtemp(join(tmpdir(), "fa-tools-no-search-"));
    await mkdir(join(agentDir, ".pi"));
    await writeFile(join(agentDir, ".pi/settings.json"), JSON.stringify({ extensions: ["-builtin:tool-search"] }));
    const lookup = defineTool({
      name: "lookup",
      description: "Look up a business record.",
      input: z.object({}),
      exposure: "deferred",
      execute: () => "ok",
    });
    const scripted = { ...lookup, name: "scripted", exposure: "codemode" as const };

    const { indirectTools } = await resolveAgentTools({ tools: [lookup, scripted] }, agentDir);
    expect(indirectTools).toEqual([
      { name: "lookup", reach: "unreachable" },
      { name: "scripted", reach: "codemode" },
    ]);
    expect(
      fastagentPromptSections({ tools: [lookup], builtinExtensions: ["codemode"] }).deferred_tools,
    ).toBeUndefined();

    const { faux } = makeFaux();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await createPiAgentFromDefinition(agentDir, {
        providers: [faux.provider],
        model: "faux/faux-1",
        tools: [lookup, scripted],
        base: "You look up business records.",
      });
      const said = warn.mock.calls.flat().join("\n");
      expect(said).toContain('tool "lookup" (exposure: deferred) cannot be reached');
      expect(said).not.toContain('tool "scripted"');
    } finally {
      warn.mockRestore();
    }
  });

  it("a module that exports no tool is a helper: nothing mounted, nothing refused", async () => {
    const dir = await toolsDir({ "client.mjs": `export const client = { execute: () => 1 };\nexport const n = 1;` });
    const { tools, failures } = await loadTools(dir);
    expect(tools).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("loads tools at any depth, named by themselves, each with its file; folders only organize", async () => {
    const dir = await toolsDir({
      "github/search.mjs": `export const search = ${toolSource("gh_search")};\nexport const issues = ${toolSource("gh_issues")};`,
      "github/client.mjs": `export const get = () => "helper";`,
      "lookup.mjs": `export default ${toolSource("find_order")};`,
    });
    const { tools, sources, failures, collisions } = await loadTools(dir);
    expect(failures).toEqual([]);
    expect(collisions).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(["gh_issues", "gh_search", "find_order"]);
    // The name a tool gives itself wins over its file's.
    expect(Object.fromEntries(sources)).toEqual({
      gh_issues: "tools/github/search.mjs",
      gh_search: "tools/github/search.mjs",
      find_order: "tools/lookup.mjs",
    });
  });

  it("only a module directly in tools/ that exports one unnamed tool lends it the file's name", async () => {
    const dir = await toolsDir({
      "ping.mjs": `export default ${toolSource("")};`,
      "pair.mjs": `export const a = ${toolSource("")};\nexport const b = ${toolSource("named_b")};`,
      "nested/deep.mjs": `export default ${toolSource("")};`,
    });
    const { tools, failures } = await loadTools(dir);
    expect(tools.map((t) => t.name)).toEqual(["named_b", "ping"]);
    expect(tools.find((t) => t.name === "ping")?.label).toBe("ping");
    expect(failures.map((f) => `${f.label}: ${f.message}`)).toEqual([
      'tools/nested/deep.mjs: the tool exported as "default" has no name — give it one with defineTool({ name }); only a module directly in tools/ that exports a single tool takes its file\'s name',
      'tools/pair.mjs: the tool exported as "a" has no name — give it one with defineTool({ name }); only a module directly in tools/ that exports a single tool takes its file\'s name',
    ]);
  });

  it("a tool re-exported by an index is one tool; two tools sharing a name are reported", async () => {
    const dir = await toolsDir({
      "github/index.mjs": `export { search } from "./search.mjs";`,
      "github/search.mjs": `export const search = ${toolSource("gh_search")};`,
      "other.mjs": `export default ${toolSource("gh_search")};`,
    });
    const { tools, sources, collisions } = await loadTools(dir);
    expect(tools.map((t) => t.name)).toEqual(["gh_search"]);
    expect(sources.get("gh_search")).toBe("tools/github/index.mjs");
    expect(collisions).toEqual([{ name: "gh_search", source: "tools/other.mjs" }]);
  });

  it("never loads tests, node_modules or a dot-folder below tools/", async () => {
    const boom = `throw new Error("must not be imported");`;
    const dir = await toolsDir({
      "search.test.mjs": boom,
      "github/search.spec.mjs": boom,
      "node_modules/pkg/index.mjs": boom,
      ".cache/x.mjs": boom,
      "ok.mjs": `export default ${toolSource("ok")};`,
    });
    const { tools, failures } = await loadTools(dir);
    expect(failures).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });

  it("resolveAgentTools says where each authored tool comes from", async () => {
    const dir = await toolsDir({ "github/search.mjs": `export const search = ${toolSource("gh_search")};` });
    const configured = defineTool({ name: "gh", description: "gh", input: z.object({}), execute: () => "ok" });
    const { toolNames, toolSources } = await resolveAgentTools({ tools: [configured] }, dir);
    expect(toolNames).toEqual(["gh", "gh_search"]);
    expect(Object.fromEntries(toolSources)).toEqual({ gh: "config.tools", gh_search: "tools/github/search.mjs" });
  });

  it("ISOLATES a tool that throws on import — reports it in failures, still loads the others (G2)", async () => {
    // A repo turned into an agent may have a tools/ dir of its OWN build scripts that throw at module
    // top level (the real case: `APP_BASE ?? throw`). One such file must not crash `start` — it's skipped
    // and reported, the rest load, the agent keeps serving.
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools", "boom.mjs"), `throw new Error("APP_BASE env required");\nexport default {};`);
    await writeFile(
      join(dir, "tools", "ok.mjs"),
      `export default { description: "o", parameters: { type: "object" }, async execute() { return "ok"; } };`,
    );
    const { tools, failures } = await loadTools(dir);
    expect(tools.map((t) => t.name)).toEqual(["ok"]); // the good tool still loads — no crash
    expect(failures).toHaveLength(1);
    expect(failures[0]!.label).toBe("tools/boom.mjs");
    expect(failures[0]!.message).toMatch(/APP_BASE/); // the throw reason is surfaced, not swallowed
  });
});
