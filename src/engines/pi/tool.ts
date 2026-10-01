/** Tool authoring: `defineTool` (the authoring surface) and `loadTools` (filesystem discovery). */
import { join } from "node:path";
import { assertInsideAgentDir } from "../../paths.ts";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  ExtensionToolContext,
  ToolAnnotations,
  ToolDefinition,
  ToolExposure,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type ModuleLoadFailure, loadModuleDir } from "../../loader.ts";
import { type DeclaredSecret, readSecretDeclaration, secretValues } from "../../declared-secrets.ts";
import { type ReadonlySessionManager, type ToolActivation, turnContext } from "./tool-context.ts";

export interface ToolContext {
  /** Working directory for this execution. */
  cwd: string;
  /** Abort signal for the current turn — honor it to cancel in-flight work on cancellation. */
  signal?: AbortSignal;
  sessionManager?: ReadonlySessionManager;
  /**
   * Tool activation for the current turn; Pi records changes in the transcript.
   */
  tools?: ToolActivation;
  /**
   * Run another mounted tool through pi's own pipeline: argument validation, the definition's `tool_call` and
   * `tool_result` hooks, cancellation (this call's signal by default). It reaches the active `direct` tools and every
   * `codemode` or `deferred` one. A tool failure comes back as `isError: true`, never as a rejection. The nested call
   * is observed with `parentToolCallId` and does not enter the transcript. Undefined without a session
   * (`fastagent tool`).
   */
  executeTool?: ExtensionToolContext["executeTool"];
  /**
   * Report progress while this call runs: a snapshot of everything so far (each call replaces the last), wrapped the
   * way a return value is. Its last line is the call's status (`tool_progress` on the invoke stream); session-control
   * observers receive the whole snapshot. Undefined when the caller takes no progress (`fastagent tool`).
   */
  onUpdate?: (partial: unknown) => void;
  /** THE values of {@link DefineToolOptions.secrets}, keyed by the names this tool declared — read
   *  from the process environment per call, so a value rotated THERE takes effect without a restart
   *  (one rotated in `.secrets/.env` does not: that file is loaded once at startup). This is how a
   *  tool gets a credential: reaching into `process.env` instead leaves the name undeclared, which
   *  means nothing carries it to a deployed box and nothing checks it before the call fails. */
  secrets: Record<string, string>;
}

export interface DefineToolOptions<I extends z.ZodType, S extends readonly string[] = readonly []> {
  name?: string;
  description: string;
  input: I;
  /** Pi's native visibility: direct (default), model-only, codemode, deferred, or hidden. */
  exposure?: ToolExposure;
  /** Direct tools start active unless false; settings may still select them. */
  defaultActive?: boolean;
  /**
   * MCP-style hints about what the tool does (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
   * Pi does not enforce them; a permission extension reads them from `pi.getAllTools()` to decide which calls to
   * confirm, and treats a tool without them as possibly destructive.
   */
  annotations?: ToolAnnotations;
  /** Groups the tool with related ones (`{ name, description? }`): codemode lists a namespace under one heading. */
  namespace?: ToolNamespace;
  /** Structured output schema for programmatic callers such as codemode. */
  output?: z.ZodType;
  /** pi's per-tool execution mode: "sequential" makes pi run any batch containing this tool serially. */
  executionMode?: "sequential" | "parallel";
  /**
   * Env vars this tool needs (`secrets: ["X_API_KEY"]`). Their values arrive as `ctx.secrets.X_API_KEY`,
   * typed from this list. Declaring buys the two guarantees a bare `process.env` read cannot have:
   * `deploy` carries the value to the host without it being listed anywhere else, and `dev`/`start`
   * REFUSE TO START while it is unset, naming this file — instead of the tool failing on its first
   * real call (see src/declared-secrets.ts).
   */
  secrets?: S;
  execute: (
    input: z.infer<I>,
    ctx: Omit<ToolContext, "secrets"> & { secrets: Record<S[number], string> },
  ) => unknown | Promise<unknown>;
}

/** AgentTool with Pi's optional per-call context; absent for sessionless CLI execution. */
export type MountedTool = Omit<AgentTool, "execute"> &
  Pick<ToolDefinition, "exposure" | "defaultActive" | "annotations" | "namespace"> & {
    execute(
      ...args: [...Parameters<AgentTool["execute"]>, context?: ExtensionToolContext]
    ): ReturnType<AgentTool["execute"]>;
  };

/** A Pi tool with fastagent's declared secrets. */
export type FastagentTool = MountedTool & {
  /** {@link DefineToolOptions.secrets} — read back by `readSecretDeclaration`; pi ignores it. */
  secrets?: readonly string[];
};

