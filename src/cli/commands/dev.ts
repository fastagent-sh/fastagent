/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to
 * assemble + serve, restarting it on workspace edits. A fresh process per reload means what is served
 * is always the latest code, including modules a tool/config imports.
 */
import { resolve } from "node:path";
import { runDevSupervisor } from "../../dev-supervisor.ts";
import { loadDotEnv } from "../../env.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "../../engines/pi/workspace.ts";
import { log, setLogLevel } from "../../log.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup } from "../fail.ts";
import { maybeTunnel, mountSessionControl, routesFor, serve, startSchedules } from "../serve.ts";
import { parsePort, reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface DevOptions {
  port?: string;
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-watch`. */
  watch?: boolean;
  tunnel?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runDev(dirArg: string, opts: DevOptions): Promise<void> {
  const dir = resolve(dirArg);
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  const isWorker = process.env.FASTAGENT_DEV_WORKER === "1";
  // Pick a model interactively once, in the parent (both watch and --no-watch have a TTY); a spawned
  // watch worker inherits the choice via FASTAGENT_MODEL, so it must not prompt again. Load .env and
  // the proxy FIRST (as invoke/start do): the picker reads FASTAGENT_MODEL and provider keys from
  // .env, and getAuth's OAuth refresh must go through HTTPS_PROXY. The worker re-loads both in serveOnce.
  if (!isWorker) {
    loadDotEnv(dir);
    installProxyFetch();
    await resolveFirstRunModel(dir, opts);
  }
  if (isWorker || opts.watch === false) {
    await serveOnce(dir, opts);
    return;
  }
  parsePort(opts.port, "--port", "flag"); // flag-shape check before spawning
  await runDevSupervisor(dir, { tunnel: opts.tunnel ?? false });
}

/** Assemble the workspace agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(dir: string, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  loadDotEnv(dir);
  installProxyFetch();

  const a = await createPiAgentFromWorkspace(dir, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);
  log.info(`[fastagent] dir:    ${dir}`);
  if (a.agentDir !== dir) log.info(`[fastagent] agent:  ${a.agentDir}`);
  log.info(`[fastagent] config: ${a.configPath ?? "(zero-config)"}`);
  log.info(
    `[fastagent] model:  ${a.modelSpec}${a.config.thinkingLevel ? ` (thinking: ${a.config.thinkingLevel})` : ""}`,
  );
  await reportAuth(a.modelSpec, a.authPath);
  reportAgentsSkillsTools(a);
  // Trace each turn's agent loop (tool calls + reply) to the log at debug level — shown in dev, gated
  // out in start (level info), keeping end-user content out of production logs. Wired in both postures.
  const traced = logAgentLoop(a.agent);
  const routed = await routesFor(a.agentDir, traced, a.stateRoot).catch(failStartup);
  const withControl = mountSessionControl(routed.routes, a.sessionControl, a.stateRoot);
  await startSchedules(a.agentDir, traced, a.stateRoot, a.config.selfSchedule ?? false);
  serve({ ...routed, routes: withControl.routes }, portFlag ?? a.config.http?.port ?? 8787, (p) => {
    withControl.announce(p);
    maybeTunnel(a.agentDir, p, opts.tunnel ?? false);
  });
}

type Assembled = Awaited<ReturnType<typeof createPiAgentFromWorkspace>>;

/** The agents/skills/tools/collisions report lines. */
function reportAgentsSkillsTools(a: Assembled): void {
  log.info(`[fastagent] context: ${a.definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  if (a.definition.persona) log.info(`[fastagent] persona: persona.md`);
  log.info(`[fastagent] skills: ${a.definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (a.toolNames.length > 0) log.info(`[fastagent] tools:  ${a.toolNames.join(", ")}`);
  if (a.deferredToolNames.length > 0) {
    log.info(`[fastagent] deferred: ${a.deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(a.toolCollisions);
  reportModuleLoadFailures(a.toolFailures);
  reportDefinitionWarnings(a.definition.collisions, a.definition.diagnostics);
}
