/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to
 * assemble + serve, restarting it on agent edits. A fresh process per reload means what is served
 * is always the latest code, including modules a tool/config imports.
 */
import { resolve } from "node:path";
import { runDevSupervisor } from "../../dev-supervisor.ts";
import { loadDotEnv } from "../../env.ts";

import { reportFindingsIfChanged, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { setLogLevel } from "../../log.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { workspaceHint } from "../../paths.ts";
import { bindAddress } from "../../bind.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { assertTunnelBindable, maybeTunnel, mountSessionControl, routesFor, serve, startSchedules } from "../serve.ts";
import { parseBind, parsePort, reportAuth, reportLine, resolveFirstRunModel, reportWorkspaceHint } from "../shared.ts";

export interface DevOptions {
  port?: string;
  bind?: string;
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
  const placement = placementOrExit(dir);
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  const isWorker = process.env.FASTAGENT_DEV_WORKER === "1";
  // Pick a model interactively once, in the parent (both watch and --no-watch have a TTY); a spawned
  // watch worker inherits the choice via FASTAGENT_MODEL, so it must not prompt again. Load .env and
  // the proxy FIRST (as invoke/start do): the picker reads FASTAGENT_MODEL and provider keys from
  // .env, and getAuth's OAuth refresh must go through HTTPS_PROXY. The worker re-loads both in serveOnce.
  if (!isWorker) {
    loadDotEnv(placement.agentDir);
    installProxyFetch();
    await resolveFirstRunModel(placement.agentDir, opts);
  }
  if (isWorker || opts.watch === false) {
    await serveOnce(dir, opts);
    return;
  }
  parsePort(opts.port, "--port", "flag"); // flag-shape checks before spawning
  // The --bind/--tunnel conflict is decidable from flags alone: refuse it HERE, before a worker and a
  // tunnel exist. The worker repeats the check because `http.host` can supply the address instead.
  assertTunnelBindable(parseBind(opts.bind), opts.tunnel ?? false, "flag");
  await runDevSupervisor(placement, { tunnel: opts.tunnel ?? false });
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(dir: string, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  loadDotEnv(placementOrExit(dir).agentDir);
  installProxyFetch();

  const a = await createPiAgentFromDir(dir, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);
  reportLine("agent", a.agentDir);
  reportLine("workspace", a.workspace);
  reportWorkspaceHint(workspaceHint(a));
  reportLine("config", a.configPath ?? "(none)");
  reportLine("model", `${a.modelSpec}${a.config.thinkingLevel ? ` (thinking: ${a.config.thinkingLevel})` : ""}`);
  await reportAuth(a.modelSpec, a.authPath);
  reportAgentsSkillsTools(a);
  // Trace each turn's agent loop (tool calls + reply) to the log at debug level — shown in dev, gated
  // out in start (level info), keeping end-user content out of production logs. Wired in both postures.
  const traced = logAgentLoop(a.agent);
  const routed = await routesFor(a.agentDir, traced, a.stateRoot, a.sessionControl).catch(failStartup);
  // `http.host` enters here the way the flag enters `parseBind` — through `bindAddress`, so a
  // configured `localhost` is an ADDRESS by the time anything binds, renders or dials it.
  const configured = a.config.http?.host;
  const host = bindFlag ?? (configured === undefined ? undefined : bindAddress(configured));
  assertTunnelBindable(host, opts.tunnel ?? false, bindFlag ? "flag" : "config");
  const withControl = mountSessionControl(routed.routes, a.sessionControl, a.stateRoot, {
    tunnel: opts.tunnel ?? false,
    agent: traced, // the remote data plane (POST /control/invoke) drives the SAME traced agent
    host,
  });
  await startSchedules(a.agentDir, traced, a.stateRoot, a.config.selfSchedule ?? false);
  serve({ ...routed, routes: withControl.routes }, { port: portFlag ?? a.config.http?.port ?? 8787, host }, (p) => {
    withControl.announce(p);
    maybeTunnel(a.agentDir, routed.routeChannels, p, opts.tunnel ?? false, a.stateRoot);
  });
}

type Assembled = Awaited<ReturnType<typeof createPiAgentFromDir>>;

/** The agents/skills/tools/collisions report lines. */
function reportAgentsSkillsTools(a: Assembled): void {
  reportLine("context", a.definition.contextFiles.map((f) => f.path).join(", ") || "(none)");
  if (a.definition.persona) reportLine("persona", "persona.md");
  reportLine("skills", a.definition.skills.map((s) => s.name).join(", ") || "(none)");
  if (a.toolNames.length > 0) reportLine("tools", a.toolNames.join(", "));
  if (a.deferredToolNames.length > 0) {
    reportLine("deferred", `${a.deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(a.toolCollisions);
  reportModuleLoadFailures(a.toolFailures);
  reportFindingsIfChanged(a.definition.dir, a.definition);
}
