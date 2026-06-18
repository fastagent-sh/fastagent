/**
 * Tool authoring: `defineTool` (the vibe surface) and `loadTools` (filesystem discovery).
 *
 * The two together let a developer add a code tool with no ceremony: drop a file in `tools/`,
 * default-export `defineTool({...})`, and it is discovered, named from the filename, validated,
 * and injected — no `name` field, no manual registration in the config.
 *
 *   // tools/lookup-order.ts            → tool "lookup-order"
 *   import { defineTool, z } from "@kid7st/fastagent";
 *   export default defineTool({
 *     description: "Look up an order by id.",
 *     input: z.object({ orderId: z.string() }),
 *     async execute({ orderId }) { return await db.find(orderId); },  // plain value, auto-wrapped
 *   });
 *
 * defineTool produces a pi `AgentTool` (folded-M): it converts the Zod schema to JSON Schema for
 * the model, validates the model's arguments before calling `execute` (a validation failure is
 * returned to the model as an error result, not a crash), and wraps a plain return value into the
 * pi result shape. The `parameters` field is a plain JSON-Schema object — pi accepts it (the
 * `TSchema` bound is compile-time only; there is no TypeBox runtime dependency on this path).
 *
 * Node composition-root module: `loadTools` dynamically imports the workspace's tool modules
 * (local files, not node_modules — so Node strips their types); the invoke path stays disk-free.
 */
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { z } from "zod";

/** Runtime context passed to a tool's `execute`. Minimal today; reserved for growth (session, …). */
export interface ToolContext {
  /** Abort signal for the current turn — honor it to cancel in-flight work on cancellation. */
  signal?: AbortSignal;
}

export interface DefineToolOptions<I extends z.ZodType> {
  /**
   * Explicit tool name. Usually omitted: a tool in `tools/<name>.ts` is named from its filename
   * (authoritative). Set this only when injecting programmatically via `config.tools`.
   */
  name?: string;
  /** What the tool does — the text the model reads to decide when to call it. */
  description: string;
  /** Input parameters as a Zod schema; `execute` receives the parsed, typed value. */
  input: I;
  /**
   * The tool body. Receives the validated input and a {@link ToolContext}. Return a plain value
   * (string/object/…) and it is wrapped for the model; return a full `{ content, details }` result
   * for control over content blocks.
   */
  execute: (input: z.infer<I>, ctx: ToolContext) => unknown | Promise<unknown>;
}

/** Wrap a plain return value into pi's tool-result shape; pass a full result through unchanged. */
function wrapResult(value: unknown): AgentToolResult<unknown> {
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return value as AgentToolResult<unknown>;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], details: value };
}

/**
 * Define a tool from a Zod input schema and an `execute` body. Returns a pi `AgentTool` with a
 * JSON-Schema `parameters`, schema-validated arguments, and auto-wrapped results.
 */
export function defineTool<I extends z.ZodType>(options: DefineToolOptions<I>): AgentTool {
  // Zod → JSON Schema for the model. Drop `$schema` (providers don't need the dialect marker).
  const { $schema: _drop, ...parameters } = z.toJSONSchema(options.input) as Record<string, unknown>;
  const tool = {
    name: options.name ?? "",
    description: options.description,
    parameters,
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
      const parsed = options.input.safeParse(rawParams);
      if (!parsed.success) {
        // Validation failure is reported TO THE MODEL (it can correct and retry), not thrown.
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return { content: [{ type: "text", text: `Invalid arguments: ${detail}` }], details: { error: detail } };
      }
      return wrapResult(await options.execute(parsed.data, { signal }));
    },
  };
  return tool as unknown as AgentTool;
}

/** A discarded same-name tool (within `tools/`, or against an existing tool). Surfaced, never silent. */
export interface ToolCollision {
  name: string;
  source: string;
}

const TOOL_EXTS = new Set([".ts", ".js", ".mjs"]);

/**
 * Discover code tools in `<dir>/tools/`: each top-level `*.ts|*.js|*.mjs` is dynamically imported,
 * its default export taken as the tool, and named from the filename (authoritative). Missing
 * `tools/` is normal (returns none). A file that does not default-export a tool fails visibly.
 */
export async function loadTools(dir: string): Promise<{ tools: AgentTool[]; collisions: ToolCollision[] }> {
  const toolsDir = join(dir, "tools");
  let entries;
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "not_found" || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { tools: [], collisions: [] };
    }
    throw new Error(`cannot read ${toolsDir}: ${(error as Error).message}`);
  }
  const byName = new Map<string, AgentTool>();
  const collisions: ToolCollision[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!TOOL_EXTS.has(ext) || entry.name.endsWith(".d.ts")) continue;
    const file = join(toolsDir, entry.name);
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (error) {
      // The most common cause is a non-ESM workspace: a tool's `import` needs the project's
      // package.json to set "type": "module". Surface the file + a hint instead of a raw stack.
      throw new Error(
        `cannot load tools/${entry.name}: ${(error as Error).message}\n` +
          `  (a code-tool workspace must be ESM — set "type": "module" in package.json)`,
      );
    }
    const tool = mod.default as Partial<AgentTool> | undefined;
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`tools/${entry.name} must default-export defineTool({...})`);
    }
    const name = basename(entry.name, ext); // filename is the tool name (authoritative)
    if (byName.has(name)) {
      collisions.push({ name, source: `tools/${entry.name}` });
      continue;
    }
    byName.set(name, { ...(tool as AgentTool), name });
  }
  return { tools: [...byName.values()], collisions };
}

/**
 * Merge already-resolved tools (pi defaults + `config.tools`) with discovered `tools/` tools,
 * deduping by name. Existing tools win a name clash (a discovered tool may not shadow a default or
 * a configured one); the dropped discovered tools are surfaced as collisions, never silent.
 */
export function mergeDiscoveredTools(
  existing: AgentTool[],
  discovered: AgentTool[],
): { tools: AgentTool[]; collisions: ToolCollision[] } {
  const names = new Set(existing.map((t) => t.name));
  const tools = [...existing];
  const collisions: ToolCollision[] = [];
  for (const tool of discovered) {
    if (names.has(tool.name)) {
      collisions.push({ name: tool.name, source: `tools/${tool.name}` });
      continue;
    }
    names.add(tool.name);
    tools.push(tool);
  }
  return { tools, collisions };
}
