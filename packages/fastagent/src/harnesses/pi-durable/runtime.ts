/**
 * Built-in `pi-durable` `HarnessProvider` implementation: opens SQLite/PostgreSQL/memory storage in phase 1 and
 * assembles a `DurableAgent` in phase 2 while `harnesses/serving.ts` owns MCP, conflict checks, and shutdown.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
  INSTANCE_NAME_ENV,
  type HarnessAgentOpenContext,
  type HarnessInstancePlace,
  type HarnessProvider,
  type HarnessRuntimeAgent,
  type HarnessStorageHandle,
  type HarnessStorageOpenContext,
  type SharedPostgresDatabase,
  type PgLeaseHandoff,
} from "../../harness.ts";
import { assembleAgent } from "./open.ts";
import { openPostgresStorage } from "./postgres/storage.ts";
import { openLockedStorage } from "./storage.ts";

const INSTANCE_HOLDERS =
  "another `fastagent dev` or `start` command of this agent (or of another agent with the same state root)";
const NAMED_INSTANCE_HOLDERS =
  "another `fastagent dev` or `start` command of an instance of this name, on this machine or another";

interface PiDurableStorageHandle extends HarnessStorageHandle {
  readonly raw: Storage;
}

function openInstanceStorage(
  place: HarnessInstancePlace,
  database: SharedPostgresDatabase | undefined,
  onLost: (error: Error) => void,
  handoff: PgLeaseHandoff,
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
      onLost,
      handoff,
    });
  }
  return openLockedStorage(join(place.stateRoot, "agent.sqlite"), INSTANCE_HOLDERS);
}

export const piDurableProvider: HarnessProvider<PiDurableStorageHandle> = {
  name: "pi-durable",
  supportsExtensions: true,

  async openStorage(ctx: HarnessStorageOpenContext): Promise<PiDurableStorageHandle> {
    const raw: Storage =
      ctx.chosen === "memory"
        ? new MemoryStorage()
        : ctx.chosen === "instance"
          ? await openInstanceStorage(ctx.place, ctx.database, ctx.onLost, ctx.handoff)
          : await openLockedStorage(ctx.chosen.file, ctx.chosen.holders);
    return {
      raw,
      close: () => raw.close(BACKGROUND_CONTEXT),
    };
  },

  async openAgent(ctx: HarnessAgentOpenContext<PiDurableStorageHandle>): Promise<HarnessRuntimeAgent> {
    const agent = await assembleAgent(ctx.definition, {
      name: ctx.name,
      mcpTools: ctx.mcpTools,
      runsAs: ctx.runsAs,
      storage: ctx.storage.raw,
      code: ctx.code,
      workdir: ctx.workdir,
      processEnv: ctx.processEnv,
      models: ctx.models,
      resolvedModel: {
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        ...(ctx.unusableDefault === undefined ? {} : { unusableDefault: ctx.unusableDefault }),
      },
      ...(ctx.unfinished === undefined ? {} : { unfinished: ctx.unfinished }),
      ...(ctx.telemetry === undefined ? {} : { telemetry: ctx.telemetry as TelemetryContext }),
      ...(ctx.maxMessageBytes === undefined ? {} : { maxMessageBytes: ctx.maxMessageBytes }),
      work: ctx.work,
    });

    return {
      info: agent.info,
      usage: agent.usage,
      sessions: agent.sessions,
      messages: agent.messages,
      busy: () => agent.busy(),
      close: () => agent.close(),
      closed: agent.harness.closed.then(() => undefined),
      subscribeClose(listener) {
        try {
          return agent.harness.subscribeClose(listener);
        } catch {
          listener();
          return () => {};
        }
      },
    };
  },
};
