/**
 * Harness-neutral tool authoring: `defineTool` accepts Standard JSON Schema v1 (Zod v4, Valibot, ArkType, Effect
 * `Schema.toStandardJSONSchemaV1`), plain JSON Schema objects (with `as const` inference), or `pi-schema` / TypeBox
 * schemas, converting to JSON Schema once at definition time and running Standard Schema validation/transforms before
 * `execute()`, and `sessionIdOf` resolves the active session id across harnesses without global state.
 */
import type { Static } from "@earendil-works/pi-schema";
import { type Json, SessionId } from "@fastagent-sh/client/agent-api";

/** Per-invocation session-id resolver attached onto `api` by harness tool adapters. */
export const RESOLVE_SESSION_ID: unique symbol = Symbol.for("@fastagent-sh/fastagent/resolveSessionId");

interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

type StandardValidateResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** Minimal structural match for Standard JSON Schema v1 (Zod v4, Valibot, ArkType, Effect Schema). */
export interface StandardJSONSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0" | (string & {});
      }) => Record<string, unknown>;
    };
    readonly validate?:
      | ((value: unknown) => StandardValidateResult<TOutput> | Promise<StandardValidateResult<TOutput>>)
      | undefined;
    readonly types?:
      | {
          readonly input: TInput;
          readonly output: TOutput;
        }
      | undefined;
  };
}

/** Parameter schema accepted by {@link defineTool}: Standard JSON Schema v1, plain JSON Schema, or pi-schema/TypeBox. */
export type ToolParameters = StandardJSONSchemaV1 | Record<string, unknown>;

type JsonSchemaScalar<S> = S extends { readonly enum: ReadonlyArray<infer E> }
  ? E
  : S extends { readonly const: infer C }
    ? C
    : S extends { readonly type: "string" }
      ? string
      : S extends { readonly type: "number" | "integer" }
        ? number
        : S extends { readonly type: "boolean" }
          ? boolean
          : S extends { readonly type: "null" }
            ? null
            : S extends { readonly type: "array"; readonly items: infer I }
              ? Array<JsonSchemaScalar<I>>
              : S extends { readonly type: "object"; readonly properties: infer P extends Record<string, unknown> }
                ? JsonSchemaObject<S, P>
                : unknown;

type RequiredKeyOf<S> = S extends { readonly required: ReadonlyArray<infer K extends string> } ? K : never;

type JsonSchemaObject<S, P extends Record<string, unknown>> = {
  [K in keyof P & RequiredKeyOf<S>]: JsonSchemaScalar<P[K]>;
} & {
  [K in Exclude<keyof P, RequiredKeyOf<S>>]?: JsonSchemaScalar<P[K]>;
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Inferred argument type for `execute(args)`:
 * - Standard JSON Schema v1 (Zod v4, Effect Schema, Valibot, ArkType) -> `~standard.types.output`
 * - `pi-schema` / TypeBox -> `Static<T>`
 * - `as const` plain JSON Schema object -> inferred property shape
 * - non-literal plain JSON Schema object -> `Record<string, unknown>`
 */
export type InferToolArgs<TParameters> = TParameters extends {
  readonly "~standard": { readonly types?: { readonly output: infer TOutput } };
}
  ? TOutput
  : unknown extends Static<TParameters>
    ? TParameters extends { readonly properties: infer P extends Record<string, unknown> }
      ? string extends keyof P
        ? Record<string, unknown>
        : Simplify<JsonSchemaObject<TParameters, P>>
      : Record<string, unknown>
    : Static<TParameters>;

/** Text content block returned in a portable tool result. */
export interface ToolOutputPart {
  type: "text";
  text: string;
}

/** Retention bounds applied to streamed `api.output(...)` text. */
export interface ToolOutputLimits {
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly retain?: "head" | "tail";
}

/** JSON-serializable value attached to a tool result's `details`. */
export type ToolDetails = string | number | boolean | null | ToolDetails[] | { [key: string]: ToolDetails };

/** Portable result returned by `defineTool` across harnesses. */
export interface ToolResult<TDetails extends ToolDetails = ToolDetails> {
  readonly output?: ToolOutputPart[];
  readonly details?: TDetails;
  readonly isError?: boolean;
  readonly control?: { readonly terminate?: boolean };
  readonly kind?: never;
}

/** Invocation context passed as the third parameter of `execute(args, api, context)`. */
export interface ToolExecutionContext {
  readonly abortSignal?: AbortSignal | undefined;
  readonly sessionId?: string | undefined;
}

/** Harness-neutral runtime operations passed as the second parameter of `execute(args, api, context)`. */
export interface ToolExecutionApi {
  /** Stream incremental progress text for this tool call. */
  output(chunk: string): void;
  /** Invoke another registered tool within the same session. */
  executeTool(
    name: string,
    args: { [key: string]: Json },
    context: ToolExecutionContext,
  ): Promise<{ readonly isError?: boolean | undefined }>;
}

/** Compiled, harness-neutral tool registration returned by {@link defineTool}. */
export interface PortableTool<TDetails extends ToolDetails = ToolDetails> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly outputLimits?: ToolOutputLimits;
  readonly replay?: "safe" | "unsafe";
  prepareArguments?(args: unknown): unknown;
  execute(args: unknown, api: ToolExecutionApi, context: ToolExecutionContext): Promise<ToolResult<TDetails>>;
}

