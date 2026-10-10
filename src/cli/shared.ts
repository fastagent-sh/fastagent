/**
 * Helpers shared across command modules: interactivity gates, port parsing, the startup auth report, first-run model
 * resolution, and the login terminal IO.
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import type { Models } from "@earendil-works/pi-ai";
import { buildModelPickerOptions } from "./models-view.ts";
import {
  isValidPort,
  listModels,
  loadConfig,
  missingDefaultModel,
  providerOf,
  resolveModelSpec,
  rewriteConfigModel,
} from "../harnesses/pi/config.ts";
import { LoginCancelled, type LoginIO, loginFlow } from "../harnesses/pi/login.ts";
import { readMachine, withMachine } from "../harnesses/pi/machine.ts";
import { providerAuthStatuses } from "../harnesses/pi/models.ts";
import { type AgentModels, agentModels } from "../harnesses/pi/agent-models.ts";
import { formatAuthReport } from "./auth-view.ts";
import { CODING_TOOL_NAMES, type IndirectTool } from "../harnesses/pi/create.ts";
import type { LoadedDefinition } from "../harnesses/pi/definition.ts";
import type { ToolCollision } from "../harnesses/pi/tool.ts";
import {
  describeIndirectTools,
  describeTools,
  describePrompt,
  reportFindingsIfChanged,
  reportToolCollisions,
} from "../harnesses/pi/report.ts";
import { deployedHost, isDeployedWorkspace } from "../paths.ts";
import type { ResolvedContent } from "../content/resolve.ts";
import { contentLines } from "./content-view.ts";
import { log } from "../log.ts";
import { dotEnvPath, enterAgentEnv } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { bindAddress, isBindAddress } from "../bind.ts";
import { agentDirOrExit, failStartup, failUsage } from "./fail.ts";
import { enterEnvironment } from "../environment/mise.ts";

/** An agent directory a command entered, and the default model that then resolves, if any. */
export interface EnteredAgent {
  agentDir: string;
  modelSpec?: string;
}

/**
 * How a command enters its agent directory, in the one order that works: the directory, the agent's environment, then
 * the first-run model picker. Returns the default model that then resolves, if any. `deploy` uses this directly: it
 * gates a missing model itself, by what will ship.
 */
export async function enterAgentDirectory(
  dirArg: string,
  opts: { model?: string; input?: boolean },
): Promise<EnteredAgent> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir);
  const modelSpec = await resolveFirstRunModel(agentDir, opts);
  return { agentDir, ...(modelSpec ? { modelSpec } : {}) };
}

/**
 * How every command that RUNS the agent on this machine enters it (dev, start, invoke, chat):
 * {@link enterAgentDirectory}, plus a default model, plus its environment (mise.toml) on this process's PATH. The agent
 * opens without a model, but a process here would then fail every new conversation, so it stops at startup with
 * {@link missingDefaultModel} instead. `environment: false` is for a process that runs no agent itself: `dev`'s
 * supervisor, whose workers enter the environment each time they start, after an edit to mise.toml included.
 */
export async function enterAgentCommand(
  dirArg: string,
  opts: { model?: string; input?: boolean; environment?: boolean },
): Promise<Required<EnteredAgent>> {
  const entered = await enterAgentDirectory(dirArg, opts);
  const { modelSpec } = entered;
  if (!modelSpec) failStartup(missingDefaultModel());
  if (opts.environment !== false) await enterEnvironment(entered.agentDir).catch(failStartup);
  return { ...entered, modelSpec };
}

/** The padded label writer for the STARTUP report (`dev`/`start`, stderr via the log level). */
function reportLine(label: string, value: string): void {
  log.info(`[fastagent] ${`${label}:`.padEnd(13)}${value}`);
}

/** What the startup report reads off an opened directory. */
export interface ReportableAssembly {
  agentDir: string;
  content: readonly ResolvedContent[];
  modelSpec: string;
  models: AgentModels;
  config: { thinkingLevel?: string };
  definition: LoadedDefinition;
  toolNames: string[];
  toolSources: Map<string, string>;
  indirectTools: IndirectTool[];
  toolCollisions: ToolCollision[];
}

