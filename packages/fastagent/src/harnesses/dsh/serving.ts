/**
 * Dynamic serving bridge from FastAgent's `openServing()` to `@fastagent-sh/harness-dsh`.
 * Loads `@fastagent-sh/harness-dsh` lazily at runtime so `@fastagent-sh/fastagent` carries zero
 * dependency on `@deepseek-ai/*`, shares the instance's `agent.sqlite` / PostgreSQL database via
 * `dsh_*` tables, and warns-and-skips `pi-durable`-only `src/extensions/*` modules.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Agent, ModelRef } from "@fastagent-sh/client/agent-api";
import type { Credential, CredentialInfo, Models } from "@earendil-works/pi-ai";
import { processEnvironment } from "../../child-env.ts";
import { definedValues } from "../../declared-secrets.ts";
import { instanceName } from "../../instance-name.ts";
import { log } from "../../log.ts";
import { type McpClients, openMcpClients } from "../../mcp/client.ts";
import { declareMcp, resolveMcpServers } from "../../mcp/config.ts";
import { modelRefOf } from "../../model-ref.ts";
import { DATABASE_URL_ENV, resolveStateRoot } from "../../paths.ts";
import type { Change, ClockStore } from "../../schedule/clock.ts";
import { type ClockRunner, createClockRunner } from "../../schedule/runner.ts";
import type { Fire } from "../../schedule/state.ts";
import type { Wakeup } from "../../schedule/wakeups.ts";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { modelEnvironment } from "../models/environment.ts";
import { type AuthManager, createAuthManager } from "../models/remote-auth.ts";
import { type DurableCredentialStore, overlayCredentialStore } from "../pi-durable/credentials.ts";
import { agentPresentation, type HarnessSelection, resolveCodingTools } from "../pi-durable/config.ts";
import type { AgentDefinition } from "../pi-durable/definition.ts";
import { mcpTools } from "../pi-durable/mcp.ts";
import { buildDefinition } from "../pi-durable/open.ts";
import { acquirePgDatabase } from "../pi-durable/postgres/storage.ts";
import type { OpenedServing, OpenServingOptions } from "../pi-durable/serve.ts";
import { definitionSections, readCommands } from "../pi-durable/text.ts";

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
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(work);
    const tracked = run.finally(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
    queues.set(key, tracked);
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
      return serialized(providerId, async () => {
        const all = await readAll();
        const current = validCredential(all[providerId]);
        const next = await fn(current);
        if (next === undefined) return current;
        all[providerId] = next;
        await store.putKv?.(NS, CRED_KEY, JSON.stringify(all));
        return next;
      });
    },
    async delete(providerId) {
      await serialized(providerId, async () => {
        const all = await readAll();
        if (!(providerId in all)) return;
        delete all[providerId];
        await store.putKv?.(NS, CRED_KEY, JSON.stringify(all));
      });
    },
    getOrCreateDeviceId() {
      return serialized(DEVICE_KEY, async () => {
        const existing = await store.getKv?.(NS, DEVICE_KEY);
        if (existing) return existing;
        const created = randomUUID();
        await store.putKv?.(NS, DEVICE_KEY, created);
        return created;
      });
    },
  };
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

/**
 * Open a FastAgent definition on `@fastagent-sh/harness-dsh` with the same storage, model,
 * MCP, clock, and auth contracts as `pi-durable`.
 */