/** Authoring input accepted by {@link defineTool}. */
export interface ToolDefinition<
  TParameters extends ToolParameters = ToolParameters,
  TDetails extends ToolDetails = ToolDetails,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly outputLimits?: ToolOutputLimits;
  readonly replay?: "safe" | "unsafe";
  prepareArguments?(args: unknown): unknown;
  execute(
    args: InferToolArgs<TParameters>,
    api: ToolExecutionApi,
    context: ToolExecutionContext,
  ): Promise<ToolResult<TDetails> | string> | ToolResult<TDetails> | string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatStandardIssues(issues: readonly StandardIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) =>
          typeof segment === "object" && segment !== null && "key" in segment ? String(segment.key) : String(segment),
        )
        .join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function isStandardCandidate(value: unknown): value is { readonly "~standard": unknown } {
  return (typeof value === "object" || typeof value === "function") && value !== null && "~standard" in value;
}

function resolveParameters(
  name: string,
  parameters: unknown,
): {
  jsonSchema: Record<string, unknown>;
  validate?: (value: unknown) => StandardValidateResult<unknown> | Promise<StandardValidateResult<unknown>>;
} {
  if (isStandardCandidate(parameters)) {
    const std = parameters["~standard"] as
      | {
          version?: unknown;
          jsonSchema?: { input?: (options: { target: string }) => unknown };
          validate?: (value: unknown) => StandardValidateResult<unknown> | Promise<StandardValidateResult<unknown>>;
        }
      | undefined;
    if (std?.version !== 1 || typeof std.jsonSchema?.input !== "function") {
      throw new Error(
        `tool "${name}": parameters is a Standard Schema without JSON Schema support; use a Standard JSON Schema v1 ` +
          "library (e.g. Zod v4, Valibot, ArkType, or Effect Schema.toStandardJSONSchemaV1) or pass a JSON Schema object",
      );
    }
    let raw: unknown;
    try {
      raw = std.jsonSchema.input({ target: "draft-2020-12" });
    } catch (firstError) {
      try {
        raw = std.jsonSchema.input({ target: "draft-07" });
      } catch (secondError) {
        const firstMsg = firstError instanceof Error ? firstError.message : String(firstError);
        const secondMsg = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(
          `tool "${name}": failed to convert parameters to JSON Schema (draft-2020-12: ${firstMsg}; draft-07: ${secondMsg})`,
          { cause: firstError },
        );
      }
    }
    if (!isPlainObject(raw) || raw.type !== "object") {
      throw new Error(
        `tool "${name}": parameters must describe a JSON Schema object (type: "object"), got ${JSON.stringify(isPlainObject(raw) ? raw.type : typeof raw)}`,
      );
    }
    const { $schema: _schema, ...jsonSchema } = raw;
    const validate = typeof std.validate === "function" ? std.validate.bind(std) : undefined;
    return { jsonSchema, ...(validate === undefined ? {} : { validate }) };
  }
  if (!isPlainObject(parameters)) {
    throw new Error(`tool "${name}": parameters must be a JSON Schema object or a Standard JSON Schema v1 schema`);
  }
  if (parameters.type !== undefined && parameters.type !== "object") {
    throw new Error(
      `tool "${name}": parameters must describe a JSON Schema object (type: "object"), got ${JSON.stringify(parameters.type)}`,
    );
  }
  return { jsonSchema: parameters };
}

