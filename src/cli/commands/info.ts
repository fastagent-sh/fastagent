/** `fastagent info [dir] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. Read-only. */
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { discoverChannelFiles } from "../../engines/pi/channel.ts";
import {
  defaultAuthPath,
  defaultSessionsDir,
  loadConfig,
  resolveAgentDir,
  resolveAuthPathOverride,
  resolveModelSpec,
  resolveSessionsDirOverride,
  resolveStateRoot,
} from "../../engines/pi/config.ts";
import { resolveWorkspaceTools } from "../../engines/pi/create.ts";
import { loadAgentDefinition } from "../../engines/pi/definition.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { log } from "../../log.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { failStartup } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
  authPath?: string;
  sessionsDir?: string;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const dir = resolve(dirArg);
  loadDotEnv(dir); // skills/tools may read env at load time
  const { config, path: configPath } = await loadConfig(dir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // dir = the run root (cwd, whose AGENTS.md is ② context); the agent's own surface lives in agentDir.
  const agentDir = resolveAgentDir(dir, config);
  const definition = await loadAgentDefinition(agentDir, { cwd: dir }).catch(failStartup);
  // A tool that fails to load, for any reason (a missing dep, a top-level throw, or just not being a
  // tool), is isolated the same way everywhere (G2): info, dev, AND start report it and keep going with
  // the tools that loaded. The `error`/`.catch` below only fires for a whole-load fault (an unreadable
  // tools/ dir), not a single bad file.
  const tools = await resolveWorkspaceTools(config, agentDir, dir)
    .then((r) => ({
      names: r.toolNames,
      deferred: r.deferredToolNames,
      collisions: r.toolCollisions,
      failures: r.toolFailures,
      error: undefined as string | undefined,
    }))
    .catch((e: unknown) => ({
      names: [] as string[],
      deferred: [] as string[],
      collisions: [],
      failures: [],
      error: (e as Error).message,
    }));
  const channels = await discoverChannelFiles(agentDir).catch(failStartup);
  // Loaded (imported + validated), not just discovered: info's job is "fix only what it reports", so a
  // broken schedule file (bad cron/tz, failed import) must show up HERE, not first at dev/start — and
  // loading is what makes the next fire instant printable. Consistent with tools (info imports those too).
  const sched = await loadSchedules(agentDir).catch(failStartup);
  const schedules = sched.schedules.map((s) => ({
    name: s.name,
    cron: s.cron,
    tz: s.tz ?? null,
    next: nextRun(s.cron, s.tz, new Date())?.toISOString() ?? null,
  }));
  // The default sessions/auth paths WITHOUT creating anything (info is read-only; dev/start mkdir/login
  // create them, info must not).
  const stateRoot = resolveStateRoot(dir);
  const sessionsDir = resolveSessionsDirOverride(opts.sessionsDir) ?? defaultSessionsDir(stateRoot);
  const authPath = resolveAuthPathOverride(opts.authPath) ?? defaultAuthPath(stateRoot);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          dir,
          agentDir,
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          context: definition.contextFiles.map((f) => f.path),
          persona: definition.persona !== undefined,
          skills: definition.skills.map((skill) => ({ name: skill.name, description: skill.description })),
          tools: tools.names,
          deferredTools: tools.deferred,
          toolError: tools.error ?? null,
          channels,
          schedules,
          scheduleFailures: sched.failures,
          selfSchedule: config.selfSchedule ?? false,
          stateRoot,
          sessionsDir,
          authPath,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
          toolCollisions: tools.collisions,
          toolFailures: tools.failures,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`dir:      ${dir}`);
  if (agentDir !== dir) console.log(`agent:    ${agentDir}`);
  console.log(`config:   ${configPath ?? "(none)"}`);
  console.log(`model:    ${modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or config.model)"}`);
  if (config.thinkingLevel) console.log(`thinking: ${config.thinkingLevel}`);
  console.log(`context:  ${definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  console.log(`persona:  ${definition.persona ? "persona.md" : "(none)"}`);
  console.log(`skills:   ${definition.skills.map((skill) => skill.name).join(", ") || "(none)"}`);
  console.log(`tools:    ${tools.error ? "(could not load — see warning below)" : tools.names.join(", ") || "(none)"}`);
  if (tools.deferred.length > 0) console.log(`deferred: ${tools.deferred.join(", ")} (activated via search_tools)`);
  console.log(`channels: ${channels.join(", ") || "(none)"}`);
  console.log(`schedules: ${schedules.map((s) => `${s.name} (next ${s.next ?? "never"})`).join(", ") || "(none)"}`);
  console.log(`selfSchedule: ${config.selfSchedule ? "on (mounts the wake tool when serving)" : "off"}`);
  console.log(`state:    ${stateRoot}`);
  console.log(`sessions: ${sessionsDir}`);
  console.log(`auth:     ${authPath}`);
  reportToolCollisions(tools.collisions);
  reportModuleLoadFailures(tools.failures);
  reportModuleLoadFailures(sched.failures);
  if (tools.error) log.warn(`[fastagent] ${tools.error}`);
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
}
