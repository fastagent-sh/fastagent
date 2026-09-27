/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to assemble + serve,
 * restarting it on agent edits.
 */
import { runDevSupervisor } from "../../dev-supervisor.ts";
import { setLogLevel } from "../../log.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { DEFAULT_HTTP_PORT, mountAgentService } from "../../service.ts";
import { logAgentLoop } from "../../observe.ts";
import type { ResolvedPlacement } from "../../paths.ts";
import { failStartup } from "../fail.ts";
import { assertTunnelBindable, cliMountOptions, serveService, withRunOverrides } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

/**
 * `dev` binds loopback unless `--bind` says otherwise: a dev serve carries the agent's full tool authority and lands on
 * networks its author does not own. `--bind 0.0.0.0` gives back the reach a container or a phone needs.
 */
const DEV_BIND = "127.0.0.1";

export interface DevOptions {
  port?: string;
  bind?: string;
  model?: string;
  /** false ⇔ `--no-watch`. */
  watch?: boolean;
  tunnel?: boolean;
  /** false ⇔ `--no-invoke`: withhold `POST /invoke` for THIS run (`http.invoke` is the persistent form). */
  invoke?: boolean;
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
  assertTunnelBindable(parseBind(opts.bind), opts.tunnel ?? false);
  await runDevSupervisor(placement, { tunnel: opts.tunnel ?? false });
}

/** Assemble the agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(placement: ResolvedPlacement, opts: DevOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const host = parseBind(opts.bind) ?? DEV_BIND;
  const tunnel = opts.tunnel ?? false;
  assertTunnelBindable(host, tunnel);
  const a = await createPiAgentFromDir(placement.agentDir, {
    model: opts.model,
    serving: true, // long-running serve: the scheduler poller runs (and the wake tool is mounted)
  }).catch(failStartup);
  // The same report `start` prints; `config:` is dev's own extra (see reportAssembly on the asymmetry).
  await reportAssembly(a, { beforeModel: [["config", a.configPath ?? "(none)"]] });
  // The SAME assembly an embedder gets from `createAgentService` — channels, control plane, schedules, long
  // connections.
  const service = await mountAgentService(withRunOverrides(a, opts), cliMountOptions(logAgentLoop)).catch(failStartup);
  serveService(
    service,
    { port: portFlag ?? a.config.http?.port ?? DEFAULT_HTTP_PORT, host },
    { tunnel, agentDir: a.agentDir, stateRoot: a.stateRoot },
  );
}
