/**
 * Helpers shared across command modules: interactivity gates, port parsing, the startup auth report,
 * first-run model resolution, and the login terminal IO. Bodies moved verbatim from cli.ts; the
 * module-scoped flag access (`values.*`) became parameters.
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { buildModelPickerOptions } from "../cli-models.ts";
import { fastagentCredentialStore } from "../engines/pi/auth.ts";
import {
  isValidPort,
  listModels,
  loadConfig,
  providerOf,
  resolveAuthPath,
  resolveModel,
  resolveModelSpec,
  resolveStateRoot,
  rewriteConfigModel,
} from "../engines/pi/config.ts";
import { ensureStateRootSelfIgnored, isUnderDir } from "../engines/pi/definition.ts";
import { LoginCancelled, type LoginIO, type LoginMethod, type LoginResult, loginFlow } from "../engines/pi/login.ts";
import { createPiModels, probeApiKey, probeAuthSource, providerAuthStatuses } from "../engines/pi/models.ts";
import { formatAuthReport } from "../cli-auth.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { failStartup, failUsage } from "./fail.ts";

/** Both stdin and stdout are a terminal — the precondition for an interactive prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Parse + range-check a port string (CLI flag or env). Empty/whitespace is "not set" → undefined, so
 * the `??` chain falls through instead of binding port 0 (`Number("")` is 0). The exit code follows
 * RESPONSIBILITY, not the layer that discovers the problem: a bad `--port` is a usage error (2), a
 * bad `PORT` env is broken runtime configuration (1).
 */
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

/** Report which source provides the model's credentials, surfacing a remediation hint at startup. Non-blocking. */
export async function reportAuth(modelSpec: string, authPath: string): Promise<void> {
  const provider = providerOf(modelSpec);
  const source = await probeAuthSource(createPiModels({ authPath }), modelSpec);
  // Only when nothing satisfies auth do we read the store (refresh-FREE) to tell "nothing stored" from
  // "stored but unusable" — see formatAuthReport for why. store.read warns on a corrupt file itself.
  const stored =
    source === undefined
      ? await fastagentCredentialStore(authPath)
          .read(provider)
          .catch(() => undefined)
      : undefined;
  const report = formatAuthReport(provider, authPath, source, stored);
  log.info(`[fastagent] ${report.line}`);
  if (report.warn) log.warn(`[fastagent] ${report.warn}`);
}

/**
 * First-run model resolution for the serving commands: ONE funnel, no dead ends. When no model is set
 * (flag/env/config) and we're on a TTY, show the FULL catalog annotated per provider — ready (with the
 * credential source, so which account pays is visible at the decision point) or login-required — and,
 * when the choice needs auth, run the login flow INLINE instead of exiting with "run `fastagent login`
 * and come back". A no-op when a model is already set; on a non-TTY (CI/deploy), with `--no-input`, on
 * cancel, or on a failed login it stays quiet and lets the opener raise its clear "missing model"
 * error. The pick is exported to FASTAGENT_MODEL so a spawned `dev` worker inherits it, and
 * best-effort written back to the config so the next run is quiet.
 */
