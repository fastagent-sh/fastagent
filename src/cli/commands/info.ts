/** `fastagent info [agent] [--json]`: print what the directory builds into, WITHOUT opening or serving the agent. */
import { resolve } from "node:path";
import { channelIngress } from "../../channels/discover.ts";
import type { BoundContent } from "../../content/declare.ts";
import { loadContent, loadEnvironment } from "../../content/file.ts";
import { type ResolvedContent, contentAbsentHere, resolveContent } from "../../content/resolve.ts";
import { describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { enterAgentEnv } from "../../env.ts";
import type { DeclaredEnvironment } from "../../environment/declare.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { buildDefinition, modelSpecFor, prepareDefinition, secretsManifest } from "../../harnesses/pi-durable/open.ts";
import { readCommands } from "../../harnesses/pi-durable/text.ts";
import { resolveStateRoot } from "../../paths.ts";
import { nextRun } from "../../schedule/cron.ts";
import { contentLines } from "../content-view.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir); // code may read its secrets, and fetch, when it is built
  const definition = await prepareDefinition(agentDir).catch(failStartup);
  const { config } = definition;
  const modelSpec = modelSpecFor(config, opts.model);
  const manifest = secretsManifest(definition);
  const declared = manifest.flatMap(({ name, optional, declaredIn }) =>
    declaredIn.map((source) => ({ name, optional, source })),
  );
  const unsetSecrets = missingSecrets(declared);
  // Built only when every required secret has a value: building is what reads them.
  const code = unsetSecrets.length === 0 ? buildDefinition(definition) : undefined;
  // Reported, not fatal: `info` is how an author finds out a content entry is missing, or the environment refused.
  let content: ResolvedContent[] = [];
  let contentAbsent: BoundContent[] = [];
  let contentError: string | undefined;
  try {
    const declaration = loadContent(agentDir);
    content = resolveContent(agentDir, declaration);
    contentAbsent = contentAbsentHere(declaration);
  } catch (error) {
    contentError = (error as Error).message;
  }
  let environment: DeclaredEnvironment | undefined;
  let environmentError: string | undefined;
  try {
    environment = loadEnvironment(agentDir);
  } catch (error) {
    environmentError = (error as Error).message;
  }
  const models = modelEnvironment(agentDir, {}, code?.providers ?? []);
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

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          name: definition.name,
          content,
          contentAbsent,
          contentError: contentError ?? null,
          environment: environment ?? null,
          environmentError: environmentError ?? null,
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          tools: code?.tools.map(({ name }) => name) ?? null,
          extensions: code?.extensions.map(({ name }) => name) ?? null,
          channels: code === undefined ? null : channels,
          schedules: code === undefined ? null : schedules,
          commands,
          secrets: manifest,
          unsetSecrets: unsetSecrets.map(({ name }) => name),
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
  for (const [label, value] of contentLines(content, contentAbsent)) line(label, value);
  if (contentError) cont(`⚠ ${contentError}`);
  line(
    "environment",
    environmentError
      ? "(refused: dev and start stop on it)"
      : environment
        ? describeEnvironment(environment)
        : "(none: the machine's commands)",
  );
  if (environmentError) cont(`⚠ ${environmentError}`);
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or model in fastagent.config.ts)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  const unbuilt = "(not built: a required secret has no value)";
  line("tools", code ? code.tools.map(({ name }) => name).join(", ") || "(none)" : unbuilt);
  if (code && code.extensions.length > 0) line("extensions", code.extensions.map(({ name }) => name).join(", "));
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
  line("state", stateRoot);
  if (auth) line("auth", auth.fallback === undefined ? auth.path : `${auth.path} (then ${auth.fallback})`);
}

/** The packages and apt packages an environment declares, as one line. */
function describeEnvironment(environment: DeclaredEnvironment): string {
  const packages = Object.entries(environment.packages).map(([name, version]) => `${name} ${version}`);
  const apt = environment.aptPackages.map((name) => `apt:${name}`);
  return [...packages, ...apt].join(", ") || "(none: the machine's commands)";
}
