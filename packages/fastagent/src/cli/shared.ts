/**
 * Entering an agent directory for commands that run the agent (`dev`, `start`, `invoke`):
 * directory + instance entry, first-run model resolution, and startup assembly/auth reporting.
 */
import { resolve } from "node:path";
import { autocomplete, isCancel } from "@clack/prompts";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { definedValues } from "../declared-secrets.ts";
import { type ModelEnvironment, modelEnvironment } from "../harnesses/models/environment.ts";
import { SignInCancelled } from "../harnesses/models/login.ts";
import { listModels, providerAuthStatuses, providerOf } from "../harnesses/models/models.ts";
import type { AgentDefinition } from "../definition/definition.ts";
import {
  buildDefinitionShape,
  definitionProviders,
  loadSourceDefinition,
  modelSpecFor,
} from "../harnesses/assembly.ts";
import type { OpenedServing } from "../harnesses/serving.ts";
import { log } from "../log.ts";
import { isDeployedWorkspace } from "../paths.ts";
import { readProcessEnv } from "../process-env.ts";
import { dotEnvPath } from "../value-file.ts";
import { formatAuthReport } from "./auth-view.ts";
import { agentDirOrExit, failStartup, failUsage } from "./fail.ts";
import { type EnteredInstance, type InstanceFlags, enterInstance } from "./instance.ts";
import { isInteractive, loginFlow, terminalLoginIO } from "./login-ui.ts";
import { buildModelPickerOptions } from "./models-view.ts";

/** The definition a command runs, when it is not the source one (`start` runs the build). */
type LoadDefinition = (agentDir: string) => Promise<AgentDefinition>;

interface EnteredAgent {
  agentDir: string;
  instance: EnteredInstance;
  modelSpec?: string;
  pickedModel?: string;
}

async function enterAgentDirectory(
  dirArg: string,
  opts: { model?: string; input?: boolean; instance?: InstanceFlags },
  before?: (agentDir: string, instance: EnteredInstance) => Promise<void>,
  load?: LoadDefinition,
): Promise<EnteredAgent> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const instance = enterInstance(agentDir, opts.instance);
  await before?.(agentDir, instance);
  const { modelSpec, pickedModel } = await resolveFirstRunModel(agentDir, instance.configEnv, opts, load);
  return {
    agentDir,
    instance,
    ...(modelSpec === undefined ? {} : { modelSpec }),
    ...(pickedModel === undefined ? {} : { pickedModel }),
  };
}

/**
 * How every command that runs the agent on this machine enters it (`dev`, `start`, `invoke`):
 * enters the directory and resolves a default model, or exits 2 when none is set and no terminal can pick one.
 */
export async function enterAgentCommand(
  dirArg: string,
  opts: { model?: string; input?: boolean; instance?: InstanceFlags },
  before?: (agentDir: string, instance: EnteredInstance) => Promise<void>,
  load?: LoadDefinition,
): Promise<Omit<EnteredAgent, "modelSpec"> & { modelSpec: string }> {
  const entered = await enterAgentDirectory(dirArg, opts, before, load);
  const { modelSpec } = entered;
  if (!modelSpec) {
    failUsage(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai/gpt-5.5"; ` +
        "`fastagent models` lists them)",
    );
  }
  return { ...entered, modelSpec };
}

function reportLine(label: string, value: string): void {
  log.info(`[fastagent] ${`${label}:`.padEnd(13)}${value}`);
}

/** What `dev` and `start` say about the agent they just opened, in the order they say it. */
export async function reportAssembly(opened: OpenedServing, modelSpec: string): Promise<void> {
  const { code, models, agentDir, workdir, stateRoot, config } = opened;
  reportLine("agent", `${opened.name} — ${workdir}`);
  if (opened.harness !== "pi-durable") {
    reportLine("harness", `${opened.harness}${opened.sandbox ? ` (sandbox: ${opened.sandbox})` : ""}`);
  }
  reportLine("model", `${modelSpec}${config.thinkingLevel ? ` (thinking: ${config.thinkingLevel})` : ""}`);
  await reportAuth(models, modelSpec, agentDir);
  const names = (list: readonly { name: string }[]) => list.map(({ name }) => name).join(", ") || "(none)";
  reportLine("tools", names(code.tools));
  if (code.extensions.length > 0) reportLine("extensions", names(code.extensions));
  reportLine("commands", (await opened.agent.info()).commands.map(({ name }) => `/${name}`).join(", ") || "(none)");
  reportLine("state", stateRoot);
}