/**
 * Ask the provider to constrain sampling to the tool's schema, the posture pi's own built-ins take. `"prefer"`
 * rather than `"require"`: a schema pi cannot express strictly, one using a keyword the provider's strict mode rejects
 * (Anthropic: numeric bounds, which every `z.number().int()` carries), or a provider without strict mode silently
 * falls back to an ordinary function tool instead of failing the turn.
 *
 * Nothing here has to undo pi's strict rewrite. To express "optional" strictly, pi marks every property required and
 * unions the optional ones with `null`, so a constrained model emits `null` where it would have omitted the key — and
 * pi-ai's `validateToolArguments` drops those nulls (`normalizeOptionalNulls`) before `execute` is called. It drops
 * one only where the author's OWN schema rejects null, so any nullable property keeps its `null`, and a
 * `.nullable().optional()` property can no longer distinguish "absent" from "null" — the one place this changes
 * what an author's `execute` receives.
 */
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

/** Wrap a plain return value into pi's tool-result shape; pass a full result through unchanged. */
function wrapResult(value: unknown, output?: z.ZodType): AgentToolResult<unknown> {
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return value as AgentToolResult<unknown>;
  }
  const structuredContent = output ? (output.parse(value) as JsonValue) : undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], details: value, ...(output ? { structuredContent } : {}) };
}

// `S` defaults to the EMPTY tuple, not `readonly string[]`: a tool that declares nothing then gets
// `ctx.secrets` with no keys, so `ctx.secrets.X_API_KEY` fails to compile instead of type-checking as
// a `string` that is `undefined` at run time. "A typo is a compile error" has to hold for the tool
// that forgot to declare, which is the one making the mistake.
export function defineTool<I extends z.ZodType, const S extends readonly string[] = readonly []>(
  options: DefineToolOptions<I, S>,
): FastagentTool {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(options.input) as Record<string, unknown>;
  const tool = {
    name: options.name ?? "",
    label: options.name ?? "",
    description: options.description,
    parameters,
    constrainedSampling: CONSTRAINED_SAMPLING,
    ...(options.exposure ? { exposure: options.exposure } : {}),
    ...(options.defaultActive !== undefined ? { defaultActive: options.defaultActive } : {}),
    ...(options.annotations ? { annotations: options.annotations } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.output ? { outputSchema: z.toJSONSchema(options.output) } : {}),
    ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    ...(options.secrets?.length ? { secrets: options.secrets } : {}),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      context?: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      const parsed = options.input.safeParse(rawParams);
      if (!parsed.success) {
        // Validation failure is reported TO THE MODEL (it can correct and retry), not thrown.
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return {
          content: [{ type: "text", text: `Invalid arguments: ${detail}` }],
          details: { error: detail },
          isError: true,
        };
      }
      const store = turnContext.getStore();
      return wrapResult(
        await options.execute(parsed.data, {
          cwd: store?.cwd ?? process.cwd(),
          signal,
          sessionManager: store?.sessionManager,
          tools: store?.tools,
          // Per CALL, not per turn: pi binds `executeTool` to this call's id, the parent of what it runs.
          executeTool: context?.executeTool,
          onUpdate: onUpdate && ((partial) => onUpdate(wrapResult(partial))),
          secrets: secretValues(options.secrets),
        }),
        options.output,
      );
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
export async function loadTools(dir: string): Promise<{
  tools: AgentTool[];
  /** What each loaded tool declared it needs, BY TOOL NAME and attributed to the file. Per tool
   *  because whether a declaration counts depends on whether that tool ends up MOUNTED — a name
   *  shadowed by a coding tool never runs ({@link resolveAgentTools} makes that call). */
  secrets: Map<string, DeclaredSecret[]>;
  collisions: ToolCollision[];
  failures: ModuleLoadFailure[];
}> {
  // The same containment guard channels/routines/skills get.
  await assertInsideAgentDir(dir, "tools");
  const { modules, failures } = await loadModuleDir(join(dir, "tools"));
  const byName = new Map<string, AgentTool>();
  const collisions: ToolCollision[] = [];
  const secrets = new Map<string, DeclaredSecret[]>();
  for (const { name, label, file, mod } of modules) {
    const tool = mod.default as Partial<AgentTool> | undefined;
    if (!tool || typeof tool.execute !== "function") {
      failures.push({ label, file, message: `${label} must default-export defineTool({...})` });
      continue;
    }
    const declaration = readSecretDeclaration(tool, label);
    if (declaration.error !== undefined) {
      failures.push({ label, file, message: declaration.error });
      continue;
    }
    if (byName.has(name)) {
      collisions.push({ name, source: label });
      continue;
    }
    byName.set(name, { ...(tool as AgentTool), name });
    secrets.set(name, declaration.secrets);
  }
  return { tools: [...byName.values()], secrets, collisions, failures };
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
