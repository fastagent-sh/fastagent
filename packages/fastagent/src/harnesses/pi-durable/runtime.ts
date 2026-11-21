/**
 * `pi-durable` runtime adapter plugged into `harnesses/serving.ts`: owns pi-durable storage opening,
 * `assembleAgent`, OTLP trace wiring, lease-loss shutdown, and offline clock access.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, type Storage, createRegistry } from "@earendil-works/pi-durable";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import type { ClockStore } from "../../schedule/clock.ts";
import { fastagentVersion } from "../../version.ts";
import type { HarnessOpenContext, InstancePlace, OpenedHarnessRuntime, ServingStorage } from "../serving.ts";
import type { PostgresDatabase } from "./postgres/storage.ts";
import { otlpTraces } from "../telemetry/otlp.ts";
import type { DurableAgent } from "./agent.ts";
import { clockStore } from "./clock.ts";
import { durableCredentialStore } from "./credentials.ts";
import { mcpTools } from "./mcp.ts";
import { assembleAgent } from "./open.ts";
import { messageBytesFor, openPostgresStorage } from "./postgres/storage.ts";
import { openLockedStorage } from "./storage.ts";

const INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of this agent (or of another agent with the same state root)";
const NAMED_INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of an instance of this name, on this machine or another";

function openInstanceStorage(
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  onLost?: (error: Error) => void,
): Promise<Storage> {
  if (database !== undefined) {
    if (place.name === undefined) {
      return Promise.reject(
        new Error(
          "an instance in a database is opened by its name, and none was given: " +
            `set ${INSTANCE_NAME_ENV} (an app: openAgent's name)`,
        ),
      );
    }
    return openPostgresStorage(database, place.name, {
      holders: NAMED_INSTANCE_HOLDERS,
      ...(place.agent === undefined ? {} : { agent: place.agent }),
      ...(onLost === undefined ? {} : { onLost }),
    });
  }
  return openLockedStorage(join(place.stateRoot, "agent.sqlite"), INSTANCE_HOLDERS);
}

function openStorage(
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  storage: ServingStorage,
  onLost: (error: Error) => void,
): Promise<Storage> | Storage {
  if (storage === "memory") return new MemoryStorage();
  if (storage === "instance") return openInstanceStorage(place, database, onLost);
  return openLockedStorage(storage.file, storage.holders);
}

export async function withPiDurableInstanceClock<T>(
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  work: (clock: ClockStore) => Promise<T>,
): Promise<T> {
  const storage = await openInstanceStorage(place, database);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    return await work(clockStore(harness, BACKGROUND_CONTEXT));
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

export async function openPiDurableRuntime(ctx: HarnessOpenContext): Promise<OpenedHarnessRuntime> {
  const {
    definition,
    options,
    name,
    workdir,
    chosen,
    place,
    database,
    storageDescription,
    env,
    processEnv,
    code,
    models,
  } = ctx;
  const traces = otlpTraces(env, { serviceName: name, serviceVersion: await fastagentVersion() });
  const maxMessageBytes = messageBytesFor(database?.limits);

  let stopRuns: ((error: Error) => void) | undefined;
  const storage = await openStorage(place, database, chosen, (error) => stopRuns?.(error));
  if (database !== undefined) log.info(`[fastagent] storage: ${storageDescription}`);

  let mcp: McpClients | undefined;
  let agent: DurableAgent;
  try {
    mcp = await ctx.openMcp();
    agent = await assembleAgent(definition, {
      name,
      mcpTools: mcpTools(mcp.tools),
      runsAs: options.runsAs,
      storage,
      code,
      workdir,
      processEnv,
      models: models.models,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
      ...(traces === undefined ? {} : { telemetry: traces.context }),
      ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await storage.close(BACKGROUND_CONTEXT).catch((cleanup: unknown) => failures.push(cleanup));
    await traces?.close();
    throw failures.length === 1 ? error : new AggregateError(failures, "Agent open and cleanup failed");
  }

  stopRuns = (error) => {
    log.error(`[fastagent] ${error.message}: stopping its runs`);
    agent.harness
      .close(BACKGROUND_CONTEXT)
      .catch((cause: unknown) => log.warn(`[fastagent] stopping the runs failed: ${String(cause)}`));
  };

  let resourcesClosed: Promise<void> | undefined;
  const closeResources = (): Promise<void> =>
    (resourcesClosed ??= (async () => {
      ctx.closeAuth();
      const failures: unknown[] = [];
      await mcp.close().catch((error: unknown) => failures.push(error));
      await traces?.close();
      if (failures.length > 0) throw failures[0];
    })());
  void agent.harness.closed.then(closeResources).catch((error: unknown) => {
    log.warn(`[fastagent] cleanup after harness shutdown failed: ${String(error)}`);
  });

  const closeAgent = agent.close.bind(agent);
  let closing: Promise<void> | undefined;
  const managedAgent: DurableAgent = {
    ...agent,
    close: () =>
      (closing ??= (async () => {
        const failures: unknown[] = [];
        await closeAgent().catch((error: unknown) => failures.push(error));
        await closeResources().catch((error: unknown) => failures.push(error));
        if (failures.length) throw new AggregateError(failures, "Agent close failed");
      })()),
  };

  return {
    agent: managedAgent,
    ...(chosen === "instance"
      ? {
          durableCreds: durableCredentialStore(managedAgent.harness, BACKGROUND_CONTEXT),
          clockStore: clockStore(managedAgent.harness, BACKGROUND_CONTEXT),
        }
      : {}),
  };
}
