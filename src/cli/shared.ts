/**
 * Helpers shared across command modules: interactivity gates, port parsing, the startup auth report, first-run model
 * resolution, and the login terminal IO.
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import type { Models } from "@earendil-works/pi-ai";
import { buildModelPickerOptions } from "./models-view.ts";
import { fastagentCredentialStore } from "../engines/pi/auth.ts";
import {
  isValidPort,
  listModels,
  loadConfig,
  providerOf,
  resolveAuthFallback,
  resolveAuthPath,
  resolveModel,
  resolveModelSpec,
  rewriteConfigModel,
} from "../engines/pi/config.ts";
import { LoginCancelled, type LoginIO, type LoginMethod, type LoginResult, loginFlow } from "../engines/pi/login.ts";
import {
  createPiModelRuntime,
  createPiModels,
  probeApiKey,
  probeAuthSource,
  providerAuthStatuses,
} from "../engines/pi/models.ts";
import { formatAuthReport } from "./auth-view.ts";
import { CODING_TOOL_NAMES } from "../engines/pi/create.ts";
import type { LoadedDefinition } from "../engines/pi/definition.ts";
import { type ModuleLoadFailure, reportModuleLoadFailures } from "../loader.ts";
import type { ToolCollision } from "../engines/pi/tool.ts";
import { reportFindingsIfChanged, reportToolCollisions } from "../engines/pi/report.ts";
import { type ResolvedPlacement, workspaceHint } from "../paths.ts";
import { log } from "../log.ts";
import { enterAgentEnv } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { bindAddress, isBindAddress } from "../bind.ts";
import { failStartup, failUsage, placementOrExit } from "./fail.ts";

/** How every command that runs the model enters its agent directory, in the one order that works. */
export async function enterAgentCommand(
  dirArg: string,
  opts: { model?: string; authPath?: string; input?: boolean },
): Promise<ResolvedPlacement> {
  const placement = placementOrExit(resolve(dirArg));
  enterAgentEnv(placement.agentDir);
  await resolveFirstRunModel(placement.agentDir, opts);
  return placement;
}

/** The padded label writer for the STARTUP report (`dev`/`start`, stderr via the log level). */
function reportLine(label: string, value: string): void {
  log.info(`[fastagent] ${`${label}:`.padEnd(13)}${value}`);
}

/** The workspace hint under the `agent:`/`workspace:` pair, when there is one ({@link workspaceHint}). */
function reportWorkspaceHint(hint: string | undefined): void {
  if (hint) reportLine("hint", hint);
}

/** What the startup report reads off an opened directory. */
export interface ReportableAssembly {
  agentDir: string;
  workspace: string;
  modelSpec: string;
  authPath: string;
  fallbackAuthPath?: string;
  config: { thinkingLevel?: string };
  definition: LoadedDefinition;
  toolNames: string[];
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}