export async function resolveFirstRunModel(
  workspaceDir: string,
  options: { model?: string; authPath?: string; input?: boolean } = {},
): Promise<void> {
  const { config, path: configPath } = await loadConfig(workspaceDir).catch(failStartup);
  if (resolveModelSpec(options.model, config)) return; // already set (flag > FASTAGENT_MODEL > config)
  if (options.input === false) return; // --no-input: never prompt (clig) — the opener raises the clear error
  if (!isInteractive()) return; // CI/deploy: the opener throws the actionable missing-model error

  const authPath = resolveAuthPath(workspaceDir, options.authPath);
  const models = createPiModels({ authPath });
  let statuses: Awaited<ReturnType<typeof providerAuthStatuses>>;
  try {
    statuses = await providerAuthStatuses(models);
  } catch (error) {
    // Per-provider auth throws are captured as `broken` INSIDE providerAuthStatuses; reaching here
    // means the enumeration itself failed (getProviders / a provider with no probe-able surface) — a
    // system fault. Surface it; the opener then still raises the clear missing-model error.
    log.warn(`[fastagent] could not probe provider auth: ${(error as Error).message}`);
    return;
  }
  const r = await autocomplete({
    message: "Choose a model for this agent",
    options: buildModelPickerOptions(listModels(models), statuses),
  });
  if (isCancel(r)) return; // cancelled: let the opener report the missing model
  const chosen = r as string;
  const provider = providerOf(chosen);
  const status = statuses.get(provider);
  if (status && status.state !== "ready" && status.login === "none") {
    // No login flow exists for this provider — the model choice is still valid (its validity is
    // independent of credentials), so KEEP it and name the remedy. The remedy depends on WHY it is
    // not ready: a BROKEN stored credential still owns the provider (env is consulted only when
    // nothing is stored — createPiModels), so "set the env var" would not help there.
    if (status.state === "broken") {
      log.warn(
        `[fastagent] stored auth for "${provider}" is unusable: ${status.message} — fix or remove it in ${authPath}; invokes fail until then`,
      );
    } else {
      log.warn(`[fastagent] "${provider}" has no interactive login — set its API key env var; invokes fail until then`);
    }
  } else if (status?.state !== "ready") {
    // Inline login. Same leak guard as `login`: self-ignore the state root BEFORE a credential
    // can land in-tree, so the secret is never untracked-but-committable.
    const stateRoot = resolveStateRoot(workspaceDir);
    if (isUnderDir(authPath, stateRoot)) await ensureStateRootSelfIgnored(workspaceDir, stateRoot);
    try {
      // Verified against the CHOSEN model — the exact request the agent is about to make; a rejected
      // key re-prompts inside the loop, so reaching here means a usable (or at worst unverifiable) key.
      await loginWithKeyCheck(provider, authPath, chosen);
      console.error(`[fastagent] logged in to ${provider} — saved to ${authPath}`);
    } catch (error) {
      if (error instanceof LoginCancelled) return; // user backed out — discard the choice, like a picker cancel
      // A FAILED login keeps the choice (same policy as the env-only branch above: model validity is
      // independent of credentials) — the pick persists, the startup auth report names the remedy,
      // and a later `fastagent login` fixes auth without re-picking the model.
      log.warn(
        `[fastagent] login for "${provider}" failed: ${(error as Error).message} — model saved; run \`fastagent login\` to fix auth`,
      );
    }
  }
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  await persistModelChoice(workspaceDir, configPath, chosen);
}

/**
 * Interactive login with the api_key quick-fail probe closed into a LOOP: a definitively rejected key
 * (HTTP 401) deletes the bad credential and RE-PROMPTS immediately — the user's hands are on the
 * keyboard NOW; parking the failure for a later `fastagent login` would waste that. The loop exits on
 * a verified/unverifiable key (kept), an OAuth login (completing the flow already proved the
 * credential), or cancel (LoginCancelled propagates to the caller's cancel policy). Used by both the
 * `login` command and the first-run picker's inline login.
 */
export async function loginWithKeyCheck(
  provider: string | undefined,
  authPath: string,
  spec?: string,
  // Test seams: this loop DESTROYS credential state on `rejected`, so its policy (rejected → delete →
  // re-ask ONLY the key) is pinned by a test through fake flow/verify; production callers omit both.
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

/**
 * Quick-fail check after an api_key login (OAuth needs none — completing the flow already proved the
 * credential): probe the stored key with one minimal request against `spec`, or the provider's first
 * model. Policy over {@link probeApiKey}'s verdict: `rejected` (definitive HTTP 401) DELETES the
 * just-stored credential — a mistyped key must not persist as plausible state — and the caller
 * ({@link loginWithKeyCheck}) re-prompts; `unknown` (network, quota, permissions) keeps it and prints
 * the provider's message: the key may still be right, and wrongly destroying a good credential costs
 * more than keeping a doubtful one.
 */
async function verifyApiKeyLogin(
  provider: string,
  authPath: string,
  spec?: string,
): Promise<"ok" | "rejected" | "unknown"> {
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

/** Login terminal IO via @clack/prompts: a searchable list once long, a hidden prompt for keys. Shared
 *  by the `login` command and the first-run picker's inline login. */
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

/**
 * Best-effort persist the picked model so the next run does not prompt. Rewrites the commented
 * `model:` placeholder the scaffold writes / an existing `model:` line, or re-inserts the line into a
 * scaffold-shaped config (the hand-deleted-to-reset case); anything else (zero-config, a hand-shaped
 * config) is left untouched with a printed hint. Never throws — persistence is a convenience.
 */
async function persistModelChoice(workspaceDir: string, configPath: string | undefined, spec: string): Promise<void> {
  const hint = (): void =>
    console.error(
      `[fastagent] using ${spec} for this run; set \`model: ${JSON.stringify(spec)}\` in your config to persist`,
    );
  if (!configPath) return hint();
  try {
    const replaced = rewriteConfigModel(await readFile(configPath, "utf8"), spec);
    if (!replaced) return hint();
    await writeFile(configPath, replaced);
    console.error(`[fastagent] saved model ${JSON.stringify(spec)} to ${relative(workspaceDir, configPath)}`);
  } catch {
    hint();
  }
}