/** What `dev` and `start` say about the directory they just opened, in the order they say it. */
export async function reportAssembly(
  a: ReportableAssembly,
  extras: {
    /** Printed between `agent:` and `model:` (`dev` names the config file here). */
    beforeModel?: [label: string, value: string][];
    /** Printed after the tool lines, before findings (`start` names state + sessions here). */
    afterTools?: [label: string, value: string][];
  } = {},
): Promise<void> {
  reportLine("agent", a.agentDir);
  for (const [label, value] of contentLines(a.content)) reportLine(label, value);
  for (const [label, value] of extras.beforeModel ?? []) reportLine(label, value);
  reportLine("model", `${a.modelSpec}${a.config.thinkingLevel ? ` (thinking: ${a.config.thinkingLevel})` : ""}`);
  await reportAuth(a.models, a.modelSpec, a.agentDir);
  reportLine("prompt", describePrompt(a.definition));
  // What this agent HAS — the definition's skills and the ones its machine lends (machine.ts).
  const skills = withMachine(a.definition.skills, (await readMachine(a.agentDir)).skills);
  reportLine("skills", skills.map((s) => s.name).join(", ") || "(none)");
  reportLine("codingTools", CODING_TOOL_NAMES.join(", "));
  if (a.toolNames.length > 0) reportLine("tools", describeTools(a.toolNames, a.toolSources));
  if (a.indirectTools.length > 0) reportLine("indirect", describeIndirectTools(a.indirectTools));
  reportToolCollisions(a.toolCollisions);
  for (const [label, value] of extras.afterTools ?? []) reportLine(label, value);
  reportFindingsIfChanged(a.definition.dir, a.definition);
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
  if (!/^\d+$/.test(trimmed) || !isValidPort(Number(trimmed))) {
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
export async function reportAuth(models: AgentModels, modelSpec: string, agentDir: string): Promise<void> {
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
 * First-run model resolution for every assembly command (dev/start/invoke/fire/chat/deploy): ONE funnel, no dead ends.
 */
async function resolveFirstRunModel(
  agentDir: string,
  options: { model?: string; input?: boolean } = {},
): Promise<string | undefined> {
  const { config, path: configPath } = await loadConfig(agentDir).catch(failStartup);
  const configured = resolveModelSpec(options.model, config);
  if (configured) return configured; // already set (flag > FASTAGENT_MODEL > config)
  if (options.input === false) return undefined; // --no-input: never prompt (clig) — the caller decides what's missing
  if (!isInteractive()) return undefined; // CI/deploy: the caller raises the actionable missing-model error

  const environment = agentModels(agentDir);
  // The picker lists the AGENT's surface: built-ins plus whatever its models.json declares, so a self-hosted endpoint
  // is pickable on first run instead of being invisible until hand-set.
  const models = await environment.runtime().catch(failStartup);
  const chosen = await pickWithCredentials(models, environment.auth.path, agentDir);
  if (chosen === undefined) return undefined; // cancelled (or auth probe failed): the caller raises its clear error
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  await persistModelChoice(agentDir, configPath, chosen);
  return chosen;
}

/** The credential-aware pick: full catalog annotated per provider, then the post-pick auth policy. */
async function pickWithCredentials(models: Models, authPath: string, agentDir: string): Promise<string | undefined> {
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
    await loginFlow(terminalLoginIO(), { provider, authPath, agentDir, verifyWith: chosen });
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

/** Best-effort persist the picked model so the next run does not prompt. */
async function persistModelChoice(agentDir: string, configPath: string | undefined, spec: string): Promise<void> {
  const hint = (why = ""): void =>
    console.error(
      // The pick lives in THIS process's environment only, so it serves this run and nothing that outlives it: a
      // deployment resolves in the environment being deployed, where this machine's variables do not exist.
      `[fastagent] picked ${spec} — set \`model: ${JSON.stringify(spec)}\` in your config to persist${why}`,
    );
  if (!configPath) return hint();
  try {
    const replaced = rewriteConfigModel(await readFile(configPath, "utf8"), spec);
    if (!replaced) return hint();
    await writeFile(configPath, replaced);
    console.error(`[fastagent] saved model ${JSON.stringify(spec)} to ${relative(agentDir, configPath)}`);
  } catch (error) {
    // The run goes on with the pick either way; the reason the file was not written is what the author needs to fix.
    hint(` (could not write ${configPath}: ${(error as Error).message})`);
  }
}
