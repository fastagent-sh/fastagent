/** `createAgentService` — the product as one call, with pi supplying the engine. */
import { type AgentService, type MountAgentServiceOptions, mountAgentService } from "../../service.ts";
import { createPiAgentFromDir } from "./open.ts";

export interface CreateAgentServiceOptions extends MountAgentServiceOptions {
  model?: string;
  authPath?: string;
  sessionsDir?: string;
}

/** Open an agent directory as a live service: one handler, mounted wherever you serve. */
export async function createAgentService(dir: string, options: CreateAgentServiceOptions = {}): Promise<AgentService> {
  const opened = await createPiAgentFromDir(dir, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.authPath !== undefined ? { authPath: options.authPath } : {}),
    ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
    serving: true, // a mounted service is long-running: the scheduler poller runs
  });
  return mountAgentService(opened, options);
}
