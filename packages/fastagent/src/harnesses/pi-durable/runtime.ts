/**
 * `pi-durable` runtime adapter plugged into `harnesses/serving.ts`: owns pi-durable storage opening,
 * `assembleAgent`, OTLP trace wiring, and lease-loss shutdown.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { createCloseSignal } from "../../close-signal.ts";
import { INSTANCE_NAME_ENV } from "../../instance-name.ts";
import { log } from "../../log.ts";
import type { McpClients } from "../../mcp/client.ts";
import type { HarnessOpenContext, InstancePlace, ServingAgent, ServingStorage } from "../serving.ts";
import type { PostgresDatabase } from "../../postgres.ts";
import type { PgLeaseHandoff } from "../../postgres-kit.ts";
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
  handoff?: PgLeaseHandoff,
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
      ...(handoff === undefined ? {} : { handoff }),
    });
  }
  return openLockedStorage(join(place.stateRoot, "agent.sqlite"), INSTANCE_HOLDERS);
}

function openStorage(
  place: InstancePlace,
  database: PostgresDatabase | undefined,
  storage: ServingStorage,
  onLost: (error: Error) => void,
  handoff: PgLeaseHandoff,
): Promise<Storage> | Storage {
  if (storage === "memory") return new MemoryStorage();
  if (storage === "instance") return openInstanceStorage(place, database, onLost, handoff);
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
    maxMessageBytes,
    storageDescription,
    processEnv,
    code,
    models,
    traces,
    work,
  } = ctx;

  let stopRuns: ((error: Error) => void) | undefined;
  let handoffRuns: (() => void) | undefined;
  let isIdle: (() => boolean) | undefined;
  const storage = await openStorage(place, database, chosen, (error) => stopRuns?.(error), {
    canYield: () => isIdle?.() === true,
    onHandoff: () => handoffRuns?.(),
  });
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
      work,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (mcp) await mcp.close().catch((cleanup: unknown) => failures.push(cleanup));
    await storage.close(BACKGROUND_CONTEXT).catch((cleanup: unknown) => failures.push(cleanup));
    await traces?.close();
    throw failures.length === 1 ? error : new AggregateError(failures, "Agent open and cleanup failed");
  }

  const closeSignal = createCloseSignal();
  try {
    agent.harness.subscribeClose(closeSignal.mark);
  } catch {
    closeSignal.mark();
  }

  isIdle = () => work.active() === 0;

  handoffRuns = () => {
    log.info(`[fastagent] handing off idle instance "${name}" to another process`);
    agent.harness
      .close(BACKGROUND_CONTEXT)
      .catch((cause: unknown) => log.warn(`[fastagent] handing off instance "${name}" failed: ${String(cause)}`));
  };

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
  const managedAgent: ServingAgent = {
    ...agent,
    closed: agent.harness.closed.then(() => undefined),
    ready: () => !closeSignal.isClosing(),
    subscribeClose: closeSignal.subscribe,
    close: () => {
      closeSignal.mark();
      closing ??= (async () => {
        const failures: unknown[] = [];
        await closeAgent().catch((error: unknown) => failures.push(error));
        await closeResources().catch((error: unknown) => failures.push(error));
        if (failures.length) throw new AggregateError(failures, "Agent close failed");
      })();
      return closing;
    },
  };

  return managedAgent;
}
