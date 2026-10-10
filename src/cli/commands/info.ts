/** `fastagent info [agent] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { inspectChannels } from "../../channels/discover.ts";
import { loadConfig, providerOf, resolveModel, resolveModelSpec } from "../../harnesses/pi/config.ts";
import { machineModels } from "../../harnesses/pi/models.ts";
import { agentModels } from "../../harnesses/pi/agent-models.ts";
import { resolveSessionsDir, resolveStateRoot } from "../../paths.ts";
import { CODING_TOOL_NAMES, type IndirectTool, resolveAgentTools } from "../../harnesses/pi/create.ts";
import { loadAgentDefinition } from "../../harnesses/pi/definition.ts";
import {
  describeIndirectTools,
  describeTools,
  describePrompt,
  reportFindingsIfChanged,
  reportToolCollisions,
} from "../../harnesses/pi/report.ts";
import { type DeclaredSecret, allSecrets, describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { log } from "../../log.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { readMachine, withMachine } from "../../harnesses/pi/machine.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";
import { contentLines } from "../content-view.ts";
import { type ResolvedContent, resolveContent } from "../../content/resolve.ts";
import { loadContent } from "../../content/file.ts";
import { type DeclaredEnvironment, readEnvironment } from "../../environment/declare.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir); // skills/tools may read env — and fetch — at load time
  const { config, path: configPath } = await loadConfig(agentDir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // Reported, not fatal, like a tool that does not load: `info` is how an author finds out a content entry is missing.
  let content: ResolvedContent[] = [];
  let contentError: string | undefined;
  try {
    content = resolveContent(agentDir, loadContent(agentDir));
  } catch (error) {
    contentError = (error as Error).message;
  }
  const definition = await loadAgentDefinition(agentDir, { content }).catch(failStartup);
  // Reported like content: `info` is how an author finds out mise.toml says what the agent does not support.
  let environment: DeclaredEnvironment | undefined;
  let environmentError: string | undefined;
  try {
    environment = readEnvironment(agentDir);
  } catch (error) {
    environmentError = (error as Error).message;
  }
  // What this agent HAS: the definition's skills and prompt templates plus the ones its machine lends (machine.ts).
  const machineResources = await readMachine(agentDir);
  const skills = withMachine(definition.skills, machineResources.skills);
  const prompts = withMachine(definition.prompts, machineResources.prompts);
  // A tool that fails to load, for any reason (a missing dep, a top-level throw, or just not being a tool), is
  // isolated the same way everywhere (G2).
  const tools = await resolveAgentTools(config, agentDir)
    .then((r) => ({
      names: r.toolNames,
      sources: r.toolSources,
      indirect: r.indirectTools,
      collisions: r.toolCollisions,
      failures: r.toolFailures,
      secrets: allSecrets(r.toolSecrets),
      error: undefined as string | undefined,
    }))
    .catch((e: unknown) => ({
      names: [] as string[],
      sources: new Map<string, string>(),
      indirect: [] as IndirectTool[],
      collisions: [],
      failures: [],
      secrets: [] as DeclaredSecret[],
      error: (e as Error).message,
    }));
  // IMPORTED, like tools and schedules: a channel's declared secrets are part of what this command
  // exists to report (and a channel that cannot load is what `dev` would fail on next).
  const inspected = await inspectChannels(agentDir).catch(failStartup);
  const channels = inspected.channels.map((c) => c.name);
  // Loaded (imported + validated), not just discovered.
  const sched = await loadSchedules(agentDir).catch(failStartup);
  // What the definition DECLARED it needs, and which of those have no value here. `info` reports
  // (never asserts) the list `start` refuses to boot without and `deploy` requires a value for: channels are
  // imported as `start` imports them, so a Feishu/Lark channel that `dev` connects by WebSocket shows the webhook
  // values a deployment needs, and the line says so.
  const declaredSecrets: DeclaredSecret[] = [...tools.secrets, ...allSecrets(inspected.secrets)];
  const unsetSecrets = missingSecrets(declaredSecrets);
  const schedules = sched.schedules.map((s) => ({
    name: s.name,
    cron: s.cron,
    tz: s.tz ?? null,
    next: nextRun(s.cron, s.tz, new Date())?.toISOString() ?? null,
  }));
  // The default sessions/auth paths WITHOUT creating anything (info is read-only; dev/start mkdir/login create them,
  // info must not).
  const stateRoot = resolveStateRoot(agentDir);
  const sessionsDir = resolveSessionsDir(agentDir);
  // Both layers: "what is this agent's state" is the question `info` answers, and a credential it runs on can live in
  // a file the agent dir does not contain.
  const models = agentModels(agentDir);
  const { auth } = models;

  // RESOLVE the spec, do not just echo it: a spec is only real once its provider/model exist in the agent's own
  // surface (built-ins + its models.json), which is exactly what a custom endpoint changes.
  const modelError = modelSpec
    ? await models
        .runtime()
        .then((runtime) => {
          resolveModel(runtime, modelSpec);
          return undefined as string | undefined;
        })
        .catch((error: unknown) => (error as Error).message)
    : undefined;

  // The machine's own endpoints, which this agent inherits unless its models.json declares the same provider.
  const machine = await machineModels(agentDir).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error: (error as Error).message }),
  );
  const modelFromMachine = modelSpec !== undefined && machine.value?.inherited.includes(providerOf(modelSpec)) === true;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          content,
          contentError: contentError ?? null,
          environment: environment ? { tools: environment.tools, packages: environment.packages } : null,
          environmentError: environmentError ?? null,
          contextFiles: definition.contextFiles.map((file) => file.path),
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          modelFromMachine,
          machineModels: machine.value ?? null,
          machineModelsError: machine.error ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          codingTools: [...CODING_TOOL_NAMES],
          systemPrompt: definition.systemPrompt?.path ?? null,
          appendSystemPrompt: definition.appendSystemPrompt?.path ?? null,
          skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
          prompts: prompts.map((prompt) => ({ name: prompt.name, description: prompt.description ?? null })),
          tools: tools.names,
          toolSources: Object.fromEntries(tools.sources),
          indirectTools: tools.indirect,
          toolError: tools.error ?? null,
          channels,
          schedules,
          scheduleFailures: sched.failures,
          channelFailures: inspected.failures,
          stateRoot,
          sessionsDir,
          authPath: auth.path,
          fallbackAuthPath: auth.fallback ?? null,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
          shadowed: definition.shadowed,
          ignored: definition.ignored,
          toolCollisions: tools.collisions,
          toolFailures: tools.failures,
          declaredSecrets,
          unsetSecrets,
        },
        null,
        2,
      ),
    );
    return;
  }
  // One padded label writer, so labels stay aligned.
  const line = (label: string, value: string): void => console.log(`${`${label}:`.padEnd(13)} ${value}`);
  /** A continuation under the previous line, aligned to the same column (no label, so no bare colon). */
  const cont = (value: string): void => console.log(`${"".padEnd(13)} ${value}`);
  line("agent", agentDir);
  for (const [label, value] of contentLines(content)) line(label, value);
  if (contentError) cont(`⚠ ${contentError}`);
  line("environment", environment ? describeEnvironment(environment) : "(none: the machine's commands)");
  if (environmentError) cont(`⚠ ${environmentError}`);
  line("config", configPath ?? "(none)");
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or config.model)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (modelFromMachine) cont(`endpoint from the machine's ${machine.value?.path} (does not ship with a deploy)`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  line("codingTools", CODING_TOOL_NAMES.join(", "));
  line("prompt", describePrompt(definition));
  line("skills", skills.map((skill) => skill.name).join(", ") || "(none)");
  line("prompts", prompts.map((prompt) => prompt.name).join(", ") || "(none)");
  line(
    "tools",
    tools.error ? "(could not load — see warning below)" : describeTools(tools.names, tools.sources) || "(none)",
  );
  if (tools.indirect.length > 0) line("indirect", describeIndirectTools(tools.indirect));
  line("channels", channels.join(", ") || "(none)");
  line("schedules", schedules.map((s) => `${s.name} (next ${s.next ?? "never"})`).join(", ") || "(none)");
  line("secrets", declaredSecrets.length > 0 ? describeSecrets(declaredSecrets) : "(none declared)");
  if (unsetSecrets.length > 0)
    cont(`⚠ start and deployments refuse to boot until set: ${unsetSecrets.map((s) => s.name).join(", ")}`);
  line("state", stateRoot);
  line("sessions", sessionsDir);
  line("auth", auth.fallback === undefined ? auth.path : `${auth.path} (then ${auth.fallback})`);
  if (machine.error) line("endpoints", `⚠ ${machine.error}`);
  else if (machine.value) {
    const { path, inherited, overridden } = machine.value;
    const parts = [inherited.join(", ") || "(none inherited)"];
    if (overridden.length > 0) parts.push(`overridden by the agent: ${overridden.join(", ")}`);
    line("endpoints", `${path}: ${parts.join("; ")}`);
  }
  reportToolCollisions(tools.collisions);
  reportModuleLoadFailures(tools.failures);
  reportModuleLoadFailures(sched.failures);
  reportModuleLoadFailures(inspected.failures);
  if (tools.error) log.warn(`[fastagent] ${tools.error}`);
  reportFindingsIfChanged(definition.dir, definition);
}

/** The tools and system packages an environment declares, as one line. */
function describeEnvironment(environment: DeclaredEnvironment): string {
  const tools = environment.tools.join(", ") || "(none)";
  return environment.packages.length > 0 ? `${tools}; system packages: ${environment.packages.join(", ")}` : tools;
}
