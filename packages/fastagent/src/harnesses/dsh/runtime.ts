/**
 * `@fastagent-sh/harness-dsh` runtime adapter plugged into `harnesses/serving.ts`.
 * Loads `@fastagent-sh/harness-dsh` lazily so `@fastagent-sh/fastagent` carries zero dependency on
 * `@deepseek-ai/*`, shares `agent.sqlite` / PostgreSQL via `dsh_*` tables, forwards the sanitized
 * `processEnv` to sandboxed `bash` commands, and warns-and-skips `pi-durable`-only `src/extensions/*`.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Agent, ModelRef } from "@fastagent-sh/client/agent-api";
import type { Credential, CredentialInfo, Models } from "@earendil-works/pi-ai";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import { modelRefOf } from "../../model-ref.ts";
import type { Change, ClockStore } from "../../schedule/clock.ts";
import type { Fire } from "../../schedule/state.ts";
import type { Wakeup } from "../../schedule/wakeups.ts";
import { agentPresentation, resolveCodingTools } from "../pi-durable/config.ts";
import type { DurableCredentialStore } from "../pi-durable/credentials.ts";
import type { AgentDefinition } from "../pi-durable/definition.ts";
import { mcpTools } from "../pi-durable/mcp.ts";
import { type PostgresDatabase, acquirePgDatabase } from "../pi-durable/postgres/storage.ts";
import { definitionSections, readCommands } from "../pi-durable/text.ts";
import type { HarnessOpenContext, InstancePlace, OpenServingOptions, OpenedHarnessRuntime } from "../serving.ts";

const DSH_PACKAGE_NAME = ["@fastagent-sh", "harness-dsh"].join("/");

interface DshKvBackend {
  getKv?(namespace: string, key: string): Promise<string | undefined>;
  putKv?(namespace: string, key: string, valueJson: string): Promise<void>;
  close?(): Promise<void>;
}

interface DshModule {
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
    readonly onSessionDelete?: (sessionId: string) => void | Promise<void>;
    readonly sandbox?: "workspace" | "read-only" | "off";
    readonly unfinished?: "resume" | "refuse";
    readonly storage?: DshKvBackend;
  }): Promise<Agent & { busy(): boolean; close(): Promise<void> }>;
}

async function loadDshModule(): Promise<DshModule> {
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

function dshClockStore(store: DshKvBackend): ClockStore {
  const NS = "clock";
  const locks = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (locks.get(key) === tracked) locks.delete(key);
    });
    locks.set(key, tracked);
    return next;
  };
  const readJson = async <T>(key: string, fallback: T): Promise<T> => {
    const raw = await store.getKv?.(NS, key);
    return raw === undefined ? fallback : (JSON.parse(raw) as T);
  };
  const mutate = <S, T>(key: string, fallback: S, change: Change<S, T>): Promise<T> =>
    serialized(key, async () => {
      const current = await readJson(key, fallback);
      const { next, result } = change(current);
      if (next !== undefined) await store.putKv?.(NS, key, JSON.stringify(next));
      return result;
    });

  return {
    fires: (name, change) => mutate<readonly Fire[], ReturnType<typeof change>["result"]>(`fires:${name}`, [], change),
    wakeups: (change) => mutate<readonly Wakeup[], ReturnType<typeof change>["result"]>("wakeups", [], change),
    sessions: (change) =>
      mutate<Readonly<Record<string, string>>, ReturnType<typeof change>["result"]>("sessions", {}, change),
    armed: (change) =>
      mutate<Readonly<Record<string, string>>, ReturnType<typeof change>["result"]>("armed", {}, change),
    stored: {
      fires: (name) => readJson<readonly Fire[]>(`fires:${name}`, []),
      wakeups: () => readJson<readonly Wakeup[]>("wakeups", []),
      sessions: () => readJson<Readonly<Record<string, string>>>("sessions", {}),
      armed: () => readJson<Readonly<Record<string, string>>>("armed", {}),
    },
  };
}

function dshCredentialStore(store: DshKvBackend): DurableCredentialStore {
  const NS = "auth";
  const CRED_KEY = "credentials";
  const DEVICE_KEY = "device_id";
  const providerQueues = new Map<string, Promise<unknown>>();
  let commitQueue: Promise<unknown> = Promise.resolve();
  const perProvider = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = providerQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(work);
    const tracked = run.finally(() => {
      if (providerQueues.get(key) === tracked) providerQueues.delete(key);
    });
    providerQueues.set(key, tracked);
    return run;
  };
  const serializedCommit = <T>(work: () => Promise<T>): Promise<T> => {
    const run = commitQueue.catch(() => undefined).then(work);
    commitQueue = run;
    return run;
  };
  const readAll = async (): Promise<Record<string, Credential>> => {
    const raw = await store.getKv?.(NS, CRED_KEY);
    return raw === undefined ? {} : (JSON.parse(raw) as Record<string, Credential>);
  };
  const validCredential = (value: unknown): Credential | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const type = (value as { type?: unknown }).type;
    return type === "oauth" || type === "api_key" ? (value as Credential) : undefined;
  };

  return {
    async read(providerId) {
      return validCredential((await readAll())[providerId]);
    },
    async list() {
      const all = await readAll();
      const out: CredentialInfo[] = [];
      for (const [providerId, raw] of Object.entries(all)) {
        const cred = validCredential(raw);
        if (cred !== undefined) out.push({ providerId, type: cred.type });
      }
      return out;
    },
    modify(providerId, fn) {
      return perProvider(providerId, async () => {
        const current = validCredential((await readAll())[providerId]);
        const next = await fn(current);
        if (next === undefined) return current;
        await serializedCommit(async () => {
          const latest = await readAll();
          latest[providerId] = next;
          await store.putKv?.(NS, CRED_KEY, JSON.stringify(latest));
        });
        return next;
      });
    },
    async delete(providerId) {
      await perProvider(providerId, async () => {
        await serializedCommit(async () => {
          const latest = await readAll();
          if (!(providerId in latest)) return;
          delete latest[providerId];
          await store.putKv?.(NS, CRED_KEY, JSON.stringify(latest));
        });
      });
    },
    getOrCreateDeviceId() {
      return perProvider(DEVICE_KEY, async () => {
        const existing = await store.getKv?.(NS, DEVICE_KEY);
        if (existing) return existing;
        const created = randomUUID();
        await store.putKv?.(NS, DEVICE_KEY, created);
        return created;
      });
    },
  };
}

function openSqliteWithHelpfulLockError(dsh: DshModule, filePath: string): DshKvBackend & { close(): Promise<void> } {
  try {
    return dsh.openSqliteDshStore(filePath);
  } catch (error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    const msg = error instanceof Error ? error.message : String(error);
    if (errcode === 5 || msg.includes("database is locked")) {
      throw new Error(
        `the storage ${filePath} is held by another process: another fastagent dev, start or schedules command is running. Stop that one first`,
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

export async function withDshInstanceClock<T>(
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  work: (clock: ClockStore) => Promise<T>,
): Promise<T> {
  const dsh = await loadDshModule();
  const { store, ownedPgClose } = await openInstanceDshStore(dsh, place, database);
  try {
    return await work(dshClockStore(store));
  } finally {
    await store.close().catch(() => {});
    await ownedPgClose?.().catch(() => {});
  }
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
    wake: false,
    codingTools,
  });
  const texts: string[] = [];
  for (const s of sections) {
    const content = typeof s.render === "function" ? s.render({} as never, {} as never) : s.render;
    if (typeof content === "string" && content.trim().length > 0) texts.push(content.trim());
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export async function openDshRuntime(ctx: HarnessOpenContext): Promise<OpenedHarnessRuntime> {
  const dsh = await loadDshModule();
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
    processEnv,
    code,
    models,
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
  }

  const durableCreds = chosen === "instance" ? dshCredentialStore(store) : undefined;
  if (durableCreds !== undefined) ctx.setDurableCreds(durableCreds);

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
      ...(chosen === "instance" ? { onSessionDelete: ctx.onSessionDelete } : {}),
      sandbox: selection.sandbox ?? "workspace",
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      storage: store,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await store.close?.().catch((cleanup: unknown) => failures.push(cleanup));
    await ownedPgClose?.().catch((cleanup: unknown) => failures.push(cleanup));
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
        if (failures.length > 0) throw new AggregateError(failures, "DSH agent close failed");
      })()),
  };

  return {
    agent: managedAgent,
    ...(durableCreds === undefined ? {} : { durableCreds }),
    ...(chosen === "instance" ? { clockStore: dshClockStore(store) } : {}),
  };
}
