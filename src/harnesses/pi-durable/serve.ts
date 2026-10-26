/**
 * An agent package opened to be served: its definition prepared (the registry generated, the secrets manifest
 * written), its code built with its secrets, its model environment, its storage, and the Agent over them. `dev`,
 * `start`, AgentCore and an embedder that serves channels open it through this one function.
 */
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { CredentialSourceOptions } from "../models/credentials.ts";
import { type ModelEnvironment, modelEnvironment } from "../models/environment.ts";
import { loadContent } from "../../content/file.ts";
import { type ResolvedContent, resolveContent } from "../../content/resolve.ts";
import { enterEnvironment } from "../../environment/mise.ts";
import { resolveStateRoot } from "../../paths.ts";
import type { DurableAgent } from "./agent.ts";
import { type AgentDefinition, type BuiltDefinition, buildDefinition, openAgent, prepareDefinition } from "./open.ts";
import { type StorageLocking, openInstanceStorage } from "./storage.ts";

export interface OpenServingOptions extends CredentialSourceOptions {
  /** What a deployment sets over the definition's defaults (a flag, `FASTAGENT_MODEL`). */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /**
   * How the storage keeps a second opener out (storage.ts). Default: SQLite's own locks. `"memory"`: no storage of the
   * instance's at all, for a one-shot message that must not meet the storage a serve of the same directory holds.
   */
  locking?: StorageLocking | "memory";
}

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
}

/** The instance's database, under its state root. */
const STORAGE_FILE = "agent.sqlite";

export async function openServing(dir: string, options: OpenServingOptions = {}): Promise<OpenedServing> {
  const definition = await prepareDefinition(dir);
  const code = buildDefinition(definition);
  // The commands the agent runs, as `context.json`'s environment declares them, before anything can run one.
  await enterEnvironment(dir);
  const content = resolveContent(dir, loadContent(dir));
  const models = modelEnvironment(
    dir,
    {
      ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
      ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    },
    code.providers,
  );
  const stateRoot = resolveStateRoot(dir);
  const locking = options.locking ?? "posix";
  const storage =
    locking === "memory" ? new MemoryStorage() : await openInstanceStorage(join(stateRoot, STORAGE_FILE), locking);
  const agent = await openAgent(definition, {
    storage,
    code,
    content,
    credentials: models.credentials,
    // A serve's clock fires the wake-ups `wake` keeps; a one-shot message has none.
    ...(locking === "memory" ? {} : { stateRoot }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  });
  return { agent, definition, code, models, content, agentDir: dir, stateRoot };
}
