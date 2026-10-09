/** `createAgentService` — the product as one call, with pi supplying the harness. */
import { type AgentService, type MountAgentServiceOptions, mountAgentService } from "../../service.ts";
import type { CredentialSourceOptions } from "./auth.ts";
import { createPiAgentFromDir } from "./open.ts";

export interface CreateAgentServiceOptions extends MountAgentServiceOptions, CredentialSourceOptions {
  model?: string;
  sessionsDir?: string;
}

/** Open an agent directory as a live service: one handler, mounted wherever you serve. */
export async function createAgentService(dir: string, options: CreateAgentServiceOptions = {}): Promise<AgentService> {
  const opened = await createPiAgentFromDir(dir, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.authPath !== undefined ? { authPath: options.authPath } : {}),
    ...(options.credentialStore !== undefined ? { credentialStore: options.credentialStore } : {}),
    ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
    serving: true, // a mounted service is long-running: the scheduler poller runs
  });
  return mountAgentService(opened, options);
}
