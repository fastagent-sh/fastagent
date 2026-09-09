/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to assemble + serve,
 * restarting it on agent edits.
 */
import { runDevSupervisor } from "../../dev-supervisor.ts";
import { setLogLevel } from "../../log.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { mountAgentService } from "../../service.ts";
import { logAgentLoop } from "../../observe.ts";
import type { ResolvedPlacement } from "../../paths.ts";
import { failStartup } from "../fail.ts";
import { assertTunnelBindable, cliMountOptions, resolveBindHost, serveService } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

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
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  const isWorker = process.env.FASTAGENT_DEV_WORKER === "1";
  // The model is picked ONCE, in the parent process (a TTY; watch and --no-watch both).
  const placement = await enterAgentCommand(dirArg, { ...opts, input: isWorker ? false : opts.input });
  if (isWorker || opts.watch === false) {
    await serveOnce(placement, opts);
    return;
  }
  parsePort(opts.port, "--port", "flag"); // flag-shape checks before spawning
  // The --bind/--tunnel conflict is decidable from flags alone: refuse it HERE, before a worker and a tunnel exist.
  assertTunnelBindable(parseBind(opts.bind), opts.tunnel ?? false, "flag");
  await runDevSupervisor(placement, { tunnel: opts.tunnel ?? false });
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(placement: ResolvedPlacement, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  const tunnel = opts.tunnel ?? false;
  const a = await createPiAgentFromDir(placement.workspace, {
    model: opts.model,
    authPath: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by the opener (one owner)
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);
  // The same report `start` prints; `config:` is dev's own extra (see reportAssembly on the asymmetry).
  await reportAssembly(a, { beforeModel: [["config", a.configPath ?? "(none)"]] });
  const host = resolveBindHost(bindFlag, a.config.http?.host, tunnel);
  // The SAME assembly an embedder gets from `createAgentService` — channels, control plane, schedules, long
  // connections.
  const service = await mountAgentService(a, cliMountOptions(logAgentLoop)).catch(failStartup);
  serveService(
    service,
    { port: portFlag ?? a.config.http?.port ?? 8787, host },
    { tunnel, agentDir: a.agentDir, stateRoot: a.stateRoot },
  );
}
