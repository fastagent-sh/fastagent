/** `fastagent info [dir] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { inspectChannels } from "../../channels/discover.ts";
import {
  loadConfig,
  resolveAuthFallback,
  resolveAuthPath,
  resolveModel,
  resolveModelSpec,
} from "../../engines/pi/config.ts";
import { createPiModelRuntime } from "../../engines/pi/models.ts";
import { resolveSessionsDir, resolveStateRoot, workspaceHint } from "../../paths.ts";
import { CODING_TOOL_NAMES, resolveAgentTools } from "../../engines/pi/create.ts";
import { loadAgentDefinition } from "../../engines/pi/definition.ts";
import { reportFindingsIfChanged, reportToolCollisions } from "../../engines/pi/report.ts";
import { type DeclaredSecret, allSecrets, describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { log } from "../../log.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { readMachine, withMachine } from "../../engines/pi/machine.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadRoutines } from "../../schedule/discover.ts";
import { failStartup, placementOrExit } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const dir = resolve(dirArg);
  const { agentDir, workspace } = placementOrExit(dir);
  enterAgentEnv(agentDir); // skills/tools may read env — and fetch — at load time
  const { config, path: configPath } = await loadConfig(agentDir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // agentDir = where the agent lives (definition + config + machinery); workspace = what it works ON (its cwd, whose
  // AGENTS.md ancestors are ② context).
  const definition = await loadAgentDefinition(agentDir, { cwd: workspace }).catch(failStartup);
  // What this agent HAS: the definition's skills plus the ones its machine lends (machine.ts).
  const skills = withMachine(definition.skills, (await readMachine(workspace)).skills);
  // A tool that fails to load, for any reason (a missing dep, a top-level throw, or just not being a tool), is
  // isolated the same way everywhere (G2).
  const tools = await resolveAgentTools(config, agentDir, workspace)
    .then((r) => ({
      names: r.toolNames,
      deferred: r.deferredToolNames,
      collisions: r.toolCollisions,
      failures: r.toolFailures,
      secrets: allSecrets(r.toolSecrets),
      error: undefined as string | undefined,
    }))
    .catch((e: unknown) => ({
      names: [] as string[],
      deferred: [] as string[],
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
  const sched = await loadRoutines(agentDir).catch(failStartup);
  // What the definition DECLARED it needs, and which of those have no value here. `info` reports
  // (never asserts): it is the read-only view of the same list `dev`/`start` refuse to boot without
  // and `deploy` requires a value for.
  const declaredSecrets: DeclaredSecret[] = [
    ...tools.secrets,
    ...allSecrets(sched.secrets),
    ...allSecrets(inspected.secrets),
  ];
  const unsetSecrets = missingSecrets(declaredSecrets);
  const routines = sched.routines.map((r) => ({
    name: r.name,
    cron: r.cron ?? null,
    tz: r.tz ?? null,
    // A routine with no cron has no next fire — it is reached by name (`POST /run`, `routine run`), which is a
    // fact worth printing rather than a null to squint at.
    next: r.cron === undefined ? null : (nextRun(r.cron, r.tz, new Date())?.toISOString() ?? null),
  }));
  // The default sessions/auth paths WITHOUT creating anything (info is read-only; dev/start mkdir/login create them,
  // info must not).
  const stateRoot = resolveStateRoot(agentDir);
  const sessionsDir = resolveSessionsDir(agentDir);
  const authPath = resolveAuthPath(agentDir); // FASTAGENT_AUTH_PATH > default — the one owner
  // The second layer this agent reads through: "what is this agent's state" is the question `info` answers, and a
  // credential it runs on can live in a file the agent dir does not contain.
  const fallbackAuthPath = resolveAuthFallback();

  // RESOLVE the spec, do not just echo it: a spec is only real once its provider/model exist in the agent's own
  // surface (built-ins + its models.json), which is exactly what a custom endpoint changes.
  const modelError = modelSpec
    ? await createPiModelRuntime({
        agentDir,
        authPath,
        ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
      })
        .then((models) => {
          resolveModel(models, modelSpec);
          return undefined as string | undefined;
        })
        .catch((error: unknown) => (error as Error).message)
    : undefined;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          workspace,
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          codingTools: [...CODING_TOOL_NAMES],
          context: definition.contextFiles.map((f) => f.path),
          persona: definition.persona !== undefined,
          skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
          tools: tools.names,
          deferredTools: tools.deferred,
          toolError: tools.error ?? null,
          channels,
          routines,
          routineFailures: sched.failures,
          channelFailures: inspected.failures,
          stateRoot,
          sessionsDir,
          authPath,
          fallbackAuthPath: fallbackAuthPath ?? null,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
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
  // One padded label writer: hand-spaced labels drifted out of alignment the moment a longer one
  // (agent/workspace) joined the report.
  const line = (label: string, value: string): void => console.log(`${`${label}:`.padEnd(13)} ${value}`);
  /** A continuation under the previous line, aligned to the same column (no label, so no bare colon). */
  const cont = (value: string): void => console.log(`${"".padEnd(13)} ${value}`);
  line("agent", agentDir);
  line("workspace", workspace);
  const hint = workspaceHint({ agentDir, workspace });
  if (hint) line("hint", hint);
  line("config", configPath ?? "(none)");
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or config.model)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  line("codingTools", CODING_TOOL_NAMES.join(", "));
  line("context", definition.contextFiles.map((f) => f.path).join(", ") || "(none)");
  line("persona", definition.persona ? "persona.md" : "(none)");
  line("skills", skills.map((skill) => skill.name).join(", ") || "(none)");
  line("tools", tools.error ? "(could not load — see warning below)" : tools.names.join(", ") || "(none)");
  if (tools.deferred.length > 0) line("deferred", `${tools.deferred.join(", ")} (activated via search_tools)`);
  line("channels", channels.join(", ") || "(none)");
  line(
    "routines",
    routines.map((r) => `${r.name} (${r.cron === null ? "on demand" : `next ${r.next ?? "never"}`})`).join(", ") ||
      "(none)",
  );
  line("secrets", declaredSecrets.length > 0 ? describeSecrets(declaredSecrets) : "(none declared)");
  if (unsetSecrets.length > 0)
    cont(`⚠ dev/start refuse to boot until set: ${unsetSecrets.map((s) => s.name).join(", ")}`);
  line("state", stateRoot);
  line("sessions", sessionsDir);
  line("auth", fallbackAuthPath === undefined ? authPath : `${authPath} (then ${fallbackAuthPath})`);
  reportToolCollisions(tools.collisions);
  reportModuleLoadFailures(tools.failures);
  reportModuleLoadFailures(sched.failures);
  reportModuleLoadFailures(inspected.failures);
  if (tools.error) log.warn(`[fastagent] ${tools.error}`);
  reportFindingsIfChanged(definition.dir, definition);
}
