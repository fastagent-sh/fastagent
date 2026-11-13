/**
 * AgentCore container entry point: resolves deployment secrets on first invocation, claims leased-dotfile storage,
 * and serves `POST /invocations` + `GET /ping`.
 */
import type { StartOptions, StartedService } from "../../cli/commands/start.ts";
import { prepareStartWorkspace, openPreparedStartService } from "../../cli/commands/start.ts";
import { bindLine, serve } from "../../cli/serve.ts";
import { log } from "../../log.ts";
import { parsePort } from "../../cli/shared.ts";
import { applyRuntimeSecrets } from "./runtime-secrets.ts";
import { deferAgentcoreService, mountAgentcoreService } from "./service.ts";

async function prepareAgentcoreWorkspace(dirArg: string): Promise<string> {
  await applyRuntimeSecrets();
  return prepareStartWorkspace(dirArg);
}

export function runAgentcoreStart(
  dirArg: string,
  opts: StartOptions,
  net: { portFlag?: number; bindFlag?: string },
): void {
  const port = net.portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? 8080;
  const deferred = deferAgentcoreService({
    prepare: () => prepareAgentcoreWorkspace(dirArg),
    assemble: async (dir): Promise<StartedService> => {
      const service = await openPreparedStartService(dir, opts, {
        storage: "leased-dotfile",
        mount: mountAgentcoreService,
      });
      await service.ready;
      return service;
    },
  });
  serve(deferred, { port, host: net.bindFlag }, (bound) => {
    log.info(bindLine(net.bindFlag, bound));
    log.info("[fastagent] agentcore: the definition opens on the first invocation");
  });
}
