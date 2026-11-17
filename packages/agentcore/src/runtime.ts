/**
 * An agent as an AgentCore runtime. AgentCore gives each session a microVM of its own, and a session is one instance:
 * named by its session id, which AgentCore puts on every invocation and `connectAgentCore` on every request through the
 * session's endpoint, and kept in the database, so a microVM holds nothing that must survive. The first request opens the
 * instance; a request naming another session is refused, since this microVM is that one's.
 *
 * The Agent API is served as it is everywhere, behind a key this process makes and adds to each request it forwards:
 * what reaches the container came through AgentCore, which authenticated it (IAM or JWT), so a second credential would
 * only be one more for a Caller to hold.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer } from "effect/http";
import { type ErrorCode, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { statusOf } from "@fastagent-sh/client/http/contract";
import {
  type AgentDefinition,
  type LocalAgent,
  type OpenAgentOptions,
  type PostgresDatabase,
  type Service,
  openAgent,
} from "@fastagent-sh/fastagent";

/** The header naming a request's session: AgentCore's own, on what it invokes. */
export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

/** AgentCore's HTTP protocol: the port its invocations, `/ping` and a session's endpoint reach. */
const PORT = 8080;

export interface AgentCoreOptions extends Pick<OpenAgentOptions, "secrets" | "env" | "model" | "offline"> {
  /** Where the instances are: on AWS, `dsqlDatabase(...)`. */
  database: PostgresDatabase;
  /** The agent's working directory, on the microVM's disk: gone with it. Default `/tmp/fastagent`. */
  root?: string;
}

interface Opened {
  agent: LocalAgent;
  service: Service;
  key: string;
}

const refusal = (code: ErrorCode, message: string) => {
  const error = agentError(code, message);
  return Response.json(
    { error: errorData(error) },
    { status: statusOf(errorData(error)), headers: code === "unavailable" ? { "retry-after": "1" } : {} },
  );
};

/** What the container answers, as a Fetch handler: `/ping`, `POST /invocations`, and the instance's own service. */
export function agentCoreHandler(definition: AgentDefinition, options: AgentCoreOptions) {
  const { database, root = "/tmp/fastagent", ...given } = options;
  let instance: { name: string; opened: Promise<Opened> } | undefined;
  let ready: Opened | undefined;

  const open = async (name: string): Promise<Opened> => {
    const agent = await openAgent(definition, { ...given, root, name, database });
    try {
      const key = randomBytes(32).toString("base64url");
      const service = await agent.serve({ apiKeys: [key] });
      ready = { agent, service, key };
      return ready;
    } catch (error) {
      await agent.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/ping") return Response.json({ status: ready?.agent.busy() ? "HealthyBusy" : "Healthy" });
      const name = request.headers.get(SESSION_HEADER);
      if (!name) return refusal("invalid_request", `a request names its AgentCore session in ${SESSION_HEADER}`);
      if (instance !== undefined && instance.name !== name) {
        return refusal("invalid_request", `this AgentCore session is the instance "${instance.name}", not "${name}"`);
      }
      instance ??= { name, opened: open(name) };
      const current = instance;
      let opened: Opened;
      try {
        opened = await current.opened;
      } catch (error) {
        // The next request opens it again: what failed (a lease another microVM still holds) may have passed by then.
        if (instance === current) instance = undefined;
        console.error(`[fastagent] the instance "${name}" did not open: ${String(error)}`);
        return refusal("unavailable", `the instance "${name}" did not open: ${(error as Error)?.message ?? error}`);
      }
      if (path === "/invocations" && request.method === "POST") return invocation(request, name);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${opened.key}`);
      return opened.service.fetch(new Request(request, { headers }));
    },
    /** Stop serving, then release the instance. */
    async close(): Promise<void> {
      const opened = await instance?.opened.catch(() => undefined);
      await opened?.agent.close();
    },
  };
}

/** An invocation opens the session's instance, which is all a bare one (`{}`) asks: `connectAgentCore` binds with it. */
async function invocation(request: Request, name: string): Promise<Response> {
  const text = await request.text();
  let body: unknown;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    return refusal("invalid_request", "an invocation is a JSON object");
  }
  if (typeof body !== "object" || body === null || Object.keys(body).length > 0) {
    return refusal("invalid_request", `an invocation is {}, and this one is ${text.slice(0, 80)}`);
  }
  return Response.json({ instance: name });
}

/** Serve `definition` as an AgentCore runtime, on AgentCore's port. Answers how to stop it. */
export async function serveAgentCore(
  definition: AgentDefinition,
  options: AgentCoreOptions,
): Promise<{ close(): Promise<void> }> {
  const handler = agentCoreHandler(definition, options);
  const scope = Scope.makeUnsafe();
  const server = NodeHttpServer.layer(() => createServer(), {
    port: PORT,
    host: "0.0.0.0",
    gracefulShutdownTimeout: "500 millis",
  });
  const app = Effect.interruptible(HttpEffect.fromWebHandler(handler.fetch));
  await Effect.runPromise(Layer.buildWithScope(HttpServer.serve(app).pipe(Layer.provideMerge(server)), scope));
  console.error(`[fastagent] serving AgentCore on port ${PORT}`);
  return {
    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await handler.close();
    },
  };
}
