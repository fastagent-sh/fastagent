/**
 * AgentCore container entry point: resolves deployment secrets on first invocation, claims leased-dotfile storage,
 * and serves `POST /invocations` + `GET /ping`.
 */
import { log } from "../../log.ts";
import type { ServableAgent, ServedAgent, Service } from "../../service.ts";
import { applyRuntimeSecrets } from "./runtime-secrets.ts";
import { deferAgentcoreService, mountAgentcoreService } from "./service.ts";

export interface AgentcoreStartHost {
  prepareWorkspace(): Promise<string>;
  openPrepared(
    dir: string,
    runtime: { storage: "leased-dotfile"; mount: (opened: ServableAgent) => Promise<ServedAgent> },
  ): Promise<ServedAgent>;
  serve(service: Service, options: { port: number; host?: string }, onListening: (port: number) => void): void;
  bindLine(host: string | undefined, port: number): string;
  parsePort(value: string | undefined, label: string, source: "flag" | "env"): number | undefined;
}

export function runAgentcoreStart(host: AgentcoreStartHost, net: { portFlag?: number; bindFlag?: string }): void {
  const port = net.portFlag ?? host.parsePort(process.env.PORT, "PORT env", "env") ?? 8080;
  const deferred = deferAgentcoreService({
    prepare: async () => {
      await applyRuntimeSecrets();
      return host.prepareWorkspace();
    },
    assemble: async (dir) => {
      const service = await host.openPrepared(dir, {
        storage: "leased-dotfile",
        mount: mountAgentcoreService,
      });
      await service.ready;
      return service;
    },
  });
  host.serve(deferred, { port, host: net.bindFlag }, (bound) => {
    log.info(host.bindLine(net.bindFlag, bound));
    log.info("[fastagent] agentcore: the definition opens on the first invocation");
  });
}
