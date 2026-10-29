/**
 * Helpers shared across command modules: interactivity gates, port parsing, the startup auth report, first-run model
 * resolution, and the login terminal IO.
 */
import { resolve } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { buildModelPickerOptions } from "./models-view.ts";
import { LoginCancelled, type LoginIO, loginFlow } from "../harnesses/models/login.ts";
import { type ModelEnvironment, modelEnvironment } from "../harnesses/models/environment.ts";
import { listModels, providerAuthStatuses, providerOf } from "../harnesses/models/models.ts";
import type { OpenedServing } from "../harnesses/pi-durable/serve.ts";
import { definitionProviders, loadConfig, modelSpecFor } from "../harnesses/pi-durable/open.ts";
import { formatAuthReport } from "./auth-view.ts";
import { contentLines } from "./content-view.ts";
import { deployedHost, isDeployedWorkspace } from "../paths.ts";
import { log } from "../log.ts";
import { dotEnvPath, enterAgentEnv } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { bindAddress, isBindAddress } from "../bind.ts";
import { agentDirOrExit, failStartup, failUsage } from "./fail.ts";

/** An agent directory a command entered, and the default model that then resolves, if any. */
export interface EnteredAgent {
  agentDir: string;
  modelSpec?: string;
}

/**
 * How a command enters its agent directory, in the one order that works: the directory, the agent's environment, then
 * the first-run model picker. Returns the default model that then resolves, if any. `deploy` uses this directly: it
 * gates a missing model itself, by what will ship. `before`: what the command checks of the directory before a model
 * is asked for (`schedules run`: that the schedule it names exists).
 */
export async function enterAgentDirectory(
  dirArg: string,
  opts: { model?: string; input?: boolean },
  before?: (agentDir: string) => Promise<void>,
): Promise<EnteredAgent> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir);
  await before?.(agentDir);
  const modelSpec = await resolveFirstRunModel(agentDir, opts);
  return { agentDir, ...(modelSpec ? { modelSpec } : {}) };
}

/**
 * How every command that RUNS the agent on this machine enters it (dev, start, invoke, schedules run):
 * {@link enterAgentDirectory}, plus a default model. The agent opens without one, but a process here would then fail
 * every new conversation, so it stops at startup instead: exit 2, the choice a terminal's picker would have asked for.
 */
export async function enterAgentCommand(
  dirArg: string,
  opts: { model?: string; input?: boolean },
  before?: (agentDir: string) => Promise<void>,
): Promise<Required<EnteredAgent>> {
  const entered = await enterAgentDirectory(dirArg, opts, before);
  const { modelSpec } = entered;
  if (!modelSpec) {
    failUsage(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai/gpt-5.5"; ` +
        "`fastagent models` lists them)",
    );
  }
  return { ...entered, modelSpec };
}

/** The padded label writer for the STARTUP report (`dev`/`start`, stderr via the log level). */
function reportLine(label: string, value: string): void {
  log.info(`[fastagent] ${`${label}:`.padEnd(13)}${value}`);
}

/** What `dev` and `start` say about the agent they just opened, in the order they say it. */
export async function reportAssembly(
  opened: OpenedServing,
  modelSpec: string,
  extras: [label: string, value: string][] = [],
): Promise<void> {
  const { definition, code, models, agentDir, stateRoot } = opened;
  reportLine("agent", `${definition.name} — ${agentDir}`);
  for (const [label, value] of contentLines(opened.content)) reportLine(label, value);
  reportLine(
    "model",
    `${modelSpec}${definition.config.thinkingLevel ? ` (thinking: ${definition.config.thinkingLevel})` : ""}`,
  );
  await reportAuth(models, modelSpec, agentDir);
  const names = (list: readonly { name: string }[]) => list.map(({ name }) => name).join(", ") || "(none)";
  reportLine("tools", names(code.tools));
  if (code.extensions.length > 0) reportLine("extensions", names(code.extensions));
  reportLine("commands", (await opened.agent.info()).commands.map(({ name }) => `/${name}`).join(", ") || "(none)");
  reportLine("state", stateRoot);
  for (const [label, value] of extras) reportLine(label, value);
}

/** Both stdin and stdout are a terminal — the precondition for an interactive prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Parse + range-check a port string (CLI flag or env). */
export function parsePort(value: string | undefined, source: string, from: "flag" | "env"): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 65535) {
    const message = `invalid ${source} "${value}": must be an integer 0-65535`;
    if (from === "flag") failUsage(message);
    failStartup(new Error(message));
  }
  return Number(trimmed);
}

