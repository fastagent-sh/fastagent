import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, loadTools, z } from "../src/index.ts";
import { resolveWorkspaceTools } from "../src/engines/pi/create.ts";

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
});

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

  it("resolveWorkspaceTools discovers tools/ from agentDir, NOT from cwd (guards the agentDir/cwd param split)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-ws-cwd-"));
    const agentDir = join(cwd, "agent");
    const tool = `export default { description: "d", parameters: { type: "object" }, async execute() { return { content: [], details: "" }; } };`;
    await mkdir(join(agentDir, "tools"), { recursive: true });
    await writeFile(join(agentDir, "tools", "foo.mjs"), tool); // the agent's own tool (in agentDir)
    await mkdir(join(cwd, "tools"), { recursive: true });
    await writeFile(join(cwd, "tools", "hostonly.mjs"), tool); // the host repo's tool at cwd — must NOT be scanned

    const { toolNames } = await resolveWorkspaceTools({}, agentDir, cwd);
    expect(toolNames).toContain("foo"); // discovered from agentDir
    expect(toolNames).not.toContain("hostonly"); // cwd's own tools/ is the host's, not the agent's surface
  });

  it("isolates (surfaces, not fatal) a tool file that does not default-export a tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools", "bad.mjs"), `export const notDefault = 1;`);
    const { tools, failures } = await loadTools(dir);
    expect(tools).toEqual([]); // not mounted…
    expect(failures[0]!.message).toMatch(/must default-export defineTool/); // …but surfaced, never silent
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