/** What `dev` and `start` say about the directory they just opened, in the order they say it. */
export async function reportAssembly(
  a: ReportableAssembly,
  extras: {
    /** Printed between `workspace:`/`hint:` and `model:` (`dev` names the config file here). */
    beforeModel?: [label: string, value: string][];
    /** Printed after the tool lines, before findings (`start` names state + sessions here). */
    afterTools?: [label: string, value: string][];
  } = {},
): Promise<void> {
  reportLine("agent", a.agentDir);
  reportLine("workspace", a.workspace);
  reportWorkspaceHint(workspaceHint(a));
  for (const [label, value] of extras.beforeModel ?? []) reportLine(label, value);
  reportLine("model", `${a.modelSpec}${a.config.thinkingLevel ? ` (thinking: ${a.config.thinkingLevel})` : ""}`);
  await reportAuth(a.agentDir, a.modelSpec, a.authPath, a.fallbackAuthPath);
  reportLine("context", a.definition.contextFiles.map((f) => f.path).join(", ") || "(none)");
  if (a.definition.persona) reportLine("persona", "persona.md");
  reportLine("skills", a.definition.skills.map((s) => s.name).join(", ") || "(none)");
  reportLine("codingTools", CODING_TOOL_NAMES.join(", "));
  if (a.toolNames.length > 0) reportLine("tools", a.toolNames.join(", "));
  if (a.deferredToolNames.length > 0) {
    reportLine("deferred", `${a.deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(a.toolCollisions);
  reportModuleLoadFailures(a.toolFailures);
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
export async function reportAuth(
  agentDir: string,
  modelSpec: string,
  authPath: string,
  fallbackAuthPath?: string,
): Promise<void> {
  const provider = providerOf(modelSpec);
  const models = await createPiModelRuntime({
    agentDir,
    authPath,
    ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
  }).catch(failStartup);
  const source = await probeAuthSource(models, modelSpec);
  // One refresh-FREE read per layer, serving both questions below. A read failure is already warned about by the
  // store itself; this line degrades to "nothing stored" rather than taking down the startup report.
  const readFrom = (path: string) =>
    fastagentCredentialStore(path)
      .read(provider)
      .catch(() => undefined);
  const inPrimary = await readFrom(authPath);
  const inFallback = inPrimary || fallbackAuthPath === undefined ? undefined : await readFrom(fallbackAuthPath);
  // Name the layer the credential actually came from: "which file do I edit" is the question this line answers, and
  // a global credential lives in a file the agent dir does not contain. With NEITHER layer holding it, the answer is
  // the primary — that is the file the `fastagent login` this report recommends writes.
  const found = fallbackAuthPath !== undefined && inFallback ? fallbackAuthPath : authPath;
  // Only when nothing satisfies auth does the stored credential matter: it tells "nothing stored" from "stored but
  // unusable".
  const stored = source === undefined ? (inPrimary ?? inFallback) : undefined;
  const report = formatAuthReport(provider, found, source, stored);
  log.info(`[fastagent] ${report.line}`);
  if (report.warn) log.warn(`[fastagent] ${report.warn}`);
}

/**
 * First-run model resolution for every assembly command (dev/start/invoke/fire/chat/deploy): ONE funnel, no dead ends.
 */
async function resolveFirstRunModel(
  agentDir: string,
  options: { model?: string; authPath?: string; input?: boolean } = {},
): Promise<void> {
  const { config, path: configPath } = await loadConfig(agentDir).catch(failStartup);
  if (resolveModelSpec(options.model, config)) return; // already set (flag > FASTAGENT_MODEL > config)
  if (options.input === false) return; // --no-input: never prompt (clig) — the opener raises the clear error
  if (!isInteractive()) return; // CI/deploy: the opener throws the actionable missing-model error

  const authPath = resolveAuthPath(agentDir, options.authPath);
  const fallbackAuthPath = resolveAuthFallback(options.authPath);
  // The picker lists the AGENT's surface: built-ins plus whatever its models.json declares, so a self-hosted endpoint
  // is pickable on first run instead of being invisible until hand-set.
  const models = await createPiModelRuntime({
    agentDir,
    authPath,
    ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
  }).catch(failStartup);
  const chosen = await pickWithCredentials(models, authPath);
  if (chosen === undefined) return; // cancelled (or auth probe failed): the caller raises its clear missing-model error
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  await persistModelChoice(agentDir, configPath, chosen);
}

/** The credential-aware pick: full catalog annotated per provider, then the post-pick auth policy. */
async function pickWithCredentials(models: Models, authPath: string): Promise<string | undefined> {
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
    // Verified against the CHOSEN model — the exact request the agent is about to make.
    await loginWithKeyCheck(provider, authPath, chosen);
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

/**
 * Interactive login with the api_key quick-fail probe closed into a LOOP: a definitively rejected key (HTTP 401)
 * deletes the bad credential and RE-PROMPTS immediately.
 */
export async function loginWithKeyCheck(
  provider: string | undefined,
  authPath: string,
  spec?: string,
  // Test seams: this loop DESTROYS credential state on `rejected`, so its policy (rejected → delete → re-ask ONLY the
  // key) is pinned by a test through fake flow/verify.
  seams: {
    flow?: (
      io: LoginIO,
      options: { provider?: string; authPath?: string; method?: LoginMethod },
    ) => Promise<LoginResult>;
    verify?: (provider: string, authPath: string, spec?: string) => Promise<"ok" | "rejected" | "unknown">;
  } = {},
): Promise<LoginResult> {
  const flow = seams.flow ?? loginFlow;
  const verify = seams.verify ?? verifyApiKeyLogin;
  const io = terminalLoginIO();
  let method: LoginMethod | undefined;
  for (;;) {
    const result = await flow(io, { provider, authPath, method });
    if (result.method !== "api_key") return result;
    const verdict = await verify(result.provider, authPath, spec);
    if (verdict !== "rejected") return result;
    // Retry re-asks ONLY the key: the provider/method choices weren't the mistake, the keystrokes were.
    provider = result.provider;
    method = "api_key";
  }
}

/** Quick-fail check after an api_key login (OAuth needs none — completing the flow already proved the credential). */
async function verifyApiKeyLogin(
  provider: string,
  authPath: string,
  spec?: string,
): Promise<"ok" | "rejected" | "unknown"> {
  // Built-ins only: `login` itself offers built-in providers (login.ts), and a models.json endpoint authenticates
  // from its own `apiKey` (env/command), so there is no stored credential to verify here.
  const models = createPiModels({ authPath });
  const model = spec ? resolveModel(models, spec) : models.getProvider(provider)?.getModels()[0];
  if (!model) {
    console.error(`[fastagent] cannot verify the key: provider "${provider}" lists no models — kept as stored`);
    return "unknown";
  }
  const label = `${model.provider}/${model.id}`;
  console.error(`[fastagent] verifying the key with ${label}…`);
  const probe = await probeApiKey(models, model);
  if (probe.state === "ok") {
    console.error(`[fastagent] key verified — ${label} responded`);
  } else if (probe.state === "rejected") {
    await fastagentCredentialStore(authPath).delete(provider);
    console.error(
      `[fastagent] ${provider} rejected the API key (HTTP 401): ${probe.message} — enter it again (or cancel)`,
    );
  } else {
    console.error(
      `[fastagent] could not verify the key with ${label}: ${probe.message} — kept; invokes surface the provider's error`,
    );
  }
  return probe.state;
}

/** Login terminal IO via @clack/prompts: a searchable list once long, a hidden prompt for keys. */
function terminalLoginIO(): LoginIO {
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
  const hint = (): void =>
    console.error(
      // The pick lives in THIS process's environment only, so it serves this run and nothing that outlives it: a
      // deployment resolves in the environment being deployed, where this machine's variables do not exist.
      `[fastagent] picked ${spec} — set \`model: ${JSON.stringify(spec)}\` in your config to persist`,
    );
  if (!configPath) return hint();
  try {
    const replaced = rewriteConfigModel(await readFile(configPath, "utf8"), spec);
    if (!replaced) return hint();
    await writeFile(configPath, replaced);
    console.error(`[fastagent] saved model ${JSON.stringify(spec)} to ${relative(agentDir, configPath)}`);
  } catch {
    hint();
  }
}
