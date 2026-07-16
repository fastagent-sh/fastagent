/**
 * Tool authoring: `defineTool` (the authoring surface) and `loadTools` (filesystem discovery).
 * Drop a file in `tools/`, default-export `defineTool({...})`, and it is discovered, named from
 * the filename, validated, and injected.
 *
 *   // tools/lookup-order.ts            → tool "lookup-order"
 *   export default defineTool({
 *     description: "Look up an order by id.",
 *     input: z.object({ orderId: z.string() }),
 *     async execute({ orderId }) { return await db.find(orderId); },
 *   });
 */
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { type ModuleLoadFailure, loadModuleDir } from "../../loader.ts";
import { type ToolActivation, turnContext } from "./tool-context.ts";

export interface ToolContext {
  /** Abort signal for the current turn — honor it to cancel in-flight work on cancellation. */
  signal?: AbortSignal;
  /** The session id of the current turn — which conversation this tool is running in. A general tool
   *  capability: partition per-conversation data, tag logs, scope state. Undefined outside a turn (a bare
   *  `fastagent tool` run, or any call with no session). (The built-in `wake` tool is one consumer — it
   *  fires a later turn back into this same session.) */
  session?: string;
  /** Tool activation for the current turn (a loader tool activates {@link DefineToolOptions.deferred}
   *  tools with it — the built-in `search_tools` is one consumer). Provided by both the serving path
   *  (invoke.ts, over the harness) and chat (over pi's AgentSession); undefined only outside any turn
   *  (a bare `fastagent tool` run). */
  tools?: ToolActivation;
}

export interface DefineToolOptions<I extends z.ZodType> {
  /** Explicit name. Usually omitted — a `tools/<name>.ts` tool is named from its filename. */
  name?: string;
  description: string;
  input: I;
  /**
   * Registered but NOT initially active: the tool's schema stays out of every request (and the model's
   *  sight) until a loader — the built-in `search_tools`, mounted automatically when any deferred tool
   *  exists — activates it mid-turn. For tool-heavy agents: fewer schemas per turn, and on providers
   *  with native deferred loading the activation preserves the prompt-cache prefix. The trade-off:
   *  discovery rides entirely on this description — write it for the search. Default: false.
   */
  deferred?: boolean;
  execute: (input: z.infer<I>, ctx: ToolContext) => unknown | Promise<unknown>;
}

/** Read the {@link DefineToolOptions.deferred} marker off a mounted tool (extra property on the
 *  AgentTool object — pi ignores it; config.tools authors can set it on a raw tool too). */
export function isDeferredTool(tool: AgentTool): boolean {
  return (tool as { deferred?: unknown }).deferred === true;
}

/** The same tool without the deferred marker — for a loader that must stay active (a deferred loader
 *  could never be activated and would strand every deferred tool). */
export function stripDeferredMarker(tool: AgentTool): AgentTool {
  if (!isDeferredTool(tool)) return tool;
  const { deferred: _drop, ...active } = tool as AgentTool & { deferred?: boolean };
  return active as AgentTool;
}

/** Wrap a plain return value into pi's tool-result shape; pass a full result through unchanged. */
function wrapResult(value: unknown): AgentToolResult<unknown> {
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return value as AgentToolResult<unknown>;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], details: value };
}

export function defineTool<I extends z.ZodType>(options: DefineToolOptions<I>): AgentTool {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(options.input) as Record<string, unknown>;
  const tool = {
    name: options.name ?? "",
    description: options.description,
    parameters,
    ...(options.deferred ? { deferred: true } : {}),
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
      const parsed = options.input.safeParse(rawParams);
      if (!parsed.success) {
        // Validation failure is reported TO THE MODEL (it can correct and retry), not thrown.
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return { content: [{ type: "text", text: `Invalid arguments: ${detail}` }], details: { error: detail } };
      }
      const store = turnContext.getStore();
      // Stamp tools THIS execute activates on its result — the load point that lets native
      // deferred-loading providers add the definitions at this transcript position without
      // invalidating the cached prompt prefix. The names come from this execute's OWN activate()
      // calls (accumulated below), NOT from an active-set before/after diff: pi runs tool calls of a
      // batch in parallel, and a snapshot diff would stamp a sibling's activation onto the wrong tool
      // result, drifting the load point.
      const added: string[] = [];
      const tools = store?.tools
        ? {
            ...store.tools,
            activate: async (names: string[]) => {
              // biome-ignore lint/style/noNonNullAssertion: guarded by the ternary above
              const activated = await store.tools!.activate(names);
              added.push(...activated);
              return activated;
            },
          }
        : undefined;
      const result = wrapResult(await options.execute(parsed.data, { signal, session: store?.session, tools }));
      if (added.length > 0) {
        result.addedToolNames = [...new Set([...(result.addedToolNames ?? []), ...added])];
      }
      return result;
    },
  };
  return tool as unknown as AgentTool;
}

/** A discarded same-name tool (within `tools/`, or against an existing tool). Surfaced, never silent. */
export interface ToolCollision {
  name: string;
  source: string;
}

/**
 * Discover code tools in `<dir>/tools/`: each `*.ts|.js|.mjs` default-exports a tool, named from its
 * filename. A file broken for ANY reason — a failed import (from {@link loadModuleDir}) or not being a
 * tool (no `execute`) — is ISOLATED into `failures` (skipped + reported, not thrown) so one broken file
 * can't crash `start`; the agent serves the tools that loaded. A repo turned into an agent often has a
 * `tools/` dir of its OWN scripts, which is exactly this case.
 */
export async function loadTools(
  dir: string,
): Promise<{ tools: AgentTool[]; collisions: ToolCollision[]; failures: ModuleLoadFailure[] }> {
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

/**
 * Merge resolved tools (pi defaults + `config.tools`) with discovered `tools/`, deduped by name.
 * Existing tools win; dropped discovered tools surface as collisions.
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
