/**
 * `@fastagent-sh/harness-dsh` runtime adapter plugged into `harnesses/serving.ts`.
 * Loads `@fastagent-sh/harness-dsh` lazily so `@fastagent-sh/fastagent` carries zero dependency on
 * `@deepseek-ai/*`, shares `agent.sqlite` / PostgreSQL via `dsh_*` tables, forwards the sanitized
 * `processEnv` to sandboxed `bash` commands, and warns-and-skips `pi-durable`-only `src/extensions/*`.
 */
import { join } from "node:path";
import type { Agent, ModelRef } from "@fastagent-sh/client/agent-api";
import type { Models } from "@earendil-works/pi-ai";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import { modelRefOf } from "../../model-ref.ts";
import type { AgentDefinition } from "../../definition/definition.ts";
import { type PostgresDatabase, acquirePgDatabase } from "../../postgres.ts";
import { agentPresentation, resolveCodingTools } from "../config.ts";
import { mcpTools } from "../mcp.ts";
import { definitionSections, readCommands } from "../text.ts";
import type { HarnessOpenContext, InstancePlace, OpenServingOptions, ServingAgent } from "../serving.ts";

const DSH_PACKAGE_NAME = ["@fastagent-sh", "harness-dsh"].join("/");

interface DshKvBackend {
  getKv?(namespace: string, key: string): Promise<string | undefined>;
  putKv?(namespace: string, key: string, valueJson: string): Promise<void>;
  close?(): Promise<void>;
}

export interface DshModule {
  MemoryDshEventStore: new () => DshKvBackend;
  openSqliteDshStore(
    filePath: string,
    options?: { readonly busyTimeoutMs?: number },
  ): DshKvBackend & { close(): Promise<void> };
  openPostgresDshStore(
    database: {
      query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
      transaction<T>(
        work: (tx: {
          query<U extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<U[]>;
        }) => Promise<T>,
      ): Promise<T>;
    },
    instance: string,
  ): Promise<DshKvBackend & { close(): Promise<void> }>;
  openDshAgent(options: {
    readonly name: string;
    readonly agent?: { readonly name: string; readonly description?: string };
    readonly starters?: readonly string[];
    readonly workdir: string;
    readonly systemPrompt?: string;
    readonly models?: Models;
    readonly model?: ModelRef;
    readonly thinkingLevel?: string;
    readonly tools?: readonly unknown[];
    readonly codingTools?: boolean | readonly ("read" | "write" | "edit" | "bash")[];
    readonly protectedPaths?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly commands?: () => readonly {
      readonly name: string;
      readonly description?: string;
      expand(args: string): string;
    }[];
    readonly sandbox?: "workspace" | "read-only" | "off";
    readonly unfinished?: "resume" | "refuse";
    readonly telemetry?: unknown;
    readonly storage?: DshKvBackend;
  }): Promise<Agent & { busy(): boolean; close(): Promise<void> }>;
}

export async function loadDshModule(): Promise<DshModule> {
  try {
    return (await import(DSH_PACKAGE_NAME)) as unknown as DshModule;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `harness "dsh" requires ${DSH_PACKAGE_NAME}. Install it in your project: npm install ${DSH_PACKAGE_NAME}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function openSqliteWithHelpfulLockError(dsh: DshModule, filePath: string): DshKvBackend & { close(): Promise<void> } {
  try {
    return dsh.openSqliteDshStore(filePath);
  } catch (error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    const msg = error instanceof Error ? error.message : String(error);
    if (errcode === 5 || msg.includes("database is locked")) {
      throw new Error(
        `the storage ${filePath} is held by another process: another fastagent dev or start command is running. Stop that one first`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function openInstanceDshStore(
  dsh: DshModule,
  place: InstancePlace,
  database: PostgresDatabase | undefined,
): Promise<{ store: DshKvBackend & { close(): Promise<void> }; ownedPgClose?: () => Promise<void> }> {
  if (database !== undefined) {
    if (place.name === undefined) {
      throw new Error(
        `an instance in a database is opened by its name, and none was given: set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
      );
    }
    const acquired = acquirePgDatabase(database);
    const ownedPgClose = acquired.owned ? () => acquired.db.close() : undefined;
    try {
      const store = await dsh.openPostgresDshStore(acquired.db, place.name);
      return ownedPgClose === undefined ? { store } : { store, ownedPgClose };
    } catch (error) {
      await ownedPgClose?.().catch(() => {});
      throw error;
    }
  }
  return { store: openSqliteWithHelpfulLockError(dsh, join(place.stateRoot, "agent.sqlite")) };
}