/**
 * Define a portable tool for `src/tools/` using Zod v4 (or any Standard JSON Schema v1 library), plain JSON Schema, or
 * `pi-schema`. Works identically across `pi-durable` and `dsh`.
 * @public
 */
export function defineTool<TParameters extends ToolParameters, TDetails extends ToolDetails = ToolDetails>(
  tool: ToolDefinition<TParameters, TDetails>,
): PortableTool<TDetails> {
  const { parameters, execute, outputLimits, replay, prepareArguments } = tool;
  const { jsonSchema, validate } = resolveParameters(tool.name, parameters);
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema,
    ...(outputLimits === undefined ? {} : { outputLimits }),
    ...(replay === undefined ? {} : { replay }),
    ...(prepareArguments === undefined ? {} : { prepareArguments }),
    execute: async (rawArgs, api, context) => {
      let parsedArgs: unknown = rawArgs;
      if (validate !== undefined) {
        const result = await validate(rawArgs);
        if (result.issues !== undefined) {
          return {
            output: [{ type: "text", text: `Invalid arguments: ${formatStandardIssues(result.issues)}` }],
            isError: true,
          };
        }
        parsedArgs = result.value;
      }
      const outcome = await execute(parsedArgs as InferToolArgs<TParameters>, api, context);
      return typeof outcome === "string" ? { output: [{ type: "text", text: outcome }] } : outcome;
    },
  };
}

/** Apply `ToolOutputLimits` (`maxLines` then `maxBytes`, `head` or `tail`) to streamed tool text. */
export function retainToolOutput(buffer: string, limits?: ToolOutputLimits): string {
  let out = buffer;
  if (limits?.maxLines !== undefined && limits.maxLines > 0) {
    const trailingNewline = out.endsWith("\n");
    const body = trailingNewline ? out.slice(0, -1) : out;
    const lines = body === "" ? [] : body.split("\n");
    if (lines.length > limits.maxLines) {
      out =
        limits.retain === "head"
          ? `${lines.slice(0, limits.maxLines).join("\n")}\n`
          : `${lines.slice(-limits.maxLines).join("\n")}${trailingNewline ? "\n" : ""}`;
    }
  }
  if (limits?.maxBytes === undefined || limits.maxBytes <= 0) return out;
  const bytes = Buffer.from(out, "utf8");
  if (bytes.byteLength <= limits.maxBytes) return out;
  if (limits.retain === "head") return bytes.subarray(0, limits.maxBytes).toString("utf8");
  return bytes.subarray(bytes.byteLength - limits.maxBytes).toString("utf8");
}

interface SessionToolApi {
  readonly output?: unknown;
  readonly commit?: unknown;
  readonly conversationId?: unknown;
  readonly [RESOLVE_SESSION_ID]?: (() => Promise<SessionId | undefined>) | undefined;
}

interface SessionToolContext {
  readonly abortSignal?: AbortSignal | undefined;
  readonly sessionId?: string | undefined;
}

/**
 * The session id of the conversation a tool runs in, as the Agent hands it out, or `undefined` when that conversation
 * is not a session (a subagent's). Works on both `pi-durable` and `dsh`.
 * @public
 */
export async function sessionIdOf(api?: SessionToolApi, context?: SessionToolContext): Promise<SessionId | undefined> {
  if (typeof api?.[RESOLVE_SESSION_ID] === "function") return api[RESOLVE_SESSION_ID]();
  if (typeof context?.sessionId === "string") return SessionId.make(context.sessionId);
  if (typeof api?.commit === "function" && typeof api?.conversationId === "number") {
    throw new Error("pi-durable tool api is missing FastAgent session binding");
  }
  return undefined;
}