export async function openDshServing(
  definition: AgentDefinition,
  options: OpenServingOptions,
  selection: HarnessSelection,
): Promise<OpenedServing> {
  const dsh = await loadDshModule();
  const { dir, config } = definition;
  const workdir = options.workdir ?? dir;
  const projectDir = options.projectDir ?? workdir;
  const name = instanceName(definition.name, options.name);
  const mcpServers = declareMcp(config.mcpServers, dir);
  const secrets = definedValues(options.secrets);
  const code = buildDefinition(definition, secrets);

  if (code.extensions.length > 0) {
    const skipped = code.extensions.map((ext) => ext.name).join(", ");
    log.warn(
      `[fastagent] skipping pi-durable extensions on harness "dsh": ${skipped} (portable tools belong in src/tools/)`,
    );
  }

  const env = { ...options.ownEnv, ...secrets };
  const processEnv = processEnvironment(
    {
      base: options.env,
      secrets,
      declared: definition.inputs.secrets.map(({ name: secretName }) => secretName),
      workdir,
    },
    dirname(workdir),
  );
  const stateRoot = options.stateRoot ?? resolveStateRoot(projectDir, env);
  const authPath =
    options.authPath !== undefined
      ? options.authPath
      : options.keeps === "state"
        ? join(stateRoot, "auth.json")
        : undefined;
  const chosen = options.storage ?? "instance";
  let durableCreds: DurableCredentialStore | undefined;
  const models = await modelEnvironment(projectDir, authPath === undefined ? {} : { authPath }, code.providers, {
    stateRoot,
    environment: secrets,
    env,
    offline: options.offline ?? env.FASTAGENT_OFFLINE === "1",
    ...(chosen === "instance"
      ? { credentialStore: (fallback) => overlayCredentialStore(() => durableCreds, fallback) }
      : {}),
  });

  // Open shared storage: same agent.sqlite or PostgreSQL database as pi-durable, isolated in dsh_* tables.
  let store: DshKvBackend;
  let ownedPgClose: (() => Promise<void>) | undefined;
  if (chosen === "memory") {
    store = new dsh.MemoryDshEventStore();
  } else if (chosen !== "instance") {
    store = dsh.openSqliteDshStore(chosen.file);
  } else {
    const dbSpec = options.database ?? (env[DATABASE_URL_ENV] ? { url: env[DATABASE_URL_ENV] } : undefined);
    if (dbSpec !== undefined) {
      if (options.name === undefined) {
        throw new Error(
          `an instance in a database is opened by its name, and none was given: set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
        );
      }
      const acquired = acquirePgDatabase(dbSpec);
      if (acquired.owned) ownedPgClose = () => acquired.db.close();
      try {
        store = await dsh.openPostgresDshStore(acquired.db, options.name);
      } catch (error) {
        await ownedPgClose?.().catch(() => {});
        throw error;
      }
    } else {
      store = dsh.openSqliteDshStore(join(stateRoot, "agent.sqlite"));
    }
  }

  if (chosen === "instance") {
    durableCreds = dshCredentialStore(store);
  }

  const codingTools = resolveCodingTools(config.codingTools);
  const presentation = agentPresentation(definition);
  const modelSpec = options.model ?? config.model;
  const modelRef = modelSpec !== undefined ? modelRefOf(modelSpec, "model") : undefined;
  const systemPrompt = renderSystemPrompt(definition, workdir, options, codingTools);

  let clock: ClockRunner | undefined;
  let auth: AuthManager | undefined;
  let mcp: McpClients | undefined;
  let dshAgent: Agent & { busy(): boolean; close(): Promise<void> };
  try {
    mcp = await openMcpClients(resolveMcpServers(mcpServers, secrets, undefined, workdir, processEnv));
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
      commands: () => readCommands(dir),
      ...(chosen === "instance" ? { onSessionDelete: (sessionId) => clock?.onSessionDelete(sessionId) } : {}),
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
        auth?.close();
        await dshAgent.close().catch((error: unknown) => failures.push(error));
        await mcp?.close().catch((error: unknown) => failures.push(error));
        await store.close?.().catch((error: unknown) => failures.push(error));
        await ownedPgClose?.().catch((error: unknown) => failures.push(error));
        if (failures.length > 0) throw new AggregateError(failures, "DSH agent close failed");
      })()),
  };

  if (chosen === "instance") {
    auth = createAuthManager({
      models,
      durableStore: durableCreds as DurableCredentialStore,
      providers: code.providers,
      environment: secrets,
    });
    clock = createClockRunner({
      agent: managedAgent,
      store: dshClockStore(store),
      schedules: code.schedules,
    });
  }

  return {
    agent: managedAgent,
    harness: selection.harness,
    ...(selection.sandbox === undefined ? {} : { sandbox: selection.sandbox }),
    ...(clock === undefined ? {} : { clock }),
    ...(auth === undefined ? {} : { auth }),
    definition,
    name,
    code,
    config,
    secrets,
    models,
    agentDir: projectDir,
    workdir,
    stateRoot,
    schedules: code.schedules,
  };
}