/** Report which source provides the model's credentials, surfacing a remediation hint at startup. */
export async function reportAuth(models: ModelEnvironment, modelSpec: string, agentDir: string): Promise<void> {
  const provider = providerOf(modelSpec);
  const modelId = modelSpec.slice(provider.length + 1);
  const status = await models.authStatus(provider, modelId).catch(failStartup);
  const report = formatAuthReport({
    provider,
    path: models.auth?.path ?? "",
    ...status,
    ...(isDeployedWorkspace() ? { deployed: true } : { local: { valueFile: dotEnvPath(agentDir) } }),
  });
  log.info(`[fastagent] ${report.line}`);
  if (report.warn) log.warn(`[fastagent] ${report.warn}`);
}

/**
 * The default model, for every command that runs the agent: `--model` > `FASTAGENT_MODEL` > `fastagent.config.ts`. With
 * none and a terminal, the first-run picker chooses one for this run (and logs in to its provider when needed).
 */
async function resolveFirstRunModel(
  agentDir: string,
  env: Readonly<Record<string, string | undefined>>,
  options: { model?: string; input?: boolean } = {},
  load?: LoadDefinition,
): Promise<{ modelSpec?: string; pickedModel?: string }> {
  const loaded = (load ?? loadSourceDefinition)(agentDir);
  const definition = await (load === undefined ? loaded.catch(failStartup) : loaded);
  const spec = modelSpecFor(definition.config, options.model, env);
  if (spec) return { modelSpec: spec };
  if (options.input === false) return {};
  if (!isInteractive()) return {};
  const hostEnv = readProcessEnv();
  const providers =
    load === undefined
      ? await definitionProviders(agentDir, hostEnv).catch(failStartup)
      : buildDefinitionShape(definition, hostEnv).providers;
  const environment = await modelEnvironment(agentDir, {}, providers, { environment: definedValues(hostEnv) });
  const chosen = await pickWithCredentials(environment.models, environment.auth?.path as string, providers);
  if (chosen === undefined) return {};
  console.error(
    `[fastagent] picked ${chosen} — set \`model: ${JSON.stringify(chosen)}\` in fastagent.config.ts to keep it`,
  );
  return { modelSpec: chosen, pickedModel: chosen };
}

/** The credential-aware pick: full catalog annotated per provider, then the post-pick auth policy. */
async function pickWithCredentials(
  models: Models,
  authPath: string,
  providers: readonly Provider[],
): Promise<string | undefined> {
  let statuses: Awaited<ReturnType<typeof providerAuthStatuses>>;
  try {
    statuses = await providerAuthStatuses(models);
  } catch (error) {
    log.warn(`[fastagent] could not probe provider auth: ${(error as Error).message}`);
    return undefined;
  }
  const r = await autocomplete({
    message: "Choose a model for this agent",
    options: buildModelPickerOptions(listModels(models), statuses),
  });
  if (isCancel(r)) return undefined;
  const chosen = r as string;
  const provider = providerOf(chosen);
  const status = statuses.get(provider);
  if (status?.state === "ready") return chosen;

  if (status && status.login === "none") {
    if (status.state === "broken") {
      log.warn(
        `[fastagent] stored auth for "${provider}" is unusable: ${status.message} — fix or remove it in ${authPath}; invokes fail until then`,
      );
    } else {
      log.warn(`[fastagent] "${provider}" has no interactive login — set its API key env var; invokes fail until then`);
    }
    return chosen;
  }

  try {
    await loginFlow(terminalLoginIO(), { provider, authPath, providers, verifyWith: chosen });
    console.error(`[fastagent] logged in to ${provider} — saved to ${authPath}`);
  } catch (error) {
    if (error instanceof SignInCancelled) return undefined;
    log.warn(
      `[fastagent] login for "${provider}" failed: ${(error as Error).message} — model saved; run \`fastagent login\` to fix auth`,
    );
  }
  return chosen;
}