function renderSystemPrompt(
  definition: AgentDefinition,
  workdir: string,
  options: OpenServingOptions,
  codingTools: readonly ("read" | "write" | "edit" | "bash")[],
): string | undefined {
  const sections = definitionSections(definition.dir, {
    workdir,
    source: definition.source === true,
    runsAs: options.runsAs,
    codingTools,
  });
  const texts: string[] = [];
  for (const s of sections) {
    const content = typeof s.render === "function" ? s.render({} as never, {} as never) : s.render;
    if (typeof content === "string" && content.trim().length > 0) texts.push(content.trim());
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export async function openDshRuntime(ctx: HarnessOpenContext, preloaded?: DshModule): Promise<ServingAgent> {
  const dsh = preloaded ?? (await loadDshModule());
  const {
    definition,
    options,
    selection,
    name,
    workdir,
    stateRoot,
    chosen,
    place,
    database,
    storageDescription,
    processEnv,
    code,
    models,
    traces,
  } = ctx;
  const { dir, config } = definition;

  if (code.extensions.length > 0) {
    const skipped = code.extensions.map((ext) => ext.name).join(", ");
    log.warn(
      `[fastagent] skipping pi-durable extensions on harness "dsh": ${skipped} (portable tools belong in src/tools/)`,
    );
  }

  let store: DshKvBackend;
  let ownedPgClose: (() => Promise<void>) | undefined;
  if (chosen === "memory") {
    store = new dsh.MemoryDshEventStore();
  } else if (chosen !== "instance") {
    store = openSqliteWithHelpfulLockError(dsh, chosen.file);
  } else {
    const opened = await openInstanceDshStore(dsh, place, database);
    store = opened.store;
    ownedPgClose = opened.ownedPgClose;
    if (database !== undefined) log.info(`[fastagent] storage: ${storageDescription}`);
  }

  const codingTools = resolveCodingTools(config.codingTools);
  const presentation = agentPresentation(definition);
  const modelSpec = options.model ?? config.model;
  const modelRef = modelSpec !== undefined ? modelRefOf(modelSpec, "model") : undefined;
  const systemPrompt = renderSystemPrompt(definition, workdir, options, codingTools);

  let mcp: McpClients | undefined;
  let dshAgent: Agent & { busy(): boolean; close(): Promise<void> };
  try {
    mcp = await ctx.openMcp();
    dshAgent = await dsh.openDshAgent({
      name,
      agent: presentation.agent,
      ...(presentation.starters === undefined ? {} : { starters: presentation.starters }),
      workdir,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      models: models.models,
      ...(modelRef === undefined ? {} : { model: modelRef }),
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      tools: [...code.tools, ...mcpTools(mcp.tools)],
      codingTools,
      protectedPaths: [stateRoot],
      env: processEnv,
      commands: () => readCommands(dir),
      sandbox: selection.sandbox ?? "workspace",
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      ...(traces === undefined ? {} : { telemetry: traces.context }),
      storage: store,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await store.close?.().catch((cleanup: unknown) => failures.push(cleanup));
    await ownedPgClose?.().catch((cleanup: unknown) => failures.push(cleanup));
    await traces?.close();
    throw failures.length === 1 ? error : new AggregateError(failures, "DSH agent open and cleanup failed");
  }

  let closing: Promise<void> | undefined;
  const managedAgent = {
    info: dshAgent.info,
    usage: dshAgent.usage,
    sessions: dshAgent.sessions,
    messages: dshAgent.messages,
    busy: () => dshAgent.busy(),
    close: () =>
      (closing ??= (async () => {
        const failures: unknown[] = [];
        ctx.closeAuth();
        await dshAgent.close().catch((error: unknown) => failures.push(error));
        await mcp?.close().catch((error: unknown) => failures.push(error));
        await store.close?.().catch((error: unknown) => failures.push(error));
        await ownedPgClose?.().catch((error: unknown) => failures.push(error));
        await traces?.close();
        if (failures.length > 0) throw new AggregateError(failures, "DSH agent close failed");
      })()),
  };

  return managedAgent;
}
