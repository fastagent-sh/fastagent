/** `createAgentService` — the product as one call, with pi supplying the engine. */
import { type AgentService, type MountAgentServiceOptions, mountAgentService } from "../../service.ts";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createPiAgentFromDir } from "./open.ts";

export interface CreateAgentServiceOptions extends MountAgentServiceOptions {
  model?: string;
  authPath?: string;
  /** The caller's own credential store, in place of any file (see `createPiAgentFromDir`). */
  credentialStore?: CredentialStore;
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
