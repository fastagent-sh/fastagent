/** Tool authoring: `defineTool` (the authoring surface) and `loadTools` (filesystem discovery). */
import { join } from "node:path";
import { assertInsideAgentDir } from "../../paths.ts";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { type ModuleLoadFailure, loadModuleDir } from "../../loader.ts";
import { type ReadonlySessionManager, type ToolActivation, turnContext } from "./tool-context.ts";

export interface ToolContext {
  /** Working directory for this execution. */
  cwd: string;
  /** Abort signal for the current turn — honor it to cancel in-flight work on cancellation. */
  signal?: AbortSignal;
  sessionManager?: ReadonlySessionManager;
  /**
   * Tool activation for the current turn (a loader tool activates {@link DefineToolOptions.deferred} tools with it —
   * the built-in `search_tools` is one consumer).
   */
  tools?: ToolActivation;
}

export interface DefineToolOptions<I extends z.ZodType> {
  name?: string;
  description: string;
  input: I;
  /**
   * Registered but NOT initially active: the tool's schema stays out of every request (and the model's sight) until a
   * loader.
   */
  deferred?: boolean;
  /** pi's per-tool execution mode: "sequential" makes pi run any batch containing this tool serially. */
  executionMode?: "sequential" | "parallel";
  execute: (input: z.infer<I>, ctx: ToolContext) => unknown | Promise<unknown>;
}

/** AgentTool with Pi's optional per-call context; absent for sessionless CLI execution. */
export type MountedTool = Omit<AgentTool, "execute"> & {
  execute(...args: [...Parameters<AgentTool["execute"]>, context?: ExtensionContext]): ReturnType<AgentTool["execute"]>;
};

/** An AgentTool with fastagent's deferral marker. */
export type FastagentTool = AgentTool & {
  deferred?: boolean;
};

/**
 * Read the {@link DefineToolOptions.deferred} marker off a mounted tool (extra property on the AgentTool object — pi
 * ignores it).
 */
export function isDeferredTool(tool: MountedTool): boolean {
  return (tool as FastagentTool).deferred === true;
}

/**
 * The same tool without the deferred marker — for a loader that must stay active (a deferred loader could never be
 * activated and would strand every deferred tool).
 */
export function stripDeferredMarker(tool: MountedTool): MountedTool {
  if (!isDeferredTool(tool)) return tool;
  const { deferred: _drop, ...active } = tool as MountedTool & { deferred?: boolean };
  return active;
}

/** Wrap a plain return value into pi's tool-result shape; pass a full result through unchanged. */
function wrapResult(value: unknown): AgentToolResult<unknown> {
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return value as AgentToolResult<unknown>;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], details: value };
}

export function defineTool<I extends z.ZodType>(options: DefineToolOptions<I>): FastagentTool {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(options.input) as Record<string, unknown>;
  const tool = {
    name: options.name ?? "",
    label: options.name ?? "",
    description: options.description,
    parameters,
    ...(options.deferred ? { deferred: true } : {}),
    ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
      const parsed = options.input.safeParse(rawParams);
      if (!parsed.success) {
        // Validation failure is reported TO THE MODEL (it can correct and retry), not thrown.
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return { content: [{ type: "text", text: `Invalid arguments: ${detail}` }], details: { error: detail } };
      }
      const store = turnContext.getStore();
      // Stamp tools THIS execute activates on its result.
      const added: string[] = [];
      const tools = store?.tools
        ? {
            ...store.tools,
            activate: (names: string[]) => {
              // biome-ignore lint/style/noNonNullAssertion: guarded by the ternary above
              const activated = store.tools!.activate(names);
              added.push(...activated);
              return activated;
            },
          }
        : undefined;
      const result = wrapResult(
        await options.execute(parsed.data, {
          cwd: store?.cwd ?? process.cwd(),
          signal,
          sessionManager: store?.sessionManager,
          tools,
        }),
      );
      if (added.length > 0) {
        // A copy, not a mutation: wrapResult passes a full AgentToolResult through by REFERENCE, and an author may
        // legally return a shared/frozen result object.
        return { ...result, addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...added])] };
      }
      return result;
    },
  };
  return tool as unknown as FastagentTool;
}

/** A discarded same-name tool (within `tools/`, or against an existing tool). */
export interface ToolCollision {
  name: string;
  source: string;
}

/** Discover code tools in `<dir>/tools/`: each `*.ts|.js|.mjs` default-exports a tool, named from its filename. */
export async function loadTools(
  dir: string,
): Promise<{ tools: AgentTool[]; collisions: ToolCollision[]; failures: ModuleLoadFailure[] }> {
  // The same containment guard channels/schedules/skills get.
  await assertInsideAgentDir(dir, "tools");
  const { modules, failures } = await loadModuleDir(join(dir, "tools"));
  const byName = new Map<string, AgentTool>();
  const collisions: ToolCollision[] = [];
  for (const { name, label, file, mod } of modules) {
    const tool = mod.default as Partial<AgentTool> | undefined;
    if (!tool || typeof tool.execute !== "function") {
      failures.push({ label, file, message: `${label} must default-export defineTool({...})` });
      continue;
    }
    if (byName.has(name)) {
      collisions.push({ name, source: label });
      continue;
    }
    byName.set(name, { ...(tool as AgentTool), name });
  }
  return { tools: [...byName.values()], collisions, failures };
}

/** Merge resolved tools (pi coding tools + `config.tools`) with discovered `tools/`, deduped by name. */
export function mergeDiscoveredTools(
  existing: MountedTool[],
  discovered: AgentTool[],
): { tools: MountedTool[]; collisions: ToolCollision[] } {
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
