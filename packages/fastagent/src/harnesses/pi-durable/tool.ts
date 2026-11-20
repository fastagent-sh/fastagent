/**
 * Harness-neutral tool authoring: `defineTool` accepts Standard JSON Schema v1 (Zod v4, Valibot, ArkType, Effect
 * `Schema.toStandardJSONSchemaV1`), plain JSON Schema objects (with `as const` inference), or `pi-schema` / TypeBox
 * schemas, converting to JSON Schema once at definition time and running Standard Schema validation/transforms before
 * `execute()`.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  defineTool as defineDurableTool,
} from "@earendil-works/pi-durable";
import type { Static } from "@earendil-works/pi-schema";

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
    readonly validate?: (value: unknown) => StandardValidateResult<TOutput> | Promise<StandardValidateResult<TOutput>>;
    readonly types?: {
      readonly input: TInput;
      readonly output: TOutput;
    };
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
 * - Standard JSON Schema v1 (Zod v4, Effect Schema, Valibot, ArkType) → `~standard.types.output`
 * - `pi-schema` / TypeBox → `pi-durable`'s `ToolArgs<T>`
 * - `as const` plain JSON Schema object → inferred property shape
 * - non-literal plain JSON Schema object → `Record<string, unknown>`
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

/** What {@link defineTool} accepts: standard schema or JSON Schema parameters, and string or full ToolExecutionResult return. */
export type ToolDefinition<
  TParameters extends ToolParameters = ToolParameters,
  TDetails extends JsonValue = JsonValue,
> = Omit<ToolRegistration<Record<string, unknown>, TDetails>, "parameters" | "execute" | "prepareArguments"> & {
  readonly parameters: TParameters;
  prepareArguments?(args: unknown): InferToolArgs<TParameters>;
  execute(
    args: InferToolArgs<TParameters>,
    api: ToolExecutionApi<TDetails>,
    context: Context,
  ): Promise<ToolExecutionResult<TDetails> | string> | ToolExecutionResult<TDetails> | string;
};

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
    } catch {
      raw = std.jsonSchema.input({ target: "draft-07" });
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
 * Define a tool for `src/tools/` using Zod v4 (or any Standard JSON Schema v1 library), plain JSON Schema, or
 * `pi-schema`. Returns a pi-durable {@link ToolRegistration} ready for FastAgent.
 * @public
 */
export function defineTool<TParameters extends ToolParameters, TDetails extends JsonValue = JsonValue>(
  tool: ToolDefinition<TParameters, TDetails>,
): ToolRegistration<object, TDetails> {
  const { parameters, execute, ...rest } = tool;
  const { jsonSchema, validate } = resolveParameters(tool.name, parameters);
  return defineDurableTool({
    ...rest,
    parameters: jsonSchema,
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
  });
}
