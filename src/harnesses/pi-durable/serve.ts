/**
 * An agent package opened: its definition prepared (the registry generated, the secrets manifest written), its code
 * built with its secrets, its model environment, its storage, and the Agent over them. `openAgent` is how an app opens
 * one (SPEC.md §8); `dev`, `start`, AgentCore, `invoke` and `schedules run` open it through `openServing`, which
 * also takes where the Agent keeps its sessions and what becomes of an earlier process's messages.
 */
import { join } from "node:path";
import type { CredentialStore, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { CredentialSourceOptions } from "../models/credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "../models/environment.ts";
import { loadContent } from "../../content/file.ts";
import {
  type ResolvedContent,
  absentNotice,
  cloneContent,
  contentAbsentHere,
  resolveContent,
} from "../../content/resolve.ts";
import { enterEnvironment } from "../../environment/mise.ts";
import { log } from "../../log.ts";
import type { Agent } from "../../agent-api.ts";
import { resolveStateRoot } from "../../paths.ts";
import { type Service, serveAgent } from "../../service.ts";
import type { DurableAgent, Unfinished } from "./agent.ts";
import {
  type AgentDefinition,
  type BuiltDefinition,
  buildDefinition,
  assembleAgent,
  prepareDefinition,
} from "./open.ts";
import { type StorageLocking, openLockedStorage } from "./storage.ts";

export interface OpenServingOptions extends CredentialSourceOptions {
  /** What a deployment sets over the definition's defaults (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /**
   * Where the Agent keeps its sessions. Default `{ instance: "posix" }`: the instance's `agent.sqlite`, which one process
   * holds at a time (storage.ts), with `wake` and `unwake`, since a serve's clock fires the wake-ups they keep. The other
   * two never meet the storage a serve of the same directory holds, and have no `wake`, since no clock fires for them:
   * `{ file }` is a database of the caller's own, held the same way (`holders`, when given, names in the refusal of a
   * second opener what else opens it), and `"memory"` keeps nothing.
   */
  storage?: ServingStorage;
  /** What becomes of the messages an earlier process left unfinished in the storage. Default `"resume"`. */
  unfinished?: Unfinished;
}

type ServingStorage = { instance: StorageLocking } | { file: string; holders?: string } | "memory";

/** Who opens the instance's storage, for the refusal of a second opener. */
const INSTANCE_HOLDERS =
  "another `fastagent dev`, `start` or `schedules` command of this agent (or of another agent with the same state root)";

export interface OpenedServing {
  agent: DurableAgent;
  definition: AgentDefinition;
  code: BuiltDefinition;
  models: ModelEnvironment;
  /** What the agent works on and knows, resolved for this instance. */
  content: readonly ResolvedContent[];
  agentDir: string;
  /** Where the instance's state is: its storage, its channels' and schedules' state, its wake-ups. */
  stateRoot: string;
  /** The definition's channels and schedules, as `serveAgent` serves them: `serveAgent(opened)`. */
  channels: BuiltDefinition["channels"];
  schedules: BuiltDefinition["schedules"];
}

/**
 * The content, once per process, before the agent opens: the locations are fixed until a restart, what is in them is
 * read per message. This process runs the agent, so a repository with no checkout here is cloned, or its clone brought
 * up to date in place where git can do so without touching the agent's work, first; then resolved again as what is now
 * on disk.
 */
async function contentForThisRun(dir: string): Promise<ResolvedContent[]> {
  const declaration = loadContent(dir);
  for (const entry of resolveContent(dir, declaration)) {
    if (entry.kind !== "github" || !entry.clone) continue;
    const done = await cloneContent(entry);
    if (done.outcome === "kept") {
      log.warn(`[fastagent] content "${entry.name}": the clone in ${entry.location} is kept as it is, ${done.reason}`);
    } else {
      const said = { cloned: "cloned", updated: "brought up to date", current: "already up to date" }[done.outcome];
      log.info(`[fastagent] github ${entry.repo}${entry.ref ? ` at ${entry.ref}` : ""}: ${said} in ${entry.location}`);
    }
  }
  for (const absent of contentAbsentHere(declaration)) log.warn(`[fastagent] content ${absentNotice(absent)}`);
  return resolveContent(dir, declaration);
}

/** The instance's database, under its state root. */
const instanceStorageFile = (stateRoot: string) => join(stateRoot, "agent.sqlite");

/**
 * Run `work` holding the instance's storage, so no serve of the instance runs meanwhile: how a command changes the
 * instance's state outside a serve without losing a write to a serve's own.
 */
export async function holdingInstance<T>(stateRoot: string, work: () => T): Promise<T> {
  const storage = await openLockedStorage(instanceStorageFile(stateRoot), "posix", INSTANCE_HOLDERS);
  try {
    return work();
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

function openStorage(stateRoot: string, storage: ServingStorage): Promise<Storage> | Storage {
  if (storage === "memory") return new MemoryStorage();
  if ("file" in storage) return openLockedStorage(storage.file, "posix", storage.holders);
  return openLockedStorage(instanceStorageFile(stateRoot), storage.instance, INSTANCE_HOLDERS);
}

export async function openServing(directory: string, options: OpenServingOptions = {}): Promise<OpenedServing> {
  const definition = await prepareDefinition(directory);
  const { dir } = definition;
  const code = buildDefinition(definition);
  // The commands the agent runs, as `context.json`'s environment declares them, before anything can run one.
  await enterEnvironment(dir);
  const content = await contentForThisRun(dir);
  const models = modelEnvironment(
    dir,
    {
      ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
      ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    },
    code.providers,
  );
  const stateRoot = resolveStateRoot(dir);
  const chosen = options.storage ?? { instance: "posix" };
  const storage = await openStorage(stateRoot, chosen);
  const agent = await assembleAgent(definition, {
    storage,
    code,
    content,
    credentials: models.credentials,
    ...(typeof chosen === "object" && "instance" in chosen ? { stateRoot } : {}),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.unfinished === undefined ? {} : { unfinished: options.unfinished }),
  }).catch(async (error: unknown) => {
    // An Agent that did not open does not own the storage, and its lock would refuse this process's next attempt.
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  });
  return {
    agent,
    definition,
    code,
    models,
    content,
    agentDir: dir,
    stateRoot,
    channels: code.channels,
    schedules: code.schedules,
  };
}

/** An agent opened in this process (SPEC.md §8): the Agent API, and how it is served and operated. */
export interface LocalAgent extends Agent {
  /**
   * Channels, schedules and wake-ups, `/health`, and the Agent API under `/v1` when `apiKeys` holds a key: a Fetch
   * handler, or a server of its own (`listen`).
   */
  serve(options?: ServeAgentOptions): Promise<Service>;
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present (SPEC.md §9.1). */
  apiKeys?: readonly string[];
}

export interface OpenAgentOptions {
  /** `"provider/modelId"`, over the definition's: what a session that names none answers with. */
  model?: string;
  /** Where provider credentials are kept, instead of the agent's own `.secrets/auth.json` over the machine's. */
  credentials?: CredentialStore;
}

/**
 * Open the agent directory `dir` the way `dev` and `start` do before they serve: its definition, its code built with
 * the secrets it declares, its environment, its content and the instance's storage, which one process holds at a time.
 * Nothing reaches the agent until `serve`.
 */
export async function openAgent(dir: string, options: OpenAgentOptions = {}): Promise<LocalAgent> {
  const opened = await openServing(dir, {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.credentials === undefined ? {} : { credentialStore: options.credentials }),
  });
  const { agent } = opened;
  let served: Promise<Service> | undefined;
  let closing: Promise<void> | undefined;
  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    harness: agent.harness,
    serve(serveOptions = {}) {
      // Its storage is let go, or about to be: a service now would run channels and schedules nobody closes.
      if (closing !== undefined) return Promise.reject(new Error("this agent is closed"));
      if (served !== undefined) return Promise.reject(new Error("this agent is already served"));
      const serving = serveAgent(opened, serveOptions);
      served = serving;
      // A serve that failed to start rolled itself back, so the agent may be served again.
      serving.catch(() => {
        if (served === serving) served = undefined;
      });
      return serving;
    },
    close() {
      closing ??= (async () => {
        // A serve that never started has nothing to close; its failure reached the caller of `serve`.
        const service = await served?.catch(() => undefined);
        const failures: unknown[] = [];
        await service?.close().catch((error: unknown) => failures.push(error));
        await agent.close().catch((error: unknown) => failures.push(error));
        if (failures.length > 0) {
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the agent did not close cleanly");
        }
      })();
      return closing;
    },
  };
}
