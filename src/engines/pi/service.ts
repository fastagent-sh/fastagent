/**
 * `createAgentService` — the product as one call, with pi supplying the engine.
 *
 * The ASSEMBLY is engine-neutral and lives in `src/service.ts`: it takes a {@link MountableAgent}
 * (the SPEC contract plus three paths) and knows nothing about how that agent was built. What is
 * pi-specific is opening a DIRECTORY into one, which is why this shortcut lives here and the
 * assembly does not. A second engine ships its own opener and reuses `mountAgentService` unchanged.
 */
import { type AgentService, type MountAgentServiceOptions, mountAgentService } from "../../service.ts";
import { createPiAgentFromDir } from "./open.ts";

export interface CreateAgentServiceOptions extends MountAgentServiceOptions {
  model?: string;
  authPath?: string;
  sessionsDir?: string;
}

/**
 * Open an agent directory as a live service: one handler, mounted wherever you serve.
 *
 * ```ts
 * const service = await createAgentService("./my-agent");
 * app.use("/agent", nodeListener(service.handler));
 * ```
 */
export async function createAgentService(dir: string, options: CreateAgentServiceOptions = {}): Promise<AgentService> {
  const opened = await createPiAgentFromDir(dir, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.authPath !== undefined ? { authPath: options.authPath } : {}),
    ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
    serving: true, // a mounted service is long-running: the scheduler poller runs
  });
  return mountAgentService(opened, options);
}
