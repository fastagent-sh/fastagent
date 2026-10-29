/**
 * A conformance subject over HTTP: another subject's Agent served by the Agent API's HTTP server on a port of its own,
 * and called through `connectAgent`, so the suite checks both bindings against one agent.
 */
import type { Agent } from "../src/agent-api.ts";
import { serveHandler } from "../src/channels/serve.ts";
import { connectAgent } from "../src/http/client.ts";
import { type ApiHandler, type ApiOptions, apiHandler } from "../src/http/server.ts";
import type { AgentApiSubject } from "./agent-api-conformance.ts";

export const KEY = "conformance-key";

export interface Served {
  url: string;
  api: ApiHandler;
  close(): Promise<void>;
}

/** `agent` served over HTTP on a port of its own; `heard` sees each request as it arrives. */
export async function served(
  agent: Agent,
  options: Partial<ApiOptions> & { heard?: (request: Request) => void } = {},
): Promise<Served> {
  const { heard, ...apiOptions } = options;
  const api = apiHandler(agent, { keys: [KEY], ...apiOptions });
  const server = serveHandler(
    (request) => {
      heard?.(request);
      return api.fetch(request);
    },
    { port: 0, host: "127.0.0.1" },
  );
  const port = await server.listening;
  return {
    url: `http://127.0.0.1:${port}`,
    api,
    async close() {
      await api.endStreams();
      await server.close();
      await api.dispose();
    },
  };
}

export function httpSubject(inner: AgentApiSubject): AgentApiSubject {
  let current: Served | undefined;
  const down = async () => {
    await current?.close();
    current = undefined;
  };
  const serve = async (agent: Agent) => {
    current = await served(agent);
    return connectAgent(current.url, { apiKey: KEY });
  };
  return {
    ...inner,
    keysSends: true,
    async start(options) {
      await down();
      return serve(await inner.start(options));
    },
    async restart(options) {
      await down();
      return serve(await inner.restart(options));
    },
    async stop() {
      await down();
      await inner.stop();
    },
  };
}
