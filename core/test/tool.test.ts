import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, loadTools, z } from "../src/index.ts";
import { listToolFiles } from "../src/engines/pi/tool.ts";

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

  it("listToolFiles lists tool names from filenames WITHOUT importing them (build summary, no execution)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    expect(await listToolFiles(dir)).toEqual([]); // no tools/ dir yet
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools", "lookup-order.ts"), "throw new Error('would crash if imported')");
    await writeFile(join(dir, "tools", "alpha.mjs"), "export default {}");
    await writeFile(join(dir, "tools", "types.d.ts"), "export {}"); // excluded
    await writeFile(join(dir, "tools", "notes.md"), "x"); // excluded (not a tool ext)
    await writeFile(join(dir, "tools", "lookup-order.js"), "export default {}"); // same basename → deduped
    // Sorted, basename-deduped (lookup-order.ts + .js → one); the crashing .ts is listed, proving names
    // come from the filesystem, not from importing the module.
    expect(await listToolFiles(dir)).toEqual(["alpha", "lookup-order"]);
  });

  it("listToolFiles surfaces a non-ENOENT readdir failure (no silent fallback to empty)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    await writeFile(join(dir, "tools"), "x"); // tools/ is a FILE → readdir fails ENOTDIR (not ENOENT)
    await expect(listToolFiles(dir)).rejects.toThrow(/cannot read .*tools/);
  });

  it("fails visibly when a tool file does not default-export a tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-tools-"));
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools", "bad.mjs"), `export const notDefault = 1;`);
    await expect(loadTools(dir)).rejects.toThrow(/must default-export defineTool/);
  });
});