/**
 * Parse a `--bind` address: empty/whitespace is "not set" → undefined (the `??` chain falls through to config, then
 * all interfaces).
 */
export function parseBind(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!isBindAddress(trimmed)) failUsage(`invalid --bind "${value}": must be an IP address or "localhost"`);
  return bindAddress(trimmed); // a name never travels past this point — see bind.ts
}

/** Report which source provides the model's credentials, surfacing a remediation hint at startup. */
export async function reportAuth(models: ModelEnvironment, modelSpec: string, agentDir: string): Promise<void> {
  const provider = providerOf(modelSpec);
  // No files: the opener was handed a credential store, which is its caller's to describe.
  if (models.auth === undefined) {
    log.info(`[fastagent] auth:   the caller's credential store (${provider})`);
    return;
  }
  // The agent's own model environment, the one its turns run on and a deployed box's `login --if-missing` asks: the
  // line cannot name a file, or a source, other than the ones the runtime uses.
  const modelId = modelSpec.slice(provider.length + 1);
  const status = await models.authStatus(provider, modelId).catch(failStartup);
  const report = formatAuthReport({
    provider,
    path: models.auth.path,
    ...status,
    ...(isDeployedWorkspace()
      ? { deployed: { host: deployedHost() } }
      : { local: { authPath: models.auth.path, valueFile: dotEnvPath(agentDir) } }),
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
  options: { model?: string; input?: boolean } = {},
): Promise<string | undefined> {
  const config = await loadConfig(agentDir).catch(failStartup);
  const configured = modelSpecFor(config, options.model);
  if (configured) return configured;
  if (options.input === false) return undefined; // --no-input: never prompt (clig) — the caller decides what's missing
  if (!isInteractive()) return undefined; // CI/deploy: the caller raises the actionable missing-model error
  const providers = await definitionProviders(agentDir).catch(failStartup);
  const environment = await modelEnvironment(agentDir, {}, providers);
  const chosen = await pickWithCredentials(environment.models, environment.auth?.path as string, providers);
  if (chosen === undefined) return undefined; // cancelled (or auth probe failed): the caller raises its clear error
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  console.error(
    `[fastagent] picked ${chosen} — set \`model: ${JSON.stringify(chosen)}\` in fastagent.config.ts to keep it`,
  );
  return chosen;
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
    // Per-provider auth throws are captured as `broken` INSIDE providerAuthStatuses.
    log.warn(`[fastagent] could not probe provider auth: ${(error as Error).message}`);
    return undefined;
  }
  const r = await autocomplete({
    message: "Choose a model for this agent",
    options: buildModelPickerOptions(listModels(models), statuses),
  });
  if (isCancel(r)) return undefined; // cancelled: the caller raises its clear missing-model error
  const chosen = r as string;
  const provider = providerOf(chosen);
  const status = statuses.get(provider);
  if (status?.state === "ready") return chosen; // usable now — nothing to fix

  if (status && status.login === "none") {
    // No login flow exists for this provider — KEEP the choice and name the remedy.
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
    // Verified on this agent's registry, against the chosen model: the request the agent is about to make.
    await loginFlow(terminalLoginIO(), { provider, authPath, providers, verifyWith: chosen });
    console.error(`[fastagent] logged in to ${provider} — saved to ${authPath}`);
  } catch (error) {
    if (error instanceof LoginCancelled) return undefined; // user backed out — discard the choice, like a picker cancel
    // A FAILED login keeps the choice: the pick persists, the startup auth report names the remedy, and a later
    // `fastagent login` fixes auth without re-picking the model.
    log.warn(
      `[fastagent] login for "${provider}" failed: ${(error as Error).message} — model saved; run \`fastagent login\` to fix auth`,
    );
  }
  return chosen;
}

/** Login terminal IO via @clack/prompts: a searchable list once long, a hidden prompt for keys. */
export function terminalLoginIO(): LoginIO {
  return {
    async select(message, options) {
      const r = await (options.length > 7 ? autocomplete : select)({ message, options });
      return isCancel(r) ? undefined : (r as string);
    },
    async prompt(message, opts) {
      const r = opts?.hidden
        ? await password({ message, signal: opts.signal })
        : await clackText({ message, signal: opts?.signal });
      return isCancel(r) ? undefined : (r as string);
    },
    note: (message) => clackLog.info(message),
    openUrl: openExternalUrl,
  };
}
