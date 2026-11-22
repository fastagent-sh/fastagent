/**
 * `pi-durable` runtime adapter plugged into `harnesses/serving.ts`: owns pi-durable storage opening,
 * `assembleAgent`, OTLP trace wiring, and lease-loss shutdown.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import type { HarnessOpenContext, InstancePlace, ServingAgent, ServingStorage } from "../serving.ts";
import { type PostgresDatabase, messageBytesFor } from "../../postgres.ts";
import type { DurableAgent } from "./agent.ts";
import { mcpTools } from "../mcp.ts";
import { assembleAgent } from "./open.ts";
import { openPostgresStorage } from "./postgres/storage.ts";
import { openLockedStorage } from "./storage.ts";

const INSTANCE_HOLDERS =
  "another `fastagent dev` or `start` command of this agent (or of another agent with the same state root)";
const NAMED_INSTANCE_HOLDERS =
  "another `fastagent dev` or `start` command of an instance of this name, on this machine or another";

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

export async function openPiDurableRuntime(ctx: HarnessOpenContext): Promise<ServingAgent> {
  const {
    definition,
    options,
    name,
    workdir,
    chosen,
    place,
    database,
    storageDescription,
    processEnv,
    code,
    models,
    traces,
  } = ctx;
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

  return managedAgent;
}
