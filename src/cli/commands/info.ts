/** `fastagent info [agent] [--json]`: print what the directory builds into, WITHOUT opening or serving the agent. */
import { definedValues } from "../../declared-secrets.ts";
import { resolve } from "node:path";
import { channelIngress } from "../../channels/discover.ts";
import { loadContent, loadEnvironment } from "../../content/file.ts";
import { type ResolvedContent, resolveContent } from "../../content/resolve.ts";
import { describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { type InstanceFlags, enterInstance } from "../instance.ts";
import type { DeclaredEnvironment } from "../../environment/declare.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { type EffectiveConfig, configValue, resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { definitionSecrets } from "../../harnesses/pi-durable/definition.ts";
import { buildDefinition, loadDevProject, modelSpecFor } from "../../harnesses/pi-durable/open.ts";
import { readCommands } from "../../harnesses/pi-durable/text.ts";
import { inspectMcp } from "../../mcp/host.ts";
import { resolveStateRoot, resolveWorkdir } from "../../paths.ts";
import { nextRun } from "../../schedule/cron.ts";
import { contentLines } from "../content-view.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
  instance?: InstanceFlags;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterInstance(agentDir, opts.instance); // code may read its secrets, and fetch, when it is built
  const workdir = resolveWorkdir(agentDir);
  const { definition, instance } = await loadDevProject(agentDir).catch(failStartup);
  const config = (() => {
    try {
      return resolveConfig(definition, instance);
    } catch (error) {
      return failStartup(error);
    }
  })();
  const modelSpec = modelSpecFor(config, opts.model);
  const declared = definitionSecrets(definition, config);
  const unsetSecrets = missingSecrets(declared, process.env);
  // Built only when every required secret has a value: building is what reads them. A module that is not what its
  // directory holds is said as the refusal `dev` and `start` would stop on.
  const code =
    unsetSecrets.length === 0
      ? await Promise.resolve()
          .then(() => buildDefinition(definition, process.env, config))
          .catch(failStartup)
      : undefined;
  // Reported, not fatal: `info` is how an author finds out a content entry is missing, or the environment refused.
  let content: ResolvedContent[] = [];
  let contentError: string | undefined;
  try {
    content = resolveContent(loadContent(agentDir, instance), { dir: agentDir, workdir });
  } catch (error) {
    contentError = (error as Error).message;
  }
  // Read already, by the definition's secrets: a refused environment is a definition that does not open.
  const environment = loadEnvironment(agentDir);
  const models = await modelEnvironment(agentDir, {}, code?.providers ?? [], {
    environment: definedValues(process.env),
  });
  const slash = modelSpec?.indexOf("/") ?? -1;
  const modelError =
    modelSpec === undefined || models.models.getModel(modelSpec.slice(0, slash), modelSpec.slice(slash + 1))
      ? undefined
      : `no provider "${modelSpec.slice(0, Math.max(slash, 0))}" offers "${modelSpec.slice(slash + 1)}"`;
  const channels = [...(code?.channels ?? new Map())].map(([name, module]) => ({
    name,
    ingress: channelIngress(module),
  }));
  const schedules = (code?.schedules ?? []).map((s) => ({
    name: s.name,
    cron: s.cron,
    tz: s.tz ?? null,
    next: nextRun(s.cron, s.tz, new Date())?.toISOString() ?? null,
  }));
  const commands = readCommands(agentDir).map(({ name, description }) => ({ name, description: description ?? null }));
  const stateRoot = resolveStateRoot(agentDir);
  const auth = models.auth;
  const mcp = await inspectMcp(agentDir).catch(failStartup);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          name: definition.name,
          content,
          contentError: contentError ?? null,
          environment: environment ?? null,
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          config: configReport(config, opts.model),
          tools: code?.tools.map(({ name }) => name) ?? null,
          mcp,
          extensions: code?.extensions.map(({ name }) => name) ?? null,
          channels: code === undefined ? null : channels,
          schedules: code === undefined ? null : schedules,
          commands,
          secrets: definition.inputs.secrets,
          unsetSecrets: unsetSecrets.map(({ name }) => name),
          workdir,
          stateRoot,
          authPath: auth?.path ?? null,
          fallbackAuthPath: auth?.fallback ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const line = (label: string, value: string): void => console.log(`${`${label}:`.padEnd(13)} ${value}`);
  /** A continuation under the previous line, aligned to the same column (no label, so no bare colon). */
  const cont = (value: string): void => console.log(`${"".padEnd(13)} ${value}`);
  line("agent", `${definition.name} — ${agentDir}`);
  for (const [label, value] of contentLines(content)) line(label, value);
  if (contentError) cont(`⚠ ${contentError}`);
  line("environment", environment ? describeEnvironment(environment) : "(none: the machine's commands)");
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or defaults.model in fastagent.config.ts)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  const unbuilt = "(not built: a required secret has no value)";
  line("tools", code ? code.tools.map(({ name }) => name).join(", ") || "(none)" : unbuilt);
  if (code && code.extensions.length > 0) line("extensions", code.extensions.map(({ name }) => name).join(", "));
  line(
    "mcp",
    mcp.map((server) => `${server.name} (${server.transport}, ${server.authorization})`).join(", ") || "(none)",
  );
  line("channels", code ? channels.map((c) => `${c.name} (${c.ingress})`).join(", ") || "(none)" : unbuilt);
  line(
    "schedules",
    code ? schedules.map((s) => `${s.name} (next ${s.next ?? "never"})`).join(", ") || "(none)" : unbuilt,
  );
  line("commands", commands.map(({ name }) => `/${name}`).join(", ") || "(none)");
  line("secrets", declared.length > 0 ? describeSecrets(declared) : "(none declared)");
  if (unsetSecrets.length > 0) {
    cont(`⚠ dev, start and deployments refuse to boot until set: ${unsetSecrets.map((s) => s.name).join(", ")}`);
  }
  line("workdir", workdir);
  line("state", stateRoot);
  if (auth) line("auth", auth.fallback === undefined ? auth.path : `${auth.path} (then ${auth.fallback})`);
}

/**
 * Each value the configuration resolved, by its path, with where it is from: the program's defaults, the instance's
 * file, and for the model the flag or variable that overrides both.
 */
function configReport(
  config: EffectiveConfig,
  modelFlag: string | undefined,
): Record<string, { value: unknown; source: string }> {
  const report = Object.fromEntries(
    Object.entries(config.sources).map(([path, source]) => [path, { value: configValue(config, path), source }]),
  );
  const override = modelFlag !== undefined ? "--model" : process.env.FASTAGENT_MODEL ? "FASTAGENT_MODEL" : undefined;
  const model = modelSpecFor(config, modelFlag);
  if (override !== undefined && model !== undefined) report.model = { value: model, source: override };
  return report;
}

/** The packages and apt packages an environment declares, as one line. */
function describeEnvironment(environment: DeclaredEnvironment): string {
  const packages = Object.entries(environment.packages).map(([name, version]) => `${name} ${version}`);
  const apt = environment.aptPackages.map((name) => `apt:${name}`);
  return [...packages, ...apt].join(", ") || "(none: the machine's commands)";
}
