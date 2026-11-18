/**
 * An agent as an AgentCore runtime. AgentCore gives each session a microVM of its own, and a session is one instance:
 * named by the session id AgentCore puts on every invocation, and kept in the database, so a microVM holds nothing that
 * must survive. The first invocation opens the instance; one naming another session is refused, since this microVM is
 * that one's.
 *
 * The Agent API is served as it is everywhere, behind a key this process makes and adds to each request it unwraps:
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
import { Unavailable } from "@fastagent-sh/fastagent/platform";
import { type EnvelopedRequest, envelopeResponse, isEventStream } from "./envelope.ts";

/** The header AgentCore names an invocation's session in. */
export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

/** AgentCore's HTTP protocol: the port its invocations and `/ping` reach. */
const PORT = 8080;

export interface AgentCoreOptions extends Pick<OpenAgentOptions, "secrets" | "env" | "model" | "offline"> {
  /**
   * Where the instances are: on AWS, `dsqlDatabase(...)`. Or how to find it as an instance opens, so a runtime without
   * one says so to every invocation rather than exiting where only its log tells.
   */
  database: PostgresDatabase | (() => PostgresDatabase);
  /** The agent's working directory, on the microVM's disk: gone with it. Default `/tmp/fastagent`. */
  root?: string;
  /**
   * The agent's values read where they are kept (its Secrets Manager secret), over `secrets`: read as the instance
   * opens, so one that cannot be read is said to the invocation, and one fixed after the deploy is read at the next.
   */
  values?: () => Promise<Readonly<Record<string, string>>>;
}

interface Opened {
  agent: LocalAgent;
  service: Service;
  key: string;
}

/** A refusal as the Agent API answers it, inside the envelope AgentCore delivers whole. */
function refused(code: ErrorCode, message: string): Promise<Response> {
  const error = errorData(agentError(code, message));
  const answer = Response.json(
    { error },
    { status: statusOf(error), headers: code === "unavailable" ? { "retry-after": "1" } : {} },
  );
  return enveloped(answer);
}

async function enveloped(response: Response): Promise<Response> {
  // An event stream goes out as it is written: AgentCore passes a 200 with its body through.
  if (response.status === 200 && isEventStream(response.headers.get("content-type"))) return response;
  return Response.json({ response: await envelopeResponse(response) });
}

function requestIn(body: unknown): EnvelopedRequest | undefined {
  const request = (body as { request?: Partial<EnvelopedRequest> } | null)?.request;
  if (typeof request?.method !== "string" || typeof request.path !== "string" || !request.path.startsWith("/")) {
    return undefined;
  }
  if (request.body !== undefined && typeof request.body !== "string") return undefined;
  return { method: request.method, path: request.path, headers: request.headers ?? {}, body: request.body };
}

/** What the container answers, as a Fetch handler: `/ping` and `POST /invocations`. */
export function agentCoreHandler(definition: AgentDefinition, options: AgentCoreOptions) {
  const { database, root = "/tmp/fastagent", values, ...given } = options;
  let instance: { name: string; opened: Promise<Opened> } | undefined;
  let ready: Opened | undefined;

  const open = async (name: string): Promise<Opened> => {
    const secrets = { ...given.secrets, ...(values === undefined ? {} : await values()) };
    const placed = typeof database === "function" ? database() : database;
    const agent = await openAgent(definition, { ...given, secrets, root, name, database: placed });
    let opened: Opened;
    try {
      const key = randomBytes(32).toString("base64url");
      opened = { agent, service: await agent.serve({ apiKeys: [key] }), key };
    } catch (error) {
      await agent.close().catch(() => undefined);
      throw error;
    }
    ready = opened;
    // Its runs stopped under it (the lease went to another process, or went unrenewed): nothing answers in it any
    // more, and while requests arrive AgentCore keeps this microVM. The next invocation opens the instance again.
    const reopen = () => {
      if (ready !== opened) return;
      ready = undefined;
      instance = undefined;
      agent.close().catch((error: unknown) => console.error(`[fastagent] closing "${name}" failed: ${String(error)}`));
    };
    agent.harness.closed.then(reopen, reopen);
    return opened;
  };

  const invocation = async (request: Request): Promise<Response> => {
    const name = request.headers.get(SESSION_HEADER);
    if (!name) return refused("invalid_request", `an invocation names its AgentCore session in ${SESSION_HEADER}`);
    if (instance !== undefined && instance.name !== name) {
      return refused("invalid_request", `this AgentCore session is the instance "${instance.name}", not "${name}"`);
    }
    const asked = requestIn(await request.json().catch(() => undefined));
    if (asked === undefined) {
      return refused("invalid_request", "an invocation is { request: { method, path, headers, body } }");
    }
    instance ??= { name, opened: open(name) };
    const current = instance;
    let opened: Opened;
    try {
      opened = await current.opened;
    } catch (error) {
      // The next invocation opens it again: what failed (a lease another microVM still holds) may have passed by then.
      if (instance === current) instance = undefined;
      console.error(`[fastagent] the instance "${name}" did not open: ${String(error)}`);
      // Retryable only when it passes by itself: one that needs a person (a value, a permission) is not retried for ever.
      const code = error instanceof Unavailable ? "unavailable" : "internal";
      return refused(code, `the instance "${name}" did not open: ${(error as Error)?.message ?? error}`);
    }
    const headers = new Headers(asked.headers);
    headers.set("authorization", `Bearer ${opened.key}`);
    const unwrapped = new Request(new URL(asked.path, "http://agent"), {
      method: asked.method,
      headers,
      signal: request.signal,
      ...(asked.body === undefined ? {} : { body: asked.body }),
    });
    return enveloped(await opened.service.fetch(unwrapped));
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/ping") return Response.json({ status: ready?.agent.busy() ? "HealthyBusy" : "Healthy" });
      if (path === "/invocations" && request.method === "POST") return invocation(request);
      return new Response("not found\n", { status: 404 });
    },
    /** Stop serving, then release the instance. */
    async close(): Promise<void> {
      const opened = await instance?.opened.catch(() => undefined);
      ready = undefined;
      await opened?.agent.close();
    },
  };
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
