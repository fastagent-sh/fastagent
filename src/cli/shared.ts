/**
 * Helpers shared across command modules: interactivity gates, port parsing, the startup auth report,
 * and first-run model resolution. Bodies moved verbatim from cli.ts; the module-scoped flag access
 * (`values.*`) became parameters.
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { autocomplete, isCancel, select } from "@clack/prompts";
import { fastagentCredentialStore } from "../engines/pi/auth.ts";
import {
  isValidPort,
  loadConfig,
  resolveAuthPath,
  resolveModelSpec,
  rewriteConfigModel,
} from "../engines/pi/config.ts";
import { configuredModelSpecs, createPiModels, probeAuthSource } from "../engines/pi/models.ts";
import { formatAuthReport } from "../cli-auth.ts";
import { log } from "../log.ts";
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
  const provider = modelSpec.slice(0, modelSpec.indexOf("/"));
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
 * First-run model resolution for the serving commands. When no model is set (flag/env/config), and
 * we're on a TTY, pick one from the providers the user is logged into and persist the choice. A no-op
 * when a model is already set; on a non-TTY (CI/deploy), or with `--no-input`, or with nothing
 * configured it stays silent and lets the opener raise its clear "missing model" error. The pick is
 * exported to FASTAGENT_MODEL so a spawned `dev` worker inherits it, and best-effort written back to
 * the config so the next run is quiet.
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
  let specs: string[];
  try {
    specs = await configuredModelSpecs(createPiModels({ authPath }));
  } catch (error) {
    // Enumerating providers/auth threw — a system fault (a corrupt auth store, a throwing provider),
    // NOT "not logged in". Surface it instead of masking it as the login hint; the opener then still
    // raises the clear missing-model error.
    log.warn(`[fastagent] could not list configured models: ${(error as Error).message}`);
    return;
  }
  if (specs.length === 0) {
    log.warn(
      `[fastagent] no model set and no authenticated provider — run \`fastagent login\`, then \`fastagent dev\``,
    );
    return;
  }
  const r = await (specs.length > 7 ? autocomplete : select)({
    message: "Choose a model for this agent",
    options: specs.map((s) => ({ value: s, label: s })),
  });
  if (isCancel(r)) return; // cancelled: let the opener report the missing model
  const chosen = r as string;
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  await persistModelChoice(workspaceDir, configPath, chosen);
}

/**
 * Best-effort persist the picked model so the next run does not prompt. Only rewrites the commented
 * `model:` placeholder the scaffold writes (or an existing `model:` line); anything else (zero-config,
 * a hand-shaped config) is left untouched with a printed hint. Never throws — persistence is a convenience.
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
